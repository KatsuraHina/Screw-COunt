// Steel bay: the cut breakdown sheet.
//
// One sheet per day, matching the spreadsheet the bay already keeps — job
// number, dims, material, the cut length, what's left on the bar and what goes
// in the bin — with the day's cut length and waste totalled at the bottom.
//
// The sheet lives in Firestore under its date, so the bay types it once and the
// office reads the same rows back. Everything here is written for a tablet in a
// noisy bay: big fields, Enter moves down, and nothing is lost by a reload.

import {
  loadSteelBaySheetDates,
  saveSteelBaySheet,
  subscribeToSteelBaySheet
} from "./firebase-service.js";

// Offered as you type, so the common sections aren't spelled out every time.
// Anything already on the sheet is offered too (see suggestionsFor).
const DIMS_SUGGESTIONS = [
  "100mm C Purlin 8m",
  "250mm C Purlin 8m",
  "100x50x2 mm 8m",
  "50x50x3 mm 6m",
  "150x50x4 mm",
  "150x100x4 mm"
];

const MATERIAL_SUGGESTIONS = ["Duragal", "RHS BLACK", "Galvanised", "Black steel"];

// The spreadsheet's own column order, so a paste lands in the right columns.
export const COLUMNS = ["Job No.", "Dims", "Material", "Length", "Leftover", "Waste"];

// How long after the last keystroke the sheet is written. Long enough that
// typing a row isn't one write per character, short enough that walking away
// mid-row still saves it.
const SAVE_DELAY = 700;

let elements = {};
let user = null;
let canEdit = false;
let unsubscribe = null;
let saveTimer = null;
let savesInFlight = 0;
let lastLocalEdit = 0;
let seq = 0;

const nextId = () => {
  seq += 1;
  return `r${Date.now().toString(36)}${seq}`;
};

export function emptyRow() {
  return { id: nextId(), jobNumber: "", dims: "", material: "", length: "", leftover: "", waste: "" };
}

const emptySheet = () => ({ date: todayKey(), cutBy: "", rows: [emptyRow()] });

let sheet = emptySheet();

export function todayKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// Lengths are typed in millimetres, but people write "5,590" or "5590mm", so
// anything that isn't part of a number is dropped. A blank stays blank rather
// than becoming 0 — an empty waste cell means "not measured", not "none".
export function parseNumber(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") {
    return null;
  }
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

const sum = (rows, field) =>
  rows.reduce((total, row) => total + (parseNumber(row[field]) ?? 0), 0);

// The sheet totals cut length and waste. Leftover is deliberately not totalled:
// it's what is still on each bar, so adding it up says nothing.
export function totals(rows) {
  const length = sum(rows, "length");
  const waste = sum(rows, "waste");
  return {
    length,
    waste,
    // Waste as a share of everything cut, which is the number the bay is judged
    // on. Undefined rather than 0 when nothing has been cut yet.
    wastePercent: length > 0 ? (waste / length) * 100 : null,
    filled: rows.filter(isRowFilled).length
  };
}

export function isRowFilled(row) {
  return Boolean(
    String(row.jobNumber ?? "").trim() ||
      String(row.dims ?? "").trim() ||
      String(row.material ?? "").trim() ||
      parseNumber(row.length) !== null ||
      parseNumber(row.leftover) !== null ||
      parseNumber(row.waste) !== null
  );
}

