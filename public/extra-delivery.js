// Extra Delivery Maker.
//
// Upload the job's purchase orders, and their line items become an editable
// sheet. Tick what is actually going on the truck and the Extra Deliveries
// checklist fills itself in — address, suburb, job number and the item list —
// ready to print or email. Everything stays editable: a PO is the starting
// point, not the last word.

import { parsePurchaseOrder } from "./po-import.js";

// Where the finished checklist goes. Timothy replaced Dylan on the Cc line.
export const CHECKLIST_TO = "Stuartr@backbonesteel.com.au";
export const CHECKLIST_CC = [
  "Andreah@backbonesteel.com.au",
  "timothym@backbonesteel.com.au",
  "Jesusr@backbonesteel.com.au",
  "ConorF@backbonesteel.com.au"
];

const STORE_PREFIX = "screwcount.extraDelivery.";

let elements = {};
let userKey = "anon";

// The places a job gets delivered to, and who picks the work up. Both are
// chosen from a list so the spreadsheet column stays consistent.
export const REGIONS = ["EAST", "WEST", "NOR", "SOR"];
export const ACTION_AREAS = ["Weld bay", "Steel bay", "TL"];
export const SHIFTS = ["Night shift", "Morning shift", "Afternoon shift"];

// Load specifications and the truck boxes are deliberately absent here: the
// form carries them so they can be written on the printed sheet, and the app
// never asks anyone to type them.
const emptyDelivery = () => ({
  address: "",
  suburb: "",
  jobNumber: "",
  supervisorContact: "",
  actionedBy: "",
  // For the spreadsheet row and the shortage email.
  region: "",
  deliveryDate: "",
  toBeActionedBy: [],
  trafficLight: "",
  reason: "",
  racksChecked: true,
  substitutionConsidered: true,
  superNotified: true,
  trafficLightsUpdated: true,
  yourName: "",
  shift: SHIFTS[0],
  // [{ id, poNumber, orderDate, items: [{ id, description, details, quantity, unit, include }] }]
  pos: []
});

let delivery = emptyDelivery();

function storeKey() {
  return `${STORE_PREFIX}${userKey}`;
}

function persist() {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(delivery));
  } catch {
    // Storage unavailable (private mode etc.) — it just won't survive a reload.
  }
}

function restore() {
  delivery = emptyDelivery();
  try {
    const raw = localStorage.getItem(storeKey());
    if (raw) {
      const stored = JSON.parse(raw);
      if (stored && typeof stored === "object") {
        delivery = { ...emptyDelivery(), ...stored, pos: Array.isArray(stored.pos) ? stored.pos : [] };
      }
    }
  } catch {
    delivery = emptyDelivery();
  }
}

// Imports are per signed-in user, like the rest of the app's local state.
export function setExtraDeliveryUser(uid) {
  const next = uid || "anon";
  if (next === userKey) {
    return;
  }
  userKey = next;
  restore();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Quantities read back from a PO are plain numbers; show 1.7 but not 10.000.
function formatQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return String(value ?? "");
  }
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

function setStatus(message, tone = "hint") {
  elements.poStatus.textContent = message;
  elements.poStatus.className =
    tone === "warning" || tone === "success" ? `hint ${tone}` : "hint";
}

