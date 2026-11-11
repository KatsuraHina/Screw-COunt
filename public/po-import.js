// Parses a Backbone Steel purchase order PDF in the browser using pdf.js.
//
// A PO carries everything the Extra Deliveries checklist needs at the top of
// each page — the PO number, the delivery address and the job — and then a
// table of line items. Items are read from the table rows: a row that ends in
// "<qty> <unit> <unit cost> <ext cost>" starts an item, and the plain rows that
// follow it are that item's detail lines (cut lengths, beam marks and so on),
// which the factory needs to see on the checklist.

const PDFJS_VERSION = "4.4.168";
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return lib;
    });
  }
  return pdfjsPromise;
}

// Group text fragments that share roughly the same baseline into rows, ordered
// top-to-bottom then left-to-right. Each row keeps its fragments (with their x
// positions) so the right-hand column can be read apart from the left one.
function groupIntoRows(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  let current = null;

  sorted.forEach((item) => {
    if (!current || Math.abs(current.y - item.y) > 3) {
      current = { y: item.y, items: [item] };
      rows.push(current);
    } else {
      current.items.push(item);
    }
  });

  rows.forEach((row) => row.items.sort((a, b) => a.x - b.x));
  return rows;
}

function rowText(row) {
  return row.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
}

// Units seen on these orders. Kept to a known list so a word in a description
// can't be mistaken for the unit column.
const UNITS = ["LG", "EA", "M", "LM", "NO", "PK", "SET", "ROLL", "BOX", "PR", "KG", "SHT"];
const ITEM_ROW = new RegExp(
  `^(.*?)\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNITS.join("|")})\\s+([\\d,]+\\.\\d{2})\\s+([\\d,]+\\.\\d{2})$`
);

// Boilerplate that sits in the table band but isn't part of an item.
const NOISE = [
  /^ITEM INFORMATION$/i,
  /^DESCRIPTION\b/i,
  /^\*{3}\s*Continued/i,
  /^Backbone Steel$/i,
  /^ABN:/i,
  /^Page \d+ of \d+$/i,
  /^Purchase Order No:/i,
  /^Invoices with the incorrect/i,
  /^To:/i,
  /^PO BOX/i,
  /^Ph:/i,
  /^Email:/i,
  /^Order Date:/i,
  /^Due Date:/i,
  /^Delivery:/i,
  /^Reference:/i,
  /^All Delivery drivers/i,
  /^(Total|GST|Grand Total):/i,
  /^Enquiries to:/i,
  /^Scheduler:/i,
  /^Telephone:/i,
  /^Job:/i,
  /^Client:/i,
  /^Tangent Nominees/i,
  /^\d+ MCCOY STREET/i,
  /^TEL:/i,
  /^Please note:/i,
  /^Purchase Order Subject/i,
  /^MYAREE\b/i,
  /^[A-Z]{2,3}\s*\d{4}$/
];

function isNoise(text) {
  return !text || NOISE.some((pattern) => pattern.test(text));
}

function cleanNumber(value) {
  return Number(String(value).replace(/,/g, ""));
}

// Pull a labelled value from the page, e.g. "Order Date: 3/11/2026". Rows span
// both columns, so "Scheduler: Daryl Martin Client: FORMA HOMES" would otherwise
// hand back the next column too — the value stops at the next "Label:".
function findLabelled(rows, label) {
  const pattern = new RegExp(`${label}\\s*:?\\s*(.+)$`, "i");
  for (const row of rows) {
    const match = rowText(row).match(pattern);
    if (match && match[1].trim()) {
      return match[1].split(/\s+[A-Z][A-Za-z]{2,19}:\s/)[0].trim();
    }
  }
  return "";
}

