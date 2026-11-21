// Steel bay: the every-shift stock take.
//
// This replaces a workbook that had grown to 77 near-identical sheets, one per
// weekly count, with the history smeared sideways into `stock order 25/05`,
// `NOTES 18/05` columns. Counting three times a day would have made that
// unreadable inside a fortnight.
//
// So the two halves are kept apart. The item list lives once, in
// `steelStockCatalogue/current` — correct a name there and every count ever
// taken still points at the right item, because the `id` never changes. Each
// shift's count is its own record, `steelStockCounts/{countId}`, holding only
// what was typed that shift.
//
// A shift starts with every box empty: a count is what you can see on the rack
// now, so pre-filling it with last shift's figure would invite a glance and a
// nod. Last shift's figure sits beside the box instead, to compare against.

import {
  loadStockCount,
  saveStockCatalogue,
  saveStockCount,
  subscribeToStockCatalogue,
  subscribeToStockCount
} from "./firebase-service.js";
import { SHIFT_ORDER, currentShiftWindow, stepShift } from "./jobs.js";
import { STOCK_SEED } from "./steel-stock-seed.js";

const SAVE_DELAY = 700;

// How far back to look for the last count. Three shifts is a full day, so a
// Monday morning still sees Friday's figure over a quiet weekend, but a figure
// older than that is stale enough to be misleading.
const PREVIOUS_LOOKBACK = 3;

const COLUMNS = [
  "Group",
  "Item",
  "Unit",
  "Location",
  "Re-order point",
  "Count",
  "To order",
  "Note"
];

let elements = {};
let user = null;
let canEdit = false;

let catalogue = [];
let catalogueReady = false;
let shift = currentShiftWindow();
let counts = {};
let countedBy = "";
let previous = {};
let mode = "count";
let filter = "all";
let search = "";

let unsubscribeCatalogue = null;
let unsubscribeCount = null;
let countSaveTimer = null;
let catalogueSaveTimer = null;
let savesInFlight = 0;
let lastLocalEdit = 0;
let seq = 0;

// --- pure helpers ----------------------------------------------------------

// `2026-11-20_2_night`. The shift's position in the day leads the name so the
// ids sort in the order the shifts actually ran — "night" sorting before
// "morning" alphabetically is exactly the trap this avoids.
export function countId(dayKey, shiftName) {
  const index = SHIFT_ORDER.indexOf(shiftName);
  return `${dayKey}_${index < 0 ? 0 : index}_${shiftName}`;
}

export function parseNumber(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") {
    return null;
  }
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

// Hitting the re-order point is the trigger to order, so the point itself
// counts as low. An item with no point set is never flagged.
export function belowReorder(item, qty) {
  const point = parseNumber(item?.reorderPoint);
  const counted = parseNumber(qty);
  if (point === null || counted === null) {
    return false;
  }
  return counted <= point;
}

function entryFor(id) {
  const entry = counts[id];
  return {
    qty: String(entry?.qty ?? ""),
    order: String(entry?.order ?? ""),
    note: String(entry?.note ?? "")
  };
}

function isCounted(id) {
  return parseNumber(entryFor(id).qty) !== null;
}

function hasAnything(id) {
  const entry = entryFor(id);
  return Boolean(entry.qty.trim() || entry.order.trim() || entry.note.trim());
}

// Everything typed this shift, in catalogue order — what the TSV and the
// shared report both read.
export function stockRows() {
  return catalogue
    .filter((item) => hasAnything(item.id))
    .map((item) => {
      const entry = entryFor(item.id);
      return {
        id: item.id,
        group: item.group ?? "",
        name: item.name ?? "",
        unit: item.unit ?? "",
        location: item.location ?? "",
        reorderPoint: item.reorderPoint ?? null,
        qty: entry.qty,
        order: entry.order,
        note: entry.note,
        below: belowReorder(item, entry.qty)
      };
    });
}