let idSeed = 0;
function nextId(prefix) {
  idSeed += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeed}`;
}

// --- Importing -------------------------------------------------------------

async function handlePoFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file);
  if (files.length === 0) {
    return;
  }

  setStatus(`Reading ${files.length} PO${files.length === 1 ? "" : "s"}…`);
  const added = [];
  const failed = [];

  for (const file of files) {
    try {
      const po = await parsePurchaseOrder(file);
      if (delivery.pos.some((entry) => entry.poNumber === po.poNumber)) {
        failed.push(`${po.poNumber} is already on this delivery`);
        continue;
      }
      delivery.pos.push({
        id: nextId("po"),
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        client: po.client,
        reference: po.reference,
        items: po.items.map((item) => ({
          id: nextId("item"),
          description: item.description,
          details: item.details.join(" · "),
          quantity: formatQuantity(item.quantity),
          unit: item.unit,
          // Everything comes in ticked — this is the auto-fill. Untick whatever
          // isn't going on this run.
          include: true
        }))
      });
      added.push(po);
    } catch (error) {
      console.error(error);
      failed.push(error.message || `${file.name}: couldn't be read`);
    }
  }

  // The first PO in sets the delivery details; later ones only fill blanks, so
  // anything already typed by hand is never overwritten.
  added.forEach((po) => {
    if (!delivery.address) delivery.address = po.address;
    if (!delivery.suburb) delivery.suburb = po.suburb;
    if (!delivery.jobNumber) delivery.jobNumber = po.jobNumber;
  });

  const differing = added.filter(
    (po) => po.jobNumber && delivery.jobNumber && po.jobNumber !== delivery.jobNumber
  );

  persist();
  renderExtraDelivery();

  const parts = [];
  if (added.length > 0) {
    const items = added.reduce((sum, po) => sum + po.items.length, 0);
    parts.push(`Added ${added.length} PO${added.length === 1 ? "" : "s"} · ${items} items.`);
  }
  if (differing.length > 0) {
    parts.push(
      `Heads up: ${differing.map((po) => po.poNumber).join(", ")} ${
        differing.length === 1 ? "is" : "are"
      } for a different job number.`
    );
  }
  if (failed.length > 0) {
    parts.push(failed.join(" "));
  }
  setStatus(parts.join(" "), failed.length > 0 || differing.length > 0 ? "warning" : "success");
}

function removePo(id) {
  delivery.pos = delivery.pos.filter((po) => po.id !== id);
  persist();
  renderExtraDelivery();
}

function setAllIncluded(poId, include) {
  const po = delivery.pos.find((entry) => entry.id === poId);
  if (!po) {
    return;
  }
  po.items.forEach((item) => {
    item.include = include;
  });
  persist();
  renderExtraDelivery();
}

// --- The items that end up on the checklist ---------------------------------

export function includedItems() {
  return delivery.pos.flatMap((po) =>
    po.items
      .filter((item) => item.include)
      .map((item) => ({ ...item, poNumber: po.poNumber }))
  );
}

// --- Rendering --------------------------------------------------------------

function renderPoSheet() {
  const sheet = elements.poSheet;
  sheet.innerHTML = "";

  if (delivery.pos.length === 0) {
    sheet.innerHTML = `<p class="entry-empty">No POs added yet. Upload one to start the checklist.</p>`;
    return;
  }

  delivery.pos.forEach((po) => {
    const card = document.createElement("section");
    card.className = "po-card";

    const head = document.createElement("div");
    head.className = "po-card-head";
    const picked = po.items.filter((item) => item.include).length;
    head.innerHTML =
      `<div class="po-card-title">` +
      `<strong>PO ${escapeHtml(po.poNumber)}</strong>` +
      `<span class="po-card-meta">${escapeHtml(po.orderDate || "")}${
        po.reference ? ` · ${escapeHtml(po.reference)}` : ""
      } · ${picked} of ${po.items.length} on this delivery</span>` +
      `</div>`;

    const actions = document.createElement("div");
    actions.className = "po-card-actions";
    const allOn = picked === po.items.length && po.items.length > 0;
    const toggleAll = document.createElement("button");
    toggleAll.type = "button";
    toggleAll.className = "entry-action";
    toggleAll.textContent = allOn ? "Untick all" : "Tick all";
    toggleAll.addEventListener("click", () => setAllIncluded(po.id, !allOn));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "entry-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removePo(po.id));
    actions.append(toggleAll, remove);
    head.appendChild(actions);
    card.appendChild(head);

    const list = document.createElement("ul");
    list.className = "po-item-list";

    po.items.forEach((item) => {
      const row = document.createElement("li");
      row.className = item.include ? "po-item" : "po-item is-excluded";

      const tick = document.createElement("input");
      tick.type = "checkbox";
      tick.checked = Boolean(item.include);
      tick.setAttribute("aria-label", `Include ${item.description}`);
      tick.addEventListener("change", () => {
        item.include = tick.checked;
        persist();
        renderExtraDelivery();
      });

      const desc = document.createElement("div");
      desc.className = "po-item-body";

      const name = document.createElement("input");
      name.type = "text";
      name.className = "po-item-desc";
      name.value = item.description;
      name.addEventListener("input", () => {
        item.description = name.value;
        persist();
        renderChecklist();
      });

      const details = document.createElement("input");
      details.type = "text";
      details.className = "po-item-details";
      details.value = item.details || "";
      details.placeholder = "Cut lengths / notes";
      details.addEventListener("input", () => {
        item.details = details.value;
        persist();
        renderChecklist();
      });

      desc.append(name, details);

      const qty = document.createElement("input");
      qty.type = "text";
      qty.inputMode = "decimal";
      qty.className = "po-item-qty";
      qty.value = item.quantity;
      qty.addEventListener("input", () => {
        item.quantity = qty.value;
        persist();
        renderChecklist();
      });

      const unit = document.createElement("span");
      unit.className = "po-item-unit";
      unit.textContent = item.unit || "";

      row.append(tick, desc, qty, unit);
      list.appendChild(row);
    });

    card.appendChild(list);
    sheet.appendChild(card);
  });
}