const cell = (value) => {
  const text = String(value ?? "");
  // Quote anything that would otherwise break a column or a row in Excel.
  return /[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const numberCell = (value) => {
  const number = parseNumber(value);
  return number === null ? "" : String(number);
};

// Tab-separated, header included, so it pastes straight into the Cut breakdown
// sheet. Only filled rows go out, with the totals on the last line where the
// spreadsheet keeps them.
export function sheetAsTsv(current = sheet) {
  const rows = current.rows.filter(isRowFilled);
  const sums = totals(rows);
  const lines = [COLUMNS.join("\t")];

  rows.forEach((row) => {
    lines.push(
      [
        cell(row.jobNumber),
        cell(row.dims),
        cell(row.material),
        numberCell(row.length),
        numberCell(row.leftover),
        numberCell(row.waste)
      ].join("\t")
    );
  });

  lines.push(["", "", "", String(sums.length), "", String(sums.waste)].join("\t"));
  return lines.join("\n");
}

// --- storage ---------------------------------------------------------------

function scheduleSave() {
  lastLocalEdit = Date.now();
  if (!canEdit || !user) {
    return;
  }
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, SAVE_DELAY);
  setStatus("Saving…");
}

async function save() {
  if (!canEdit || !user) {
    return;
  }
  const dateKey = sheet.date;
  savesInFlight += 1;
  try {
    await saveSteelBaySheet(dateKey, {
      cutBy: sheet.cutBy,
      // Blank rows are the ones still being typed into; they never reach the
      // sheet everyone else reads.
      rows: sheet.rows.filter(isRowFilled).map((row) => ({
        jobNumber: String(row.jobNumber ?? ""),
        dims: String(row.dims ?? ""),
        material: String(row.material ?? ""),
        length: numberCell(row.length),
        leftover: numberCell(row.leftover),
        waste: numberCell(row.waste)
      }))
    }, user);
    setStatus(`Saved ${timeOfDay()}.`, "success");
    // A day that had no sheet before now has one, so the list beside it is
    // stale until this runs.
    loadDayList();
  } catch (error) {
    console.error(error);
    setStatus("Couldn't save — check the connection; what you typed is still here.", "warning");
  } finally {
    savesInFlight -= 1;
  }
}

function applyRemote(data) {
  // A snapshot of our own write would wipe the row being typed, so anything
  // that arrives while a save is in flight (or right after a keystroke) is
  // left alone — the next save sends the full sheet anyway.
  if (savesInFlight > 0 || Date.now() - lastLocalEdit < SAVE_DELAY * 2) {
    return;
  }

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  sheet.cutBy = typeof data?.cutBy === "string" ? data.cutBy : "";
  sheet.rows = rows.map((row) => ({
    id: nextId(),
    jobNumber: String(row?.jobNumber ?? ""),
    dims: String(row?.dims ?? ""),
    material: String(row?.material ?? ""),
    length: String(row?.length ?? ""),
    leftover: String(row?.leftover ?? ""),
    waste: String(row?.waste ?? "")
  }));
  // Always one blank row to type into — but not for a reader, who would just
  // be looking at an empty line.
  if (canEdit || sheet.rows.length === 0) {
    sheet.rows.push(emptyRow());
  }
  renderSteelBay();
}

function watchDate() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (!user || !sheet.date) {
    return;
  }
  const dateKey = sheet.date;
  unsubscribe = subscribeToSteelBaySheet(
    dateKey,
    (data) => {
      // Ignore a late snapshot for a day we've already navigated away from.
      if (sheet.date !== dateKey) {
        return;
      }
      if (!data) {
        // No sheet for this day yet — start a fresh one, but only if nothing
        // has been typed, so switching back to an empty day isn't destructive.
        if (sheet.rows.every((row) => !isRowFilled(row))) {
          sheet.rows = [emptyRow()];
          renderSteelBay();
        }
        setStatus(canEdit ? "New day — start typing." : "Nothing recorded for this day.");
        return;
      }
      applyRemote(data);
    },
    () => setStatus("Couldn't read the day's sheet.", "warning")
  );
}

// Called when the signed-in user changes. `editable` is false for everyone but
// the steel bay account and admins, matching the Firestore rules.
export function setSteelBayUser(nextUser, editable) {
  user = nextUser || null;
  canEdit = Boolean(editable);
  window.clearTimeout(saveTimer);
  sheet = emptySheet();
  if (elements.steelBayDate) {
    elements.steelBayDate.value = sheet.date;
  }
  watchDate();
  loadDayList();
  renderSteelBay();
}

async function loadDayList() {
  if (!user || !elements.steelBayDays) {
    return;
  }
  try {
    const days = await loadSteelBaySheetDates();
    renderDayList(days);
  } catch (error) {
    console.error(error);
    renderDayList([]);
  }
}

// --- rendering -------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const fmt = (mm) => (Number.isFinite(mm) ? mm.toLocaleString("en-AU") : "0");

function timeOfDay() {
  return new Date().toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
}

function setStatus(message, tone = "hint") {
  if (!elements.steelBayStatus) {
    return;
  }
  elements.steelBayStatus.textContent = message;
  elements.steelBayStatus.className = tone === "warning" ? "hint warning" : "hint";
}

function suggestionsFor(field, base) {
  const used = sheet.rows.map((row) => String(row[field] ?? "").trim()).filter(Boolean);
  return [...new Set([...used, ...base])];
}

function renderDatalist(id, values) {
  return (
    `<datalist id="${id}">` +
    values.map((value) => `<option value="${escapeHtml(value)}"></option>`).join("") +
    `</datalist>`
  );
}

function renderDayList(days) {
  const list = elements.steelBayDays;
  if (!list) {
    return;
  }
  if (days.length === 0) {
    list.innerHTML = `<p class="entry-empty">No sheets saved yet.</p>`;
    return;
  }
  list.innerHTML = days
    .slice(0, 14)
    .map(
      (day) =>
        `<button type="button" class="sb-day${day.date === sheet.date ? " is-active" : ""}" data-sb-day="${escapeHtml(
          day.date
        )}">` +
        `<strong>${escapeHtml(dayLabel(day.date))}</strong>` +
        `<span>${day.rows} row${day.rows === 1 ? "" : "s"}${day.cutBy ? ` · ${escapeHtml(day.cutBy)}` : ""}</span>` +
        `</button>`
    )
    .join("");

  list.querySelectorAll("[data-sb-day]").forEach((button) => {
    button.addEventListener("click", () => goToDate(button.dataset.sbDay));
  });
}

