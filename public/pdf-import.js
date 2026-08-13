// Parses a truss cutting-list PDF in the browser using pdf.js. It looks for the
// table header containing "No.", "Number" and "Lineal M", then reads each data
// row's row number, truss number and lineal metres.

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

// Group text items that share roughly the same vertical position into rows,
// ordered top-to-bottom and left-to-right.
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
  return row.items
    .map((item) => item.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHeaderRow(text) {
  return /no\./i.test(text) && /number/i.test(text) && /lineal/i.test(text);
}

// Job titles are reliable markers: wall packs always carry "PACK" (PACK3,
// PACK100, ...) and truss jobs always carry "TRUSS". PACK is checked first (a
// wall pack from a company called "…Trusses" would otherwise match TRUSS too).
export function detectJobTypeFromText(text) {
  if (/PACK/i.test(text)) {
    return "walls";
  }
  if (/TRUSS/i.test(text)) {
    return "trusses";
  }
  return null;
}

// The strongest signal is the item numbers themselves: wall panels are
// W-prefixed (W065) and trusses are T-prefixed (T017). Whichever prefix
// dominates the parsed rows decides the type — this is read from the actual cut
// list, so it doesn't depend on where the PACK/TRUSS wording lands on the page.
export function detectJobTypeFromRows(rows) {
  let walls = 0;
  let trusses = 0;
  (rows || []).forEach((row) => {
    const first = String(row?.number ?? "").trim().charAt(0).toUpperCase();
    if (first === "W") {
      walls += 1;
    } else if (first === "T") {
      trusses += 1;
    }
  });
  if (walls > trusses) {
    return "walls";
  }
  if (trusses > walls) {
    return "trusses";
  }
  return null;
}

export function detectJobTypeFromName(fileName) {
  return detectJobTypeFromText(String(fileName ?? ""));
}

// The label a preloaded job shows in the list — the PDF's own file name, with
// the ".pdf" extension and surrounding whitespace stripped.
export function deriveImportTitle(fileName) {
  const trimmed = String(fileName ?? "").trim().replace(/\.pdf$/i, "").trim();
  return trimmed || "Imported list";
}

// A data row looks like: <No.> <Number> <Lineal M> <W> <No. of Screws> <P> ...
// e.g. "1 T017 37.34 32.58 115 0" or "1 W065 60.43 52.99 140 1".
function parseDataRow(text) {
  const match = text.match(/^(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)/);
  if (!match) {
    return null;
  }

  const no = Number.parseInt(match[1], 10);
  const number = match[2];
  const metres = Number.parseFloat(match[3]);
  const screws = Number.parseInt(match[5], 10);

  if (!Number.isInteger(no)) {
    return null;
  }

  // The truss/panel number should contain a digit (e.g. "T017"); skip stray rows.
  if (!/\d/.test(number) || number.length > 16) {
    return null;
  }

  if (!(metres > 0) && !(screws > 0)) {
    return null;
  }

  return { no, number, metres, screws };
}

export async function parseCutListPdf(file) {
  const pdfjsLib = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const trusses = [];
  // Every row's text, so PACK/TRUSS is found wherever it sits on the page (some
  // wall PDFs put the pack name below the header, so a title-only scan missed it).
  const allTexts = [];
  let headerSeen = false;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => item.str && item.str.trim() !== "")
      .map((item) => ({
        str: item.str.trim(),
        x: item.transform[4],
        y: item.transform[5]
      }));

    const rows = groupIntoRows(items);

    rows.forEach((row) => {
      const text = rowText(row);
      allTexts.push(text);

      if (isHeaderRow(text)) {
        headerSeen = true;
        return;
      }

      if (!headerSeen) {
        return;
      }

      const record = parseDataRow(text);
      if (record) {
        trusses.push(record);
      }
    });
  }

  if (!headerSeen) {
    throw new Error("Could not find a truss table (No. / Number / Lineal M) in this PDF.");
  }

  trusses.sort((a, b) => a.no - b.no);
  // Prefer the item-number prefixes (W/T — read from the data), falling back to
  // the PACK/TRUSS wording anywhere in the PDF.
  const jobType = detectJobTypeFromRows(trusses) || detectJobTypeFromText(allTexts.join(" "));
  return { rows: trusses, jobType };
}