function renderFields() {
  const f = elements;
  f.deliveryAddress.value = delivery.address;
  f.deliverySuburb.value = delivery.suburb;
  f.deliveryJobNumber.value = delivery.jobNumber;
  f.deliverySupervisor.value = delivery.supervisorContact;
  f.deliveryActionedBy.value = delivery.actionedBy;
  f.deliveryRegion.value = delivery.region;
  f.deliveryDate.value = delivery.deliveryDate;
  f.deliveryTrafficLight.value = delivery.trafficLight;
  f.deliveryReason.value = delivery.reason;
  f.deliveryYourName.value = delivery.yourName;
  f.deliveryShift.value = delivery.shift;
  f.racksChecked.checked = delivery.racksChecked;
  f.substitutionConsidered.checked = delivery.substitutionConsidered;
  f.superNotified.checked = delivery.superNotified;
  f.trafficLightsUpdated.checked = delivery.trafficLightsUpdated;
  f.actionAreaInputs.forEach((input) => {
    input.checked = delivery.toBeActionedBy.includes(input.value);
  });
}

// What each cell of the row is, left to right. Two of these columns have no
// header in the sheet itself; they're named here so the row can be checked
// against it before pasting.
const ROW_COLUMNS = [
  "DATE",
  "AREA",
  "MANIFEST MADE",
  "ADDRESS",
  "SUBURB",
  "JOB NUMBER",
  "SUPERVISOR",
  "ITEMS",
  "TO BE ACTIONED BY",
  "TRAFFIC LIGHT"
];

// The two copy-outs are shown as they will be pasted, so what you see is what
// lands in the sheet or the email. The row stays on one line — it is one row —
// and scrolls sideways rather than wrapping into something that looks like two.
function renderOutputs() {
  const cells = spreadsheetRow();
  elements.rowPreview.innerHTML =
    `<table class="row-table"><tr>` +
    ROW_COLUMNS.map((name) => `<th>${escapeHtml(name)}</th>`).join("") +
    `</tr><tr>` +
    cells.map((cell) => `<td>${escapeHtml(cell) || "&nbsp;"}</td>`).join("") +
    `</tr></table>`;
  elements.emailPreview.textContent = shortageEmailText();
}

// The paper form holds nine item rows, so that is a sheet's worth when the
// items are one-liners. They often aren't — a truss can carry half a dozen cut
// lengths — so the real limit is how much fits on the page, measured below.
// A delivery that needs more becomes several whole sheets rather than one long
// one: each is a complete, signable copy of the form carrying its own share of
// the items, with the outstanding ones on the next sheet.
const ITEMS_PER_SHEET = 9;

// A4 at the 12mm margin the print stylesheet sets, in CSS pixels. Sheets are
// measured at the printed width, not the on-screen one: the page is narrower,
// so descriptions wrap further and rows run taller than they look on screen.
const MM_PX = 96 / 25.4;
const PAGE_HEIGHT = (297 - 24) * MM_PX;
const PAGE_WIDTH = (210 - 24) * MM_PX;
// A hair of slack so a row that lands exactly on the boundary doesn't tip over.
const PAGE_SLACK = 12;