function dayLabel(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  if (!year || !month || !day) {
    return dateKey;
  }
  return new Date(year, month - 1, day).toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short"
  });
}

const FIELDS = [
  { key: "jobNumber", label: "Job No.", type: "text", mode: "numeric" },
  { key: "dims", label: "Dims", type: "text", list: "sbDimsList" },
  { key: "material", label: "Material", type: "text", list: "sbMaterialList" },
  { key: "length", label: "Length", type: "text", mode: "numeric", numeric: true },
  { key: "leftover", label: "Leftover", type: "text", mode: "numeric", numeric: true },
  { key: "waste", label: "Waste", type: "text", mode: "numeric", numeric: true }
];

export function renderSteelBay() {
  const table = elements.steelBayTable;
  if (!table) {
    return;
  }

  const focus = document.activeElement;
  const keepFocus =
    focus && focus.dataset && focus.dataset.sbRow
      ? { row: focus.dataset.sbRow, field: focus.dataset.sbField, start: focus.selectionStart }
      : null;

  if (elements.steelBayDate && elements.steelBayDate.value !== sheet.date) {
    elements.steelBayDate.value = sheet.date;
  }
  if (elements.steelBayCutBy && elements.steelBayCutBy.value !== sheet.cutBy) {
    elements.steelBayCutBy.value = sheet.cutBy;
  }
  if (elements.steelBaySheetTitle) {
    elements.steelBaySheetTitle.textContent = `Cut breakdown — ${dayLabel(sheet.date)}`;
  }
  // A reader can still move between days; only typing is off.
  if (elements.steelBayCutBy) {
    elements.steelBayCutBy.disabled = !canEdit;
  }
  elements.steelBayAddRow.classList.toggle("hidden", !canEdit);
  elements.steelBayClearButton.classList.toggle("hidden", !canEdit);

  const sums = totals(sheet.rows);

  table.innerHTML =
    renderDatalist("sbDimsList", suggestionsFor("dims", DIMS_SUGGESTIONS)) +
    renderDatalist("sbMaterialList", suggestionsFor("material", MATERIAL_SUGGESTIONS)) +
    `<table class="sb-table">` +
    `<thead><tr>` +
    FIELDS.map((f) => `<th class="sb-h sb-h-${f.key}">${f.label}</th>`).join("") +
    `<th class="sb-h sb-h-actions" aria-label="Remove row"></th>` +
    `</tr></thead>` +
    `<tbody>` +
    sheet.rows
      .map(
        (row) =>
          `<tr data-sb-row-id="${row.id}">` +
          FIELDS.map(
            (f) =>
              `<td class="sb-cell sb-cell-${f.key}">` +
              `<input type="text" class="sb-input${f.numeric ? " sb-input-num" : ""}"` +
              ` value="${escapeHtml(row[f.key])}"` +
              ` data-sb-row="${row.id}" data-sb-field="${f.key}"` +
              (f.list ? ` list="${f.list}"` : "") +
              (f.mode ? ` inputmode="${f.mode}"` : "") +
              ` aria-label="${f.label}"${canEdit ? "" : " readonly"}>` +
              `</td>`
          ).join("") +
          `<td class="sb-cell sb-cell-actions">` +
          (canEdit
            ? `<button type="button" class="entry-remove sb-remove" data-sb-remove="${row.id}" aria-label="Remove row">×</button>`
            : "") +
          `</td>` +
          `</tr>`
      )
      .join("") +
    `</tbody>` +
    `<tfoot><tr>` +
    `<td class="sb-total-label" colspan="3">${sums.filled} row${sums.filled === 1 ? "" : "s"}</td>` +
    `<td class="sb-total">${fmt(sums.length)}</td>` +
    `<td class="sb-total sb-total-muted"></td>` +
    `<td class="sb-total">${fmt(sums.waste)}</td>` +
    `<td></td>` +
    `</tr></tfoot>` +
    `</table>` +
    (sums.wastePercent === null
      ? ""
      : `<p class="sb-waste-note">Waste is ${sums.wastePercent.toFixed(1)}% of the ${fmt(
          sums.length
        )} mm cut.</p>`);

  bindRowEvents();

  if (keepFocus) {
    const field = table.querySelector(
      `[data-sb-row="${keepFocus.row}"][data-sb-field="${keepFocus.field}"]`
    );
    if (field) {
      field.focus();
      if (keepFocus.start !== null && keepFocus.start !== undefined) {
        try {
          field.setSelectionRange(keepFocus.start, keepFocus.start);
        } catch {
          // Some input types don't support a selection range — focus is enough.
        }
      }
    }
  }
}