const tsvCell = (value) => {
  const text = String(value ?? "");
  return /[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function stockAsTsv() {
  const lines = [COLUMNS.join("\t")];
  stockRows().forEach((row) => {
    lines.push(
      [
        tsvCell(row.group),
        tsvCell(row.name),
        tsvCell(row.unit),
        tsvCell(row.location),
        row.reorderPoint === null ? "" : String(row.reorderPoint),
        tsvCell(row.qty),
        tsvCell(row.order),
        tsvCell(row.note)
      ].join("\t")
    );
  });
  return lines.join("\n");
}

export function stockProgress() {
  const counted = catalogue.filter((item) => isCounted(item.id)).length;
  const low = catalogue.filter((item) => belowReorder(item, entryFor(item.id).qty)).length;
  return { total: catalogue.length, counted, low };
}

// --- storage ---------------------------------------------------------------

function scheduleCountSave() {
  lastLocalEdit = Date.now();
  if (!canEdit || !user) {
    return;
  }
  window.clearTimeout(countSaveTimer);
  countSaveTimer = window.setTimeout(saveCount, SAVE_DELAY);
  setStatus("Saving…");
}

async function saveCount() {
  if (!canEdit || !user) {
    return;
  }
  const id = countId(shift.dayKey, shift.shift);
  // Only what was actually typed is written; an untouched item has no entry at
  // all, which is what makes "not counted" answerable later.
  const payload = {};
  catalogue.forEach((item) => {
    if (!hasAnything(item.id)) {
      return;
    }
    const entry = entryFor(item.id);
    payload[item.id] = { qty: entry.qty, order: entry.order, note: entry.note };
  });

  savesInFlight += 1;
  try {
    await saveStockCount(id, {
      dayKey: shift.dayKey,
      shift: shift.shift,
      countedBy,
      counts: payload
    }, user);
    setStatus(`Saved ${timeOfDay()}.`);
  } catch (error) {
    console.error(error);
    setStatus("Couldn't save — check the connection; what you typed is still here.", "warning");
  } finally {
    savesInFlight -= 1;
  }
}

function scheduleCatalogueSave() {
  lastLocalEdit = Date.now();
  if (!canEdit || !user) {
    return;
  }
  window.clearTimeout(catalogueSaveTimer);
  catalogueSaveTimer = window.setTimeout(saveCatalogue, SAVE_DELAY);
  setStatus("Saving the list…");
}

async function saveCatalogue() {
  if (!canEdit || !user) {
    return;
  }
  savesInFlight += 1;
  try {
    await saveStockCatalogue(
      catalogue.map((item) => ({
        id: item.id,
        group: String(item.group ?? ""),
        name: String(item.name ?? ""),
        unit: String(item.unit ?? ""),
        location: String(item.location ?? ""),
        averageWeek: parseNumber(item.averageWeek),
        averageMonth: parseNumber(item.averageMonth),
        reorderPoint: parseNumber(item.reorderPoint)
      })),
      user
    );
    setStatus(`Saved ${timeOfDay()}.`);
  } catch (error) {
    console.error(error);
    setStatus("Couldn't save the list — check the connection.", "warning");
  } finally {
    savesInFlight -= 1;
  }
}

// A snapshot of our own write would wipe the box being typed into, so anything
// arriving while a save is in flight — or right after a keystroke — is left
// alone. The next save sends the whole record anyway.
//
// The first snapshot of a record is exempt: it is that record's stored state,
// read before anything here has touched it. Without the exemption, stepping to
// another shift loses its figures, because leaving a shift flushes a save and
// the arriving snapshot for the *new* shift gets taken for that save's echo.
function echoing() {
  return savesInFlight > 0 || Date.now() - lastLocalEdit < SAVE_DELAY * 2;
}

function watchCatalogue() {
  if (unsubscribeCatalogue) {
    unsubscribeCatalogue();
    unsubscribeCatalogue = null;
  }
  if (!user) {
    return;
  }
  let fresh = true;
  unsubscribeCatalogue = subscribeToStockCatalogue(
    (items) => {
      if (!fresh && echoing()) {
        return;
      }
      fresh = false;
      catalogueReady = true;
      catalogue = Array.isArray(items)
        ? items.map((item) => ({
            id: String(item?.id ?? nextItemId()),
            group: String(item?.group ?? ""),
            name: String(item?.name ?? ""),
            unit: String(item?.unit ?? ""),
            location: String(item?.location ?? ""),
            averageWeek: item?.averageWeek ?? null,
            averageMonth: item?.averageMonth ?? null,
            reorderPoint: item?.reorderPoint ?? null
          }))
        : [];
      renderStockTake();
    },
    () => setStatus("Couldn't read the stock list.", "warning")
  );
}

function watchCount() {
  if (unsubscribeCount) {
    unsubscribeCount();
    unsubscribeCount = null;
  }
  if (!user) {
    return;
  }
  const id = countId(shift.dayKey, shift.shift);
  let fresh = true;
  unsubscribeCount = subscribeToStockCount(
    id,
    (data) => {
      // Ignore a late snapshot for a shift the arrows have already left.
      if (countId(shift.dayKey, shift.shift) !== id) {
        return;
      }
      if (!fresh && echoing()) {
        return;
      }
      fresh = false;
      counts = data && typeof data.counts === "object" && data.counts ? { ...data.counts } : {};
      countedBy = typeof data?.countedBy === "string" ? data.countedBy : "";
      renderStockTake();
    },
    () => setStatus("Couldn't read this shift's count.", "warning")
  );
}

// The last figure recorded for each item, looked up one shift at a time going
// back. Three direct reads by id — no query, so no index and no surprises
// about ordering.
async function loadPrevious() {
  previous = {};
  if (!user) {
    renderStockTake();
    return;
  }
  const target = shift;
  for (let step = 1; step <= PREVIOUS_LOOKBACK; step += 1) {
    const earlier = stepShift(target, -step);
    let data = null;
    try {
      data = await loadStockCount(countId(earlier.dayKey, earlier.shift));
    } catch (error) {
      console.error(error);
    }
    // The arrows moved while this was in flight — its answer is for a shift
    // nobody is looking at any more.
    if (target !== shift) {
      return;
    }
    const found = data && typeof data.counts === "object" ? data.counts : null;
    if (found) {
      Object.keys(found).forEach((id) => {
        const qty = String(found[id]?.qty ?? "");
        // First non-blank wins: a nearer shift's figure is never overwritten by
        // an older one.
        if (qty.trim() && previous[id] === undefined) {
          previous[id] = { qty, shift: earlier };
        }
      });
    }
  }
  renderStockTake();
}

export function setStockTakeUser(nextUser, editable) {
  user = nextUser || null;
  canEdit = Boolean(editable);
  window.clearTimeout(countSaveTimer);
  window.clearTimeout(catalogueSaveTimer);
  catalogue = [];
  catalogueReady = false;
  counts = {};
  countedBy = "";
  previous = {};
  mode = "count";
  filter = "all";
  search = "";
  shift = currentShiftWindow();
  watchCatalogue();
  watchCount();
  loadPrevious();
  renderStockTake();
}

// --- rendering -------------------------------------------------------------

function nextItemId() {
  seq += 1;
  // Minted from the clock so two devices adding an item at once don't collide.
  return `i${Date.now().toString(36)}${seq}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function timeOfDay() {
  return new Date().toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
}

function setStatus(message, tone = "hint") {
  if (!elements.stockStatus) {
    return;
  }
  elements.stockStatus.textContent = message;
  elements.stockStatus.className = tone === "warning" ? "hint warning" : "hint";
}

function dayLabel(dayKey) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  if (!year || !month || !day) {
    return dayKey;
  }
  return new Date(year, month - 1, day).toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short"
  });
}

export function shiftLabel(window_ = shift) {
  const name = String(window_.shift ?? "");
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} · ${dayLabel(window_.dayKey)}`;
}

// Which items are on screen: the search box first, then the chip.
function visibleItems() {
  const needle = search.trim().toLowerCase();
  return catalogue.filter((item) => {
    if (needle) {
      const haystack = `${item.name} ${item.location} ${item.group} ${item.unit}`.toLowerCase();
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    if (filter === "low") {
      return belowReorder(item, entryFor(item.id).qty);
    }
    if (filter === "todo") {
      return !isCounted(item.id);
    }
    return true;
  });
}

const numberText = (value) => {
  const number = parseNumber(value);
  return number === null ? "" : number.toLocaleString("en-AU");
};

function renderCountRows(items) {
  let lastGroup = null;
  return items
    .map((item) => {
      const entry = entryFor(item.id);
      const low = belowReorder(item, entry.qty);
      const prior = previous[item.id];
      const heading =
        item.group === lastGroup
          ? ""
          : `<tr class="stock-group"><th colspan="6">${escapeHtml(item.group || "Ungrouped")}</th></tr>`;
      lastGroup = item.group;

      const meta = [item.location && `Rack ${item.location}`, item.unit]
        .filter(Boolean)
        .map((part) => escapeHtml(part))
        .join(" · ");

      return (
        heading +
        `<tr class="stock-row${low ? " stock-low" : ""}" data-stock-row-id="${escapeHtml(item.id)}">` +
        `<td class="sb-cell stock-cell-item">` +
        `<span class="stock-name">${escapeHtml(item.name)}</span>` +
        (meta ? `<span class="stock-meta">${meta}</span>` : "") +
        `</td>` +
        `<td class="sb-cell stock-cell-point">${
          item.reorderPoint === null || item.reorderPoint === "" ? "—" : numberText(item.reorderPoint)
        }</td>` +
        `<td class="sb-cell stock-prev">${
          prior ? `${escapeHtml(prior.qty)}<span>${escapeHtml(shiftLabel(prior.shift))}</span>` : "—"
        }</td>` +
        `<td class="sb-cell">` +
        `<input type="text" class="sb-input sb-input-num" inputmode="numeric"` +
        ` value="${escapeHtml(entry.qty)}" data-stock-row="${escapeHtml(item.id)}" data-stock-field="qty"` +
        ` aria-label="Count for ${escapeHtml(item.name)}"${canEdit ? "" : " readonly"}>` +
        `</td>` +
        `<td class="sb-cell">` +
        `<input type="text" class="sb-input sb-input-num" inputmode="numeric"` +
        ` value="${escapeHtml(entry.order)}" data-stock-row="${escapeHtml(item.id)}" data-stock-field="order"` +
        ` aria-label="To order for ${escapeHtml(item.name)}"${canEdit ? "" : " readonly"}>` +
        `</td>` +
        `<td class="sb-cell">` +
        `<input type="text" class="sb-input" value="${escapeHtml(entry.note)}"` +
        ` data-stock-row="${escapeHtml(item.id)}" data-stock-field="note"` +
        ` aria-label="Note for ${escapeHtml(item.name)}"${canEdit ? "" : " readonly"}>` +
        `</td>` +
        `</tr>`
      );
    })
    .join("");
}

const EDIT_FIELDS = [
  { key: "group", label: "Group" },
  { key: "name", label: "Item" },
  { key: "unit", label: "Unit" },
  { key: "location", label: "Location" },
  { key: "averageWeek", label: "Avg week", numeric: true },
  { key: "averageMonth", label: "Avg month", numeric: true },
  { key: "reorderPoint", label: "Re-order", numeric: true }
];

function renderEditRows(items) {
  return items
    .map(
      (item) =>
        `<tr data-stock-row-id="${escapeHtml(item.id)}">` +
        EDIT_FIELDS.map(
          (field) =>
            `<td class="sb-cell">` +
            `<input type="text" class="sb-input${field.numeric ? " sb-input-num" : ""}"` +
            (field.numeric ? ` inputmode="numeric"` : "") +
            ` value="${escapeHtml(item[field.key] ?? "")}"` +
            ` data-stock-row="${escapeHtml(item.id)}" data-stock-field="${field.key}"` +
            ` aria-label="${field.label}"${canEdit ? "" : " readonly"}>` +
            `</td>`
        ).join("") +
        `<td class="sb-cell sb-cell-actions">` +
        (canEdit
          ? `<button type="button" class="entry-remove sb-remove" data-stock-remove="${escapeHtml(
              item.id
            )}" aria-label="Remove ${escapeHtml(item.name)}">×</button>`
          : "") +
        `</td>` +
        `</tr>`
    )
    .join("");
}

export function renderStockTake() {
  const table = elements.stockTable;
  if (!table) {
    return;
  }

  const focus = document.activeElement;
  const keepFocus =
    focus && focus.dataset && focus.dataset.stockRow
      ? { row: focus.dataset.stockRow, field: focus.dataset.stockField, start: focus.selectionStart }
      : null;

  if (elements.stockTakeTitle) {
    elements.stockTakeTitle.textContent = `Stock take — ${shiftLabel()}`;
  }
  if (elements.stockShiftLabel) {
    elements.stockShiftLabel.textContent = shiftLabel();
  }
  if (elements.stockNextShift) {
    // There is no counting a shift that hasn't run.
    const now = currentShiftWindow();
    elements.stockNextShift.disabled =
      shift.dayKey === now.dayKey && shift.shift === now.shift;
  }
  if (elements.stockCountedBy && elements.stockCountedBy.value !== countedBy) {
    elements.stockCountedBy.value = countedBy;
  }
  if (elements.stockCountedBy) {
    elements.stockCountedBy.disabled = !canEdit;
  }
  if (elements.stockModeButton) {
    elements.stockModeButton.textContent = mode === "count" ? "Edit items" : "Done editing";
    elements.stockModeButton.setAttribute("aria-pressed", String(mode === "items"));
    elements.stockModeButton.classList.toggle("hidden", !canEdit);
  }
  if (elements.stockAddButton) {
    elements.stockAddButton.classList.toggle("hidden", !(canEdit && mode === "items"));
  }
  if (elements.stockFilters) {
    elements.stockFilters.classList.toggle("hidden", mode !== "count");
    elements.stockFilters.querySelectorAll("[data-stock-filter]").forEach((chip) => {
      chip.setAttribute("aria-pressed", String(chip.dataset.stockFilter === filter));
    });
  }

  // Nothing to count until someone loads the list.
  if (catalogue.length === 0) {
    table.innerHTML =
      `<p class="entry-empty">` +
      (catalogueReady || !user
        ? canEdit
          ? "No stock list yet. Load the standard list to start, then edit it to match the bay."
          : "No stock list yet."
        : "Loading the stock list…") +
      `</p>`;
    if (elements.stockSeedButton) {
      elements.stockSeedButton.classList.toggle("hidden", !(canEdit && catalogueReady));
    }
    if (elements.stockProgress) {
      elements.stockProgress.textContent = "";
    }
    return;
  }

  if (elements.stockSeedButton) {
    elements.stockSeedButton.classList.add("hidden");
  }

  const items = visibleItems();
  const progress = stockProgress();
  if (elements.stockProgress) {
    elements.stockProgress.textContent =
      `${progress.counted} of ${progress.total} counted` +
      (progress.low > 0 ? ` · ${progress.low} at or below re-order point` : "");
  }

  if (items.length === 0) {
    table.innerHTML = `<p class="entry-empty">Nothing matches — clear the search or the filter.</p>`;
    return;
  }

  table.innerHTML =
    `<table class="sb-table stock-table">` +
    `<thead><tr>` +
    (mode === "count"
      ? `<th class="sb-h stock-h-item">Item</th>` +
        `<th class="sb-h stock-h-num">Re-order at</th>` +
        `<th class="sb-h stock-h-num">Last count</th>` +
        `<th class="sb-h stock-h-num">Count</th>` +
        `<th class="sb-h stock-h-num">To order</th>` +
        `<th class="sb-h">Note</th>`
      : EDIT_FIELDS.map((field) => `<th class="sb-h">${field.label}</th>`).join("") +
        `<th class="sb-h sb-h-actions" aria-label="Remove item"></th>`) +
    `</tr></thead>` +
    `<tbody>` +
    (mode === "count" ? renderCountRows(items) : renderEditRows(items)) +
    `</tbody>` +
    `</table>`;

  bindRows();

  if (keepFocus) {
    const field = table.querySelector(
      `[data-stock-row="${keepFocus.row}"][data-stock-field="${keepFocus.field}"]`
    );
    if (field) {
      field.focus();
      if (keepFocus.start !== null && keepFocus.start !== undefined) {
        try {
          field.setSelectionRange(keepFocus.start, keepFocus.start);
        } catch {
          // Not every input supports a selection range — focus is enough.
        }
      }
    }
  }
}

// Typing shouldn't re-render: a filter is applied when the table is drawn, so
// counting an item while "Not counted" is on would otherwise pull the row out
// from under the caret. The row's own flag and the progress line are patched
// in place instead.
function refreshRow(id) {
  const table = elements.stockTable;
  const row = table?.querySelector(`[data-stock-row-id="${id}"]`);
  const item = catalogue.find((entry) => entry.id === id);
  if (row && item) {
    row.classList.toggle("stock-low", belowReorder(item, entryFor(id).qty));
  }
  const progress = stockProgress();
  if (elements.stockProgress) {
    elements.stockProgress.textContent =
      `${progress.counted} of ${progress.total} counted` +
      (progress.low > 0 ? ` · ${progress.low} at or below re-order point` : "");
  }
}

function bindRows() {
  const table = elements.stockTable;

  table.querySelectorAll("[data-stock-row]").forEach((input) => {
    input.addEventListener("input", () => {
      const id = input.dataset.stockRow;
      const field = input.dataset.stockField;
      if (!canEdit) {
        return;
      }
      if (mode === "count") {
        const entry = entryFor(id);
        counts[id] = { ...entry, [field]: input.value };
        refreshRow(id);
        scheduleCountSave();
        return;
      }
      const item = catalogue.find((entry) => entry.id === id);
      if (!item) {
        return;
      }
      item[field] = input.value;
      scheduleCatalogueSave();
    });

    // Enter walks down the column, the way the sheet it replaces did.
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      const inputs = [...table.querySelectorAll(`[data-stock-field="${input.dataset.stockField}"]`)];
      const next = inputs[inputs.indexOf(input) + 1];
      if (next) {
        next.focus();
        next.select?.();
      }
    });
  });

  table.querySelectorAll("[data-stock-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = catalogue.find((entry) => entry.id === button.dataset.stockRemove);
      if (!item || !canEdit) {
        return;
      }
      if (!window.confirm(`Remove ${item.name || "this item"} from the stock list?`)) {
        return;
      }
      catalogue = catalogue.filter((entry) => entry.id !== item.id);
      renderStockTake();
      scheduleCatalogueSave();
    });
  });
}