// Load specifications and the two trucks are filled in by hand on the printed
// sheet, so they are rendered as the blank boxes the form has — the app never
// asks for them.
function specBlock(title, labels) {
  return (
    `<div class="cl-block">` +
    `<div class="cl-block-head">${escapeHtml(title)}</div>` +
    labels
      .map((label) => `<div class="cl-block-row"><span>${escapeHtml(label)}</span><span></span></div>`)
      .join("") +
    `</div>`
  );
}

const COLS =
  `<colgroup>` +
  `<col style="width:26.3%"><col style="width:29.4%"><col style="width:13.9%">` +
  `<col style="width:9.9%"><col style="width:9.1%"><col style="width:11.4%">` +
  `</colgroup>`;

// Split the delivery's items into sheet-sized runs. An empty delivery still
// gets one blank sheet, so the form is on screen before anything is uploaded.
// `fits` decides whether a run of rows still fits a page; without it (no DOM to
// measure against) it falls back to the form's nine rows.
export function splitIntoSheets(items, fits = null) {
  if (items.length === 0) {
    return [[]];
  }
  if (!fits) {
    const sheets = [];
    for (let i = 0; i < items.length; i += ITEMS_PER_SHEET) {
      sheets.push(items.slice(i, i + ITEMS_PER_SHEET));
    }
    return sheets;
  }

  const sheets = [];
  let current = [];
  items.forEach((item, index) => {
    const candidate = current.concat(index);
    // Always keep at least one item per sheet, even a monster that overruns on
    // its own — better one overlong sheet than an endless empty loop.
    if (current.length > 0 && !fits(candidate)) {
      sheets.push(current);
      current = [index];
    } else {
      current = candidate;
    }
  });
  if (current.length > 0) {
    sheets.push(current);
  }
  return sheets.map((run) => run.map((i) => items[i]));
}

// Measure the real thing: build one hidden sheet at the printed page width and
// read back the height of its chrome and of each item row. Those numbers decide
// how many items a sheet can hold, so a sheet is always one piece of paper.
function measureSheet(items) {
  const probe = document.createElement("div");
  probe.style.cssText =
    `position:absolute;left:-10000px;top:0;visibility:hidden;width:${PAGE_WIDTH}px;`;
  probe.className = "checklist-sheet";
  // Rendered with every item, and with the page mark, which is the taller case.
  probe.innerHTML = renderSheet(items, 1, 2, { padTo: 0 });
  elements.checklistSheet.parentNode.appendChild(probe);

  const page = probe.querySelector(".cl-page");
  const rows = [...probe.querySelectorAll(".cl-table-items tbody tr")];
  const rowHeights = rows.map((row) => row.getBoundingClientRect().height);
  const total = rowHeights.reduce((sum, h) => sum + h, 0);
  // Everything that isn't an item row: logo, title, job block, table header,
  // signatures, the four boxes and the email block.
  const chrome = page.getBoundingClientRect().height - total;
  // A blank padding row, for filling a short sheet back out to the form's look.
  const blankRow = rowHeights.length > 0 ? Math.min(...rowHeights) : 26;

  probe.remove();
  return { rowHeights, chrome, blankRow };
}