// The delivery address sits in the right-hand column and runs over several
// rows, so it is read by x position rather than by text: everything from the
// "Delivery:" label's value column down until the address's state/postcode line
// closes it off.
function findDeliveryBlock(rows) {
  const lines = [];
  let valueX = null;

  for (const row of rows) {
    if (valueX === null) {
      const label = row.items.find((item) => /^Delivery\s*:?/i.test(item.str));
      if (!label) {
        continue;
      }
      const after = row.items.filter((item) => item.x > label.x + 1);
      if (after.length === 0) {
        continue;
      }
      valueX = after[0].x - 2;
      lines.push(after.map((item) => item.str).join(" ").trim());
      continue;
    }

    const right = row.items.filter((item) => item.x >= valueX);
    if (right.length === 0) {
      continue;
    }
    const text = right.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
    if (!text || /^(Reference|Ph|Fax|Email)\s*:/i.test(text)) {
      break;
    }
    lines.push(text);
    // An Australian state + postcode closes the address.
    if (/\b(WA|NSW|VIC|QLD|SA|TAS|NT|ACT)\s+\d{4}$/i.test(text)) {
      break;
    }
    if (lines.length >= 5) {
      break;
    }
  }

  return lines.filter(Boolean);
}

// "Lot No 407 St No 3 / BUSHLARK STREET / EGLINTON WA 6034" ->
// address "Lot No 407 St No 3, BUSHLARK STREET", suburb "EGLINTON".
export function splitDeliveryLines(lines) {
  const all = (lines || []).map((line) => String(line).trim()).filter(Boolean);
  if (all.length === 0) {
    return { address: "", suburb: "", state: "", postcode: "" };
  }

  const last = all[all.length - 1];
  const match = last.match(/^(.*?)\s*\b(WA|NSW|VIC|QLD|SA|TAS|NT|ACT)\s+(\d{4})$/i);
  if (!match) {
    return { address: all.join(", "), suburb: "", state: "", postcode: "" };
  }

  return {
    address: all.slice(0, -1).join(", "),
    suburb: match[1].trim(),
    state: match[2].toUpperCase(),
    postcode: match[3]
  };
}

// "BS513769" / "513769/720/01" -> "513769", the number the checklist wants.
export function deriveJobNumberFromPo(job, poNumber) {
  const fromJob = String(job ?? "").match(/(\d{4,})/);
  if (fromJob) {
    return fromJob[1];
  }
  const fromPo = String(poNumber ?? "").match(/(\d{4,})/);
  return fromPo ? fromPo[1] : "";
}

export function parsePoRows(rows) {
  const items = [];
  let started = false;

  rows.forEach((row) => {
    const text = rowText(row);
    // Every page repeats the order header. Closing the table at each one stops
    // the next page's address block being read as the last item's detail lines.
    if (/^Purchase Order No:/i.test(text)) {
      started = false;
      return;
    }
    if (/^DESCRIPTION\b/i.test(text)) {
      started = true;
      return;
    }
    if (!started || isNoise(text)) {
      return;
    }

    const match = text.match(ITEM_ROW);
    if (match) {
      items.push({
        description: match[1].trim(),
        details: [],
        quantity: cleanNumber(match[2]),
        unit: match[3],
        unitCost: cleanNumber(match[4]),
        extCost: cleanNumber(match[5])
      });
      return;
    }

    // A plain row under an item describes it (cut lengths, beam marks, …).
    if (items.length > 0) {
      items[items.length - 1].details.push(text);
    }
  });

  return items;
}

export async function parsePurchaseOrder(file) {
  const pdfjsLib = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  let allRows = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const fragments = content.items
      .filter((item) => item.str && item.str.trim() !== "")
      .map((item) => ({ str: item.str.trim(), x: item.transform[4], y: item.transform[5] }));
    allRows = allRows.concat(groupIntoRows(fragments));
  }

  const poNumber = findLabelled(allRows, "Purchase Order No");
  if (!poNumber) {
    throw new Error(`${file.name}: couldn't find a Purchase Order number — is this a PO?`);
  }

  const delivery = splitDeliveryLines(findDeliveryBlock(allRows));
  const items = parsePoRows(allRows);
  if (items.length === 0) {
    throw new Error(`${file.name}: found the PO ${poNumber} but no line items.`);
  }

  return {
    poNumber,
    orderDate: findLabelled(allRows, "Order Date"),
    reference: findLabelled(allRows, "Reference"),
    client: findLabelled(allRows, "Client"),
    // The PO's Scheduler is deliberately not read. It is not the site
    // supervisor, so it must never end up in the checklist's Supervisor
    // Contact — that one is filled in by hand.
    jobNumber: deriveJobNumberFromPo(findLabelled(allRows, "Job"), poNumber),
    address: delivery.address,
    suburb: delivery.suburb,
    state: delivery.state,
    postcode: delivery.postcode,
    items
  };
}