// Only the totals change while a row is being typed, so they're patched in
// place: a full re-render would pull the caret out of the field.
function refreshTotals() {
  const table = elements.steelBayTable;
  if (!table) {
    return;
  }
  const sums = totals(sheet.rows);
  const cells = table.querySelectorAll("tfoot td");
  if (cells.length >= 4) {
    cells[0].textContent = `${sums.filled} row${sums.filled === 1 ? "" : "s"}`;
    cells[1].textContent = fmt(sums.length);
    cells[3].textContent = fmt(sums.waste);
  }
  const note = table.querySelector(".sb-waste-note");
  if (note) {
    note.textContent =
      sums.wastePercent === null
        ? ""
        : `Waste is ${sums.wastePercent.toFixed(1)}% of the ${fmt(sums.length)} mm cut.`;
  }
}

function bindRowEvents() {
  const table = elements.steelBayTable;

  table.querySelectorAll("[data-sb-row]").forEach((input) => {
    input.addEventListener("input", () => {
      const row = sheet.rows.find((entry) => entry.id === input.dataset.sbRow);
      if (!row) {
        return;
      }
      row[input.dataset.sbField] = input.value;
      refreshTotals();
      ensureBlankRow();
      scheduleSave();
    });

    // Enter walks down the column, the way the spreadsheet does, adding a row
    // at the bottom rather than stopping.
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      const index = sheet.rows.findIndex((entry) => entry.id === input.dataset.sbRow);
      const next = sheet.rows[index + 1];
      if (next) {
        const field = table.querySelector(
          `[data-sb-row="${next.id}"][data-sb-field="${input.dataset.sbField}"]`
        );
        if (field) {
          field.focus();
        }
      } else if (canEdit) {
        addRow(input.dataset.sbField);
      }
    });
  });

  table.querySelectorAll("[data-sb-remove]").forEach((button) => {
    button.addEventListener("click", () => removeRow(button.dataset.sbRemove));
  });
}

// There is always an empty row waiting at the bottom, so a new cut never needs
// a button press first.
function ensureBlankRow() {
  const last = sheet.rows[sheet.rows.length - 1];
  if (canEdit && (!last || isRowFilled(last)) && sheet.rows.length < 500) {
    sheet.rows.push(emptyRow());
    renderSteelBay();
  }
}

function addRow(focusField) {
  const row = emptyRow();
  sheet.rows.push(row);
  renderSteelBay();
  const field = elements.steelBayTable.querySelector(
    `[data-sb-row="${row.id}"][data-sb-field="${focusField || "jobNumber"}"]`
  );
  if (field) {
    field.focus();
  }
}

function removeRow(id) {
  sheet.rows = sheet.rows.filter((row) => row.id !== id);
  if (sheet.rows.length === 0) {
    sheet.rows.push(emptyRow());
  }
  renderSteelBay();
  scheduleSave();
}

function goToDate(dateKey) {
  if (!dateKey || dateKey === sheet.date) {
    return;
  }
  // Flush anything still pending against the day being left.
  window.clearTimeout(saveTimer);
  if (canEdit && user && sheet.rows.some(isRowFilled)) {
    save();
  }
  sheet = { date: dateKey, cutBy: "", rows: [emptyRow()] };
  if (elements.steelBayDate) {
    elements.steelBayDate.value = dateKey;
  }
  renderSteelBay();
  watchDate();
  loadDayList();
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

export function initSteelBay(els) {
  elements = els;

  elements.steelBayDate.value = sheet.date;

  elements.steelBayDate.addEventListener("change", () => {
    goToDate(elements.steelBayDate.value || todayKey());
  });

  elements.steelBayCutBy.addEventListener("input", () => {
    sheet.cutBy = elements.steelBayCutBy.value;
    scheduleSave();
  });

  elements.steelBayAddRow.addEventListener("click", () => addRow("jobNumber"));

  elements.steelBayCopyButton.addEventListener("click", async () => {
    const ok = await copyText(sheetAsTsv());
    flash(elements.steelBayCopyButton, ok ? "Copied ✓" : "Couldn't copy");
  });

  elements.steelBayClearButton.addEventListener("click", () => {
    if (!canEdit || !sheet.rows.some(isRowFilled)) {
      return;
    }
    if (!window.confirm(`Clear every row on ${dayLabel(sheet.date)}?`)) {
      return;
    }
    sheet.rows = [emptyRow()];
    renderSteelBay();
    scheduleSave();
  });

  renderSteelBay();
}