// One complete copy of the form, holding this sheet's items. `padTo` is how
// many rows the item table should have in total — the form's nine when there's
// room, fewer when the items themselves have filled the page.
function renderSheet(items, pageNo, pageCount, { padTo = ITEMS_PER_SHEET } = {}) {
  const itemRows = items
    .map(
      (item) =>
        `<tr>` +
        `<td class="cl-item" colspan="2">${escapeHtml(item.description)}` +
        (item.details ? `<span class="cl-item-detail">${escapeHtml(item.details)}</span>` : "") +
        `</td>` +
        `<td class="cl-qty">${escapeHtml(item.quantity)} ${escapeHtml(item.unit || "")}</td>` +
        `<td></td><td></td><td></td>` +
        `</tr>`
    )
    .join("");

  // A short sheet is padded back out to the form's row count, so it doesn't
  // look cut off — but never past what the page can hold.
  const blankRows = Array.from(
    { length: Math.max(0, padTo - items.length) },
    () => `<tr><td class="cl-item" colspan="2"></td><td></td><td></td><td></td><td></td></tr>`
  ).join("");

  // Only marked when there's more than one sheet: a single-sheet delivery is
  // the form exactly as it is on paper, with nothing added.
  const pageMark =
    pageCount > 1 ? `<span class="cl-page-mark">Page ${pageNo} of ${pageCount}</span>` : "";

  return (
    `<section class="cl-page">` +
    `<div class="cl-logo"><img src="./backbone-logo.png" alt="Backbone Steel" width="339" height="140"></div>` +
    `<h2 class="cl-title">Extra Deliveries checklist${pageMark}</h2>` +
    `<table class="cl-table">` +
    COLS +
    `<tr>` +
    `<th class="cl-head" colspan="2">ADDRESS</th>` +
    `<th class="cl-head" colspan="2">Suburb</th>` +
    `<th class="cl-head" colspan="2">Job number</th>` +
    `</tr>` +
    `<tr>` +
    `<td class="cl-value" colspan="2">${escapeHtml(delivery.address)}</td>` +
    `<td class="cl-value" colspan="2">${escapeHtml(delivery.suburb)}</td>` +
    `<td class="cl-value" colspan="2">${escapeHtml(delivery.jobNumber)}</td>` +
    `</tr>` +
    `<tr>` +
    `<th class="cl-head cl-head-left">Supervisor Contact</th>` +
    `<td class="cl-value">${escapeHtml(delivery.supervisorContact)}</td>` +
    `<th class="cl-head cl-head-left" colspan="2">Actioned by</th>` +
    `<td class="cl-value" colspan="2">${escapeHtml(delivery.actionedBy)}</td>` +
    `</tr>` +
    `</table>` +
    `<table class="cl-table cl-table-items">` +
    COLS +
    `<thead><tr>` +
    `<th class="cl-head cl-head-left" colspan="2">Items</th>` +
    `<th class="cl-head cl-head-left">Quantity</th>` +
    `<th class="cl-head cl-head-left">Made</th>` +
    `<th class="cl-head cl-head-left">Loaded</th>` +
    `<th class="cl-head cl-head-left">Delivered</th>` +
    `</tr></thead>` +
    `<tbody>` +
    itemRows +
    blankRows +
    `</tbody>` +
    `</table>` +
    `<div class="cl-signs">` +
    `<div class="cl-sign"><span class="cl-x">X</span><span class="cl-sign-label">TL or SUP Sign &amp; Date</span></div>` +
    `<div class="cl-sign"><span class="cl-x">X</span><span class="cl-sign-label">Driver Sign &amp; Date</span></div>` +
    `</div>` +
    `<div class="cl-blocks">` +
    specBlock("Load specifications", ["Weight:", "Length:", "Width:"]) +
    `</div>` +
    `<div class="cl-blocks">` +
    specBlock("Iveco", ["Max weight:", "Max length:", "Max width:"]) +
    specBlock("Hino", ["Max weight:", "Max length:", "Max width:"]) +
    `</div>` +
    `<div class="cl-emails">` +
    `<p class="cl-email-to"><span>Email:</span> <a href="mailto:${escapeHtml(CHECKLIST_TO)}">${escapeHtml(CHECKLIST_TO)}</a></p>` +
    `<p class="cl-email-cc"><span>Cc :</span> ` +
    CHECKLIST_CC.map((a) => `<a href="mailto:${escapeHtml(a)}">${escapeHtml(a)}</a>`).join(", ") +
    `</p>` +
    `</div>` +
    `</section>`
  );
}

function renderChecklist() {
  const items = includedItems();

  if (items.length === 0) {
    elements.checklistSheet.innerHTML = renderSheet([], 1, 1);
    return;
  }

  // Measure once, then fill each sheet to the page rather than to a row count.
  const { rowHeights, chrome, blankRow } = measureSheet(items);
  const room = PAGE_HEIGHT - chrome - PAGE_SLACK;
  const fits = (indexes) => indexes.reduce((sum, i) => sum + rowHeights[i], 0) <= room;

  const sheets = splitIntoSheets(items, fits);
  let seen = 0;
  elements.checklistSheet.innerHTML = sheets
    .map((sheetItems, index) => {
      const used = sheetItems.reduce((sum, _, i) => sum + rowHeights[seen + i], 0);
      seen += sheetItems.length;
      // Pad with blank rows only while they still fit on the page.
      const spare = Math.max(0, Math.floor((room - used) / blankRow));
      const padTo = Math.min(ITEMS_PER_SHEET, sheetItems.length + spare);
      return renderSheet(sheetItems, index + 1, sheets.length, { padTo });
    })
    .join("");
}

