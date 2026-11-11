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
// Truck limits are the same every time, so once they're typed they stay typed —
// kept apart from the delivery itself, which is cleared between jobs.
const TRUCKS_KEY = "screwcount.truckLimits";

let elements = {};
let userKey = "anon";

const emptyDelivery = () => ({
  address: "",
  suburb: "",
  jobNumber: "",
  supervisorContact: "",
  actionedBy: "",
  weight: "",
  length: "",
  width: "",
  signage: false,
  materials: false,
  truck: "",
  // [{ id, poNumber, orderDate, items: [{ id, description, details, quantity, unit, include }] }]
  pos: []
});

const emptyTrucks = () => ({
  iveco: { weight: "", length: "", width: "" },
  hino: { weight: "", length: "", width: "" }
});

let delivery = emptyDelivery();
let trucks = emptyTrucks();

function storeKey() {
  return `${STORE_PREFIX}${userKey}`;
}

function persist() {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(delivery));
    localStorage.setItem(TRUCKS_KEY, JSON.stringify(trucks));
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

  trucks = emptyTrucks();
  try {
    const raw = localStorage.getItem(TRUCKS_KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      if (stored && typeof stored === "object") {
        trucks = {
          iveco: { ...emptyTrucks().iveco, ...(stored.iveco || {}) },
          hino: { ...emptyTrucks().hino, ...(stored.hino || {}) }
        };
      }
    }
  } catch {
    trucks = emptyTrucks();
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
  f.deliveryWeight.value = delivery.weight;
  f.deliveryLength.value = delivery.length;
  f.deliveryWidth.value = delivery.width;
  f.deliverySignage.checked = delivery.signage;
  f.deliveryMaterials.checked = delivery.materials;
  f.deliveryTruck.value = delivery.truck;
  f.ivecoWeight.value = trucks.iveco.weight;
  f.ivecoLength.value = trucks.iveco.length;
  f.ivecoWidth.value = trucks.iveco.width;
  f.hinoWeight.value = trucks.hino.weight;
  f.hinoLength.value = trucks.hino.length;
  f.hinoWidth.value = trucks.hino.width;
}

function truckBlock(name, limits, selected) {
  const row = (label, value) =>
    `<div class="cl-spec"><span>Max ${label}:</span><span>${escapeHtml(value || "")}</span></div>`;
  return (
    `<div class="cl-truck${selected ? " is-selected" : ""}">` +
    `<div class="cl-truck-name">${escapeHtml(name)}${selected ? " ✓" : ""}</div>` +
    row("weight", limits.weight) +
    row("length", limits.length) +
    row("width", limits.width) +
    `</div>`
  );
}

function renderChecklist() {
  const items = includedItems();
  const rows =
    items.length > 0
      ? items
          .map(
            (item) =>
              `<tr>` +
              `<td class="cl-item">${escapeHtml(item.description)}` +
              (item.details ? `<span class="cl-item-detail">${escapeHtml(item.details)}</span>` : "") +
              `</td>` +
              `<td class="cl-qty">${escapeHtml(item.quantity)} ${escapeHtml(item.unit || "")}</td>` +
              `<td class="cl-box"></td><td class="cl-box"></td><td class="cl-box"></td>` +
              `</tr>`
          )
          .join("")
      : `<tr><td class="cl-item cl-empty" colspan="5">Tick items on the PO sheet to list them here.</td></tr>`;

  elements.checklistSheet.innerHTML =
    `<h2 class="cl-title">Extra Deliveries checklist</h2>` +
    `<table class="cl-table">` +
    `<tr>` +
    `<th class="cl-head" colspan="3">ADDRESS</th>` +
    `<th class="cl-head">Suburb</th>` +
    `<th class="cl-head">Job number</th>` +
    `</tr>` +
    `<tr>` +
    `<td class="cl-value" colspan="3">${escapeHtml(delivery.address)}</td>` +
    `<td class="cl-value">${escapeHtml(delivery.suburb)}</td>` +
    `<td class="cl-value">${escapeHtml(delivery.jobNumber)}</td>` +
    `</tr>` +
    `<tr>` +
    `<th class="cl-head" colspan="3">Supervisor Contact</th>` +
    `<th class="cl-head" colspan="2">Actioned by</th>` +
    `</tr>` +
    `<tr>` +
    `<td class="cl-value" colspan="3">${escapeHtml(delivery.supervisorContact)}</td>` +
    `<td class="cl-value" colspan="2">${escapeHtml(delivery.actionedBy)}</td>` +
    `</tr>` +
    `<tr>` +
    `<th class="cl-head">Items</th><th class="cl-head">Quantity</th>` +
    `<th class="cl-head">Made</th><th class="cl-head">Loaded</th><th class="cl-head">Delivered</th>` +
    `</tr>` +
    rows +
    `</table>` +
    `<div class="cl-signs">` +
    `<div class="cl-sign"><span class="cl-x">X</span><span>TL or SUP Sign &amp; Date</span></div>` +
    `<div class="cl-sign"><span class="cl-x">X</span><span>Driver Sign &amp; Date</span></div>` +
    `</div>` +
    `<div class="cl-cols">` +
    `<div class="cl-col">` +
    `<div class="cl-col-title">Load specifications</div>` +
    `<div class="cl-spec"><span>Weight:</span><span>${escapeHtml(delivery.weight)}</span></div>` +
    `<div class="cl-spec"><span>Length:</span><span>${escapeHtml(delivery.length)}</span></div>` +
    `<div class="cl-spec"><span>Width:</span><span>${escapeHtml(delivery.width)}</span></div>` +
    `</div>` +
    `<div class="cl-col">` +
    `<div class="cl-col-title">Site pictures</div>` +
    `<div class="cl-spec"><span>Signage</span><span>${delivery.signage ? "✓" : "☐"}</span></div>` +
    `<div class="cl-spec"><span>Materials</span><span>${delivery.materials ? "✓" : "☐"}</span></div>` +
    `</div>` +
    `</div>` +
    `<div class="cl-cols">` +
    truckBlock("Iveco", trucks.iveco, delivery.truck === "iveco") +
    truckBlock("Hino", trucks.hino, delivery.truck === "hino") +
    `</div>` +
    `<div class="cl-emails">` +
    `<div><strong>Email:</strong> ${escapeHtml(CHECKLIST_TO)}</div>` +
    `<div><strong>Cc:</strong> ${escapeHtml(CHECKLIST_CC.join(", "))}</div>` +
    `</div>`;
}