function goToShift(delta) {
  const next = stepShift(shift, delta);
  const now = currentShiftWindow();
  if (delta > 0 && (shift.dayKey === now.dayKey && shift.shift === now.shift)) {
    return;
  }
  // Flush anything still pending against the shift being left.
  window.clearTimeout(countSaveTimer);
  if (canEdit && user && Object.keys(counts).length > 0) {
    saveCount();
  }
  shift = next;
  counts = {};
  countedBy = "";
  previous = {};
  renderStockTake();
  watchCount();
  loadPrevious();
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea
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

export function initStockTake(els) {
  elements = els;

  elements.stockPrevShift?.addEventListener("click", () => goToShift(-1));
  elements.stockNextShift?.addEventListener("click", () => goToShift(1));

  elements.stockCountedBy?.addEventListener("input", () => {
    countedBy = elements.stockCountedBy.value;
    scheduleCountSave();
  });

  elements.stockSearch?.addEventListener("input", () => {
    search = elements.stockSearch.value;
    renderStockTake();
  });

  elements.stockFilters?.querySelectorAll("[data-stock-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      filter = chip.dataset.stockFilter;
      renderStockTake();
    });
  });

  elements.stockModeButton?.addEventListener("click", () => {
    mode = mode === "count" ? "items" : "count";
    // A filter about counting means nothing while the list is being edited.
    if (mode === "items") {
      filter = "all";
    }
    renderStockTake();
  });

  elements.stockAddButton?.addEventListener("click", () => {
    if (!canEdit) {
      return;
    }
    // New items land in the group being looked at, which is usually the one
    // the missing item belongs to.
    const last = visibleItems()[visibleItems().length - 1] || catalogue[catalogue.length - 1];
    catalogue.push({
      id: nextItemId(),
      group: last?.group ?? "",
      name: "",
      unit: "",
      location: "",
      averageWeek: null,
      averageMonth: null,
      reorderPoint: null
    });
    search = "";
    if (elements.stockSearch) {
      elements.stockSearch.value = "";
    }
    renderStockTake();
    const inputs = elements.stockTable.querySelectorAll('[data-stock-field="name"]');
    inputs[inputs.length - 1]?.focus();
    scheduleCatalogueSave();
  });

  elements.stockSeedButton?.addEventListener("click", () => {
    if (!canEdit || catalogue.length > 0) {
      return;
    }
    catalogue = STOCK_SEED.map((item) => ({ ...item }));
    renderStockTake();
    scheduleCatalogueSave();
  });

  elements.stockCopyButton?.addEventListener("click", async () => {
    const ok = await copyText(stockAsTsv());
    flash(elements.stockCopyButton, ok ? "Copied ✓" : "Couldn't copy");
  });

  renderStockTake();
}