export function renderExtraDelivery() {
  renderFields();
  renderPoSheet();
  renderChecklist();
  renderOutputs();
}

// --- Spreadsheet row and the shortage email ----------------------------------

// "Mick Malaluan" -> "MM". The spreadsheet's first two columns are built from
// the initials rather than asked for twice.
export function initialsOf(name) {
  return String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase())
    .join("");
}

// The spreadsheet writes dates as day/month.
export function shortDate(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return String(value ?? "");
  }
  return `${Number(match[3])}/${Number(match[2])}`;
}

// One item as it reads in the spreadsheet's items cell and in the email: the
// description with its PO detail lines under it.
function itemLines(item) {
  const detail = String(item.details ?? "").trim();
  return [item.description, ...(detail ? detail.split(" · ") : [])].filter(Boolean);
}

// The row to paste into the tracking sheet, in its column order:
// DATE · region · MANIFEST MADE · ADDRESS · SUBURB · JOB NUMBER · supervisor ·
// items · TO BE ACTIONED BY · Traffic light.
export function spreadsheetRow() {
  const initials = initialsOf(delivery.yourName);
  const date = [initials, shortDate(delivery.deliveryDate)].filter(Boolean).join(" ");
  const items = includedItems().flatMap(itemLines).join("\n");

  return [
    date,
    delivery.region,
    initials ? `DOCKET MAKE ${initials}` : "DOCKET MAKE",
    delivery.address,
    delivery.suburb,
    delivery.jobNumber,
    delivery.supervisorContact,
    items,
    delivery.toBeActionedBy.join(" "),
    delivery.trafficLight
  ];
}