export function renderExtraDelivery() {
  renderFields();
  renderPoSheet();
  renderChecklist();
}

// --- Email ------------------------------------------------------------------

function checklistAsText() {
  const lines = [
    "Extra Deliveries checklist",
    "",
    `Address: ${delivery.address}`,
    `Suburb: ${delivery.suburb}`,
    `Job number: ${delivery.jobNumber}`,
    `Supervisor contact: ${delivery.supervisorContact}`,
    `Actioned by: ${delivery.actionedBy}`,
    "",
    "Items:"
  ];
  includedItems().forEach((item) => {
    lines.push(
      `  - ${item.description}${item.details ? ` (${item.details})` : ""} — ${item.quantity} ${item.unit || ""}`.trimEnd()
    );
  });
  lines.push("");
  lines.push(`Load: weight ${delivery.weight || "-"}, length ${delivery.length || "-"}, width ${delivery.width || "-"}`);
  lines.push(`Site pictures: signage ${delivery.signage ? "yes" : "no"}, materials ${delivery.materials ? "yes" : "no"}`);
  if (delivery.truck) {
    const limits = trucks[delivery.truck] || {};
    lines.push(
      `Truck: ${delivery.truck === "iveco" ? "Iveco" : "Hino"} (max weight ${limits.weight || "-"}, length ${
        limits.length || "-"
      }, width ${limits.width || "-"})`
    );
  }
  const pos = delivery.pos.map((po) => po.poNumber).join(", ");
  if (pos) {
    lines.push(`POs: ${pos}`);
  }
  return lines.join("\n");
}

function openEmail() {
  const subjectBits = ["Extra Delivery"];
  if (delivery.jobNumber) subjectBits.push(`Job ${delivery.jobNumber}`);
  if (delivery.suburb) subjectBits.push(delivery.suburb);
  const url =
    `mailto:${encodeURIComponent(CHECKLIST_TO)}` +
    `?cc=${encodeURIComponent(CHECKLIST_CC.join(","))}` +
    `&subject=${encodeURIComponent(subjectBits.join(" — "))}` +
    `&body=${encodeURIComponent(checklistAsText())}`;
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
  bindField(elements.deliveryWeight, (v) => { delivery.weight = v; });
  bindField(elements.deliveryLength, (v) => { delivery.length = v; });
  bindField(elements.deliveryWidth, (v) => { delivery.width = v; });
  bindField(elements.deliverySignage, (v) => { delivery.signage = v; });
  bindField(elements.deliveryMaterials, (v) => { delivery.materials = v; });
  bindField(elements.deliveryTruck, (v) => { delivery.truck = v; });
  bindField(elements.ivecoWeight, (v) => { trucks.iveco.weight = v; });
  bindField(elements.ivecoLength, (v) => { trucks.iveco.length = v; });
  bindField(elements.ivecoWidth, (v) => { trucks.iveco.width = v; });
  bindField(elements.hinoWeight, (v) => { trucks.hino.weight = v; });
  bindField(elements.hinoLength, (v) => { trucks.hino.length = v; });
  bindField(elements.hinoWidth, (v) => { trucks.hino.width = v; });

  elements.deliveryPrintButton.addEventListener("click", () => window.print());
  elements.deliveryEmailButton.addEventListener("click", openEmail);
  elements.deliveryClearButton.addEventListener("click", () => {
    // Truck limits are deliberately kept — they don't change between jobs.
    delivery = emptyDelivery();
    persist();
    renderExtraDelivery();
    setStatus("Cleared. Upload the next job's POs.");
  });

  restore();
}