// Tab-separated, which is what a spreadsheet takes from the clipboard. A cell
// holding more than one line is wrapped in quotes, or the sheet would spread it
// down the column instead of keeping it in the one cell.
export function rowAsTsv(cells) {
  return cells
    .map((cell) => {
      const text = String(cell ?? "");
      return /[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join("\t");
}

const yn = (value) => (value ? "Y" : "N");

// The shortage notice. The items on an extra delivery are the ones the job is
// going out without, so the ticked items are what this email lists.
export function shortageEmailText() {
  const items = includedItems().flatMap(itemLines).join("\n");
  return [
    `JOB NUMBER: ${delivery.jobNumber}`,
    "",
    `SUBURB: ${delivery.suburb}`,
    "",
    `DELIVERY DATE: ${shortDate(delivery.deliveryDate)}`,
    "",
    delivery.reason,
    "",
    `RACKS AND YARD CHECKED: ${yn(delivery.racksChecked)}`,
    "",
    `SUBSTITUTION CONSIDERED: ${yn(delivery.substitutionConsidered)}`,
    "",
    `SUPER TL/NOTIFIED: ${yn(delivery.superNotified)}`,
    "",
    `TRAFFIC LIGHTS UPDATED: ${yn(delivery.trafficLightsUpdated)}`,
    "",
    "The job will be delivered without the following items",
    "",
    items,
    "",
    `YOUR NAME: ${delivery.yourName}`,
    "",
    `SHIFT: ${delivery.shift}`
  ].join("\n");
}

// Clipboard access needs a secure context and can be refused, so fall back to
// a hidden textarea rather than failing silently.
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:absolute;left:-10000px;top:0;";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function flash(button, message) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = message;
  window.setTimeout(() => {
    button.textContent = button.dataset.label || original;
  }, 1800);
}

// Opens a draft of the shortage notice to the checklist's recipients.
function openEmail() {
  const subjectBits = ["Extra Delivery"];
  if (delivery.jobNumber) subjectBits.push(`Job ${delivery.jobNumber}`);
  if (delivery.suburb) subjectBits.push(delivery.suburb);
  const url =
    `mailto:${encodeURIComponent(CHECKLIST_TO)}` +
    `?cc=${encodeURIComponent(CHECKLIST_CC.join(","))}` +
    `&subject=${encodeURIComponent(subjectBits.join(" — "))}` +
    `&body=${encodeURIComponent(shortageEmailText())}`;
  window.location.href = url;
}

// --- Wiring -----------------------------------------------------------------

function bindField(el, apply) {
  if (!el) {
    return;
  }
  const handler = () => {
    apply(el.type === "checkbox" ? el.checked : el.value);
    persist();
    renderChecklist();
    renderOutputs();
  };
  el.addEventListener("input", handler);
  el.addEventListener("change", handler);
}

export function initExtraDelivery(els) {
  elements = els;

  elements.poDropzone.addEventListener("click", () => elements.poFileInput.click());
  elements.poDropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.poFileInput.click();
    }
  });
  elements.poFileInput.addEventListener("change", () => {
    handlePoFiles(elements.poFileInput.files);
    elements.poFileInput.value = "";
  });
  ["dragenter", "dragover"].forEach((type) => {
    elements.poDropzone.addEventListener(type, (event) => {
      event.preventDefault();
      elements.poDropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "dragend"].forEach((type) => {
    elements.poDropzone.addEventListener(type, () => {
      elements.poDropzone.classList.remove("is-dragover");
    });
  });
  elements.poDropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.poDropzone.classList.remove("is-dragover");
    handlePoFiles(event.dataTransfer?.files);
  });

  bindField(elements.deliveryAddress, (v) => { delivery.address = v; });
  bindField(elements.deliverySuburb, (v) => { delivery.suburb = v; });
  bindField(elements.deliveryJobNumber, (v) => { delivery.jobNumber = v; });
  bindField(elements.deliverySupervisor, (v) => { delivery.supervisorContact = v; });
  bindField(elements.deliveryActionedBy, (v) => { delivery.actionedBy = v; });
  bindField(elements.deliveryRegion, (v) => { delivery.region = v; });
  bindField(elements.deliveryDate, (v) => { delivery.deliveryDate = v; });
  bindField(elements.deliveryTrafficLight, (v) => { delivery.trafficLight = v; });
  bindField(elements.deliveryReason, (v) => { delivery.reason = v; });
  bindField(elements.deliveryYourName, (v) => { delivery.yourName = v; });
  bindField(elements.deliveryShift, (v) => { delivery.shift = v; });
  bindField(elements.racksChecked, (v) => { delivery.racksChecked = v; });
  bindField(elements.substitutionConsidered, (v) => { delivery.substitutionConsidered = v; });
  bindField(elements.superNotified, (v) => { delivery.superNotified = v; });
  bindField(elements.trafficLightsUpdated, (v) => { delivery.trafficLightsUpdated = v; });

  // "To be actioned by" can be more than one bay, so it's a set of ticks kept
  // in the order the list shows them.
  elements.actionAreaInputs.forEach((input) => {
    input.addEventListener("change", () => {
      delivery.toBeActionedBy = elements.actionAreaInputs
        .filter((box) => box.checked)
        .map((box) => box.value);
      persist();
      renderOutputs();
    });
  });

  elements.copyRowButton.addEventListener("click", async () => {
    const ok = await copyText(rowAsTsv(spreadsheetRow()));
    flash(elements.copyRowButton, ok ? "Copied ✓" : "Couldn't copy");
  });
  elements.copyEmailButton.addEventListener("click", async () => {
    const ok = await copyText(shortageEmailText());
    flash(elements.copyEmailButton, ok ? "Copied ✓" : "Couldn't copy");
  });

  elements.deliveryPrintButton.addEventListener("click", () => window.print());
  elements.deliveryEmailButton.addEventListener("click", openEmail);
  elements.deliveryClearButton.addEventListener("click", () => {
    delivery = emptyDelivery();
    persist();
    renderExtraDelivery();
    setStatus("Cleared. Upload the next job's POs.");
  });

  restore();
}
