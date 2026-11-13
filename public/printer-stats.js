// Printer stats: the roll formers' hourly output, turned into per-operator
// totals for each shift.
//
// Each line (E1–E5) exports a CSV of metres run per hour per operator. A shift
// is read off the hour band and belongs to the day it starts on, so a day's
// night shift runs past midnight: each line needs two days of CSV, the chosen
// day's last two hours plus the next day's first six.

export const LINES = ["E1", "E2", "E3", "E4", "E5"];

// Whole-hour shift bands, so every row of the CSV lands in exactly one shift
// and the totals reconcile against the file. (The job log's own shifts change
// at 5:45 and 1:30; these are rounded to the hour to match the data.)
// In the order the day runs, now that a day's night is the one that starts
// that evening: morning, afternoon, then night out the other side of midnight.
export const SHIFT_BANDS = [
  { key: "morning", label: "Morning", hint: "6am–2pm" },
  { key: "afternoon", label: "Afternoon", hint: "2pm–10pm" },
  { key: "night", label: "Night", hint: "10pm–6am" }
];

// Which shift an hour belongs to. A shift belongs to the day it starts on, the
// same way the job log dates one: the night shift of the 12th runs 10pm on the
// 12th through 6am on the 13th. `fromNextDay` marks rows read out of the
// following day's file, where only the first six hours count — they are the
// tail of this day's night.
export function shiftForHour(hour, fromNextDay) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  if (fromNextDay) {
    return hour < 6 ? "night" : null;
  }
  // Before 6am on the chosen day is the tail of the PREVIOUS day's night, and
  // belongs to that day's report.
  if (hour < 6) {
    return null;
  }
  if (hour < 14) {
    return "morning";
  }
  if (hour < 22) {
    return "afternoon";
  }
  return "night";
}

// Splits one CSV line, honouring quoted fields so a name with a comma survives.
function splitCsvLine(line) {
  const out = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        value += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(value);
      value = "";
    } else {
      value += ch;
    }
  }
  out.push(value);
  return out;
}

// "0-1" / "23-24" -> the hour it starts.
export function hourFromBand(value) {
  const match = String(value ?? "").trim().match(/^(\d{1,2})\s*-\s*\d{1,2}$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  return hour >= 0 && hour <= 23 ? hour : null;
}

// Operator names come through with doubled spaces ("Pema  Wangchuk"), which
// would otherwise split one person into two.
export function tidyName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function parseMetersCsv(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error("That file is empty.");
  }

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const hourAt = header.findIndex((h) => h === "column name" || h === "hour");
  const metresAt = header.findIndex((h) => h === "metersrun" || h === "metresrun");
  const operatorAt = header.findIndex((h) => h === "operator");
  const formerAt = header.findIndex((h) => h === "rollformer");

  if (hourAt < 0 || metresAt < 0 || operatorAt < 0) {
    throw new Error("Expected a header with Column Name, MetersRun and Operator.");
  }

  const rows = [];
  lines.slice(1).forEach((line) => {
    const cells = splitCsvLine(line);
    const hour = hourFromBand(cells[hourAt]);
    const metres = Number(String(cells[metresAt] ?? "").trim());
    const operator = tidyName(cells[operatorAt]);
    if (hour === null || !Number.isFinite(metres) || !operator) {
      return;
    }
    rows.push({
      hour,
      metres,
      operator,
      rollFormer: formerAt >= 0 ? tidyName(cells[formerAt]) : ""
    });
  });

  if (rows.length === 0) {
    throw new Error("No hourly rows could be read from that file.");
  }
  return rows;
}

// Roll the loaded files up into per-operator and per-line totals for each shift.
// `files` is { E1: { day: rows|null, next: rows|null }, … }.
export function summarise(files) {
  const operators = new Map();
  const lines = new Map();
  const shiftTotals = new Map(SHIFT_BANDS.map((s) => [s.key, 0]));
  let grand = 0;

  const blankShifts = () => new Map(SHIFT_BANDS.map((s) => [s.key, 0]));

  LINES.forEach((line) => {
    const slots = files[line] || {};
    [
      ["day", false],
      ["next", true]
    ].forEach(([slot, fromNextDay]) => {
      const rows = slots[slot];
      if (!Array.isArray(rows)) {
        return;
      }
      rows.forEach((row) => {
        const shift = shiftForHour(row.hour, fromNextDay);
        if (!shift) {
          return;
        }
        if (!operators.has(row.operator)) {
          operators.set(row.operator, blankShifts());
        }
        if (!lines.has(line)) {
          lines.set(line, blankShifts());
        }
        operators.get(row.operator).set(shift, operators.get(row.operator).get(shift) + row.metres);
        lines.get(line).set(shift, lines.get(line).get(shift) + row.metres);
        shiftTotals.set(shift, shiftTotals.get(shift) + row.metres);
        grand += row.metres;
      });
    });
  });

  const toRows = (map) =>
    [...map.entries()]
      .map(([name, shifts]) => {
        const values = SHIFT_BANDS.map((s) => shifts.get(s.key));
        return { name, values, total: values.reduce((a, b) => a + b, 0) };
      })
      // Biggest producer first — who did what is the point of the table.
      .sort((a, b) => b.total - a.total);

  return {
    operators: toRows(operators),
    lines: toRows(lines).sort((a, b) => a.name.localeCompare(b.name)),
    shiftTotals: SHIFT_BANDS.map((s) => shiftTotals.get(s.key)),
    grand
  };
}

// A day's own figures, from its file and the following day's: its 6am–10pm,
// plus the night it starts, which needs the next day's midnight–6am to finish.
// `rowsFor(dateKey)` hands back { line: rows } for a day, or {} when that day
// has nothing loaded.
export function summariseDay(dateKey, rowsFor) {
  const own = rowsFor(dateKey) || {};
  const after = rowsFor(nextDay(dateKey)) || {};
  const summary = summarise(
    Object.fromEntries(LINES.map((line) => [line, { day: own[line] ?? null, next: after[line] ?? null }]))
  );
  return {
    dateKey,
    summary,
    // Without the next day's file the night stops at midnight, and saying so
    // is the difference between a short night and a wrong one.
    partialNight: LINES.every((line) => !after[line]),
    loaded: LINES.some((line) => Boolean(own[line]))
  };
}

// The chosen day and the one after it, each totalled on its own.
export function summariseDays(dateKey, rowsFor) {
  return [summariseDay(dateKey, rowsFor), summariseDay(nextDay(dateKey), rowsFor)];
}

// --- The tab ----------------------------------------------------------------

const STORE_PREFIX = "screwcount.printerStats.";

let elements = {};
let userKey = "anon";
let pendingSlot = null;

// A CSV is a day's file, so it is stored under that day — not under "the slot
// I happened to drop it in". Changing the date then shows that date's own
// files, every other day stays saved, and the file loaded as one day's "next
// day" is already there when you go to that day.
// { "2026-11-12": { E1: {name, rows}, … }, … }
const emptyState = () => ({ workDate: "", days: {} });

// Days are small (a few hundred hourly rows), but they are kept forever
// otherwise; the oldest go first once there are more than this.
const MAX_DAYS = 60;

let state = emptyState();

function storeKey() {
  return `${STORE_PREFIX}${userKey}`;
}

function persist() {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(state));
  } catch {
    // Storage unavailable, or the day's files are too big for it — the stats
    // just won't still be here after a reload.
  }
}

function restore() {
  state = emptyState();
  try {
    const raw = localStorage.getItem(storeKey());
    if (!raw) {
      return;
    }
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== "object") {
      return;
    }
    state.workDate = typeof stored.workDate === "string" ? stored.workDate : "";

    if (stored.days && typeof stored.days === "object") {
      Object.entries(stored.days).forEach(([dateKey, lines]) => {
        LINES.forEach((line) => {
          const entry = lines?.[line];
          if (entry && Array.isArray(entry.rows)) {
            setFile(dateKey, line, { name: String(entry.name ?? ""), rows: entry.rows });
          }
        });
      });
      return;
    }

    // Anything saved before files were filed by date: the "day" slot was the
    // chosen day's file and "next" the day after's, so put them there.
    LINES.forEach((line) => {
      const slot = stored.files?.[line];
      if (!slot) {
        return;
      }
      [["day", state.workDate], ["next", nextDay(state.workDate)]].forEach(([key, dateKey]) => {
        const entry = slot[key];
        if (dateKey && entry && Array.isArray(entry.rows)) {
          setFile(dateKey, line, { name: String(entry.name ?? ""), rows: entry.rows });
        }
      });
    });
  } catch {
    state = emptyState();
  }
}

const filesOn = (dateKey) => state.days[dateKey] || null;

const fileOn = (dateKey, line) => filesOn(dateKey)?.[line] || null;

function setFile(dateKey, line, entry) {
  if (!dateKey) {
    return;
  }
  if (!state.days[dateKey]) {
    state.days[dateKey] = {};
  }
  if (entry) {
    state.days[dateKey][line] = entry;
  } else {
    delete state.days[dateKey][line];
    if (Object.keys(state.days[dateKey]).length === 0) {
      delete state.days[dateKey];
    }
  }
  // Keep the newest days; an old one nobody has opened in months isn't worth
  // failing a save over.
  const keys = Object.keys(state.days).sort();
  while (keys.length > MAX_DAYS) {
    delete state.days[keys.shift()];
  }
}

// summarise() reads a line's rows; the stored files carry their name alongside,
// so the rows are unwrapped here for both the tab and the report.
const rowsFor = (dateKey) =>
  Object.fromEntries(LINES.map((line) => [line, fileOn(dateKey, line)?.rows ?? null]));

// Every day that has at least one file, newest first.
export function loadedDays() {
  return Object.keys(state.days)
    .filter((dateKey) => Object.keys(state.days[dateKey]).length > 0)
    .sort((a, b) => b.localeCompare(a));
}

// What the tab currently holds, for the shared report: the chosen day, the
// totals it is showing, and which files they came from.
export function getPrinterSnapshot() {
  const files = [];
  [state.workDate, nextDay(state.workDate)].forEach((dateKey) => {
    LINES.forEach((line) => {
      const loaded = fileOn(dateKey, line);
      if (loaded) {
        files.push(`${line} · ${dayLabel(dateKey)} · ${loaded.name}`);
      }
    });
  });
  return { workDate: state.workDate, days: summariseDays(state.workDate, rowsFor), files };
}

export function setPrinterStatsUser(uid) {
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

const fmt = (metres) =>
  metres.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// The day after the chosen one, as YYYY-MM-DD — where the night shift finishes.
export function nextDay(dateKey) {
  const match = String(dateKey ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return "";
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setDate(date.getDate() + 1);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayLabel(dateKey) {
  const match = String(dateKey ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return "";
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function setStatus(message, tone = "hint") {
  elements.printerStatus.textContent = message;
  elements.printerStatus.className =
    tone === "warning" || tone === "success" ? `hint ${tone}` : "hint";
}

async function loadFile(file, line, dateKey) {
  if (!file || !dateKey) {
    return;
  }
  try {
    const rows = parseMetersCsv(await file.text());
    setFile(dateKey, line, { name: file.name, rows });
    persist();
    renderPrinterStats();
    // The file is this day's whole day; the hours that fall in its own shifts
    // are everything from 6am, the rest finishing the previous day's night.
    const own = rows.filter((row) => shiftForHour(row.hour, false)).length;
    setStatus(
      `${line} · ${file.name}: ${rows.length} hourly rows, ${own} in ${dayLabel(dateKey)}'s own shifts.`,
      "success"
    );
  } catch (error) {
    console.error(error);
    setStatus(`${file.name}: ${error.message}`, "warning");
  }
}

function clearSlot(line, dateKey) {
  setFile(dateKey, line, null);
  persist();
  renderPrinterStats();
}

function renderSlots() {
  const nextKey = nextDay(state.workDate);
  const wrap = elements.printerSlots;
  wrap.innerHTML = "";

  LINES.forEach((line) => {
    const card = document.createElement("div");
    card.className = "line-card";

    const name = document.createElement("div");
    name.className = "line-name";
    name.textContent = line;
    card.appendChild(name);

    // Each line takes two days: the night shift it starts carries into the next.
    [
      ["day", state.workDate],
      ["next", nextKey]
    ].forEach(([slot, dateKey]) => {
      const loaded = fileOn(dateKey, line);
      const box = document.createElement("div");
      box.className = loaded ? "line-slot is-loaded" : "line-slot";

      const label = document.createElement("div");
      label.className = "line-slot-label";
      label.textContent = dateKey ? dayLabel(dateKey) : slot === "day" ? "Chosen day" : "Next day";

      // Only the loaded file's name goes here; an empty slot says it with the
      // date above and the button below.
      const hint = document.createElement("div");
      hint.className = "line-slot-note";
      hint.textContent = loaded ? loaded.name : "";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "entry-action";
      button.textContent = loaded ? "Replace" : "Upload CSV";
      button.addEventListener("click", () => {
        pendingSlot = { line, dateKey };
        elements.printerFileInput.click();
      });

      box.append(label, hint, button);

      if (loaded) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "entry-remove";
        clear.textContent = "Clear";
        clear.addEventListener("click", () => clearSlot(line, dateKey));
        box.appendChild(clear);
      }

      card.appendChild(box);
    });

    wrap.appendChild(card);
  });
}

function table(caption, rows, firstHeading, totals, grand) {
  const head =
    `<tr><th>${escapeHtml(firstHeading)}</th>` +
    SHIFT_BANDS.map((s) => `<th>${escapeHtml(s.label)}<span>${escapeHtml(s.hint)}</span></th>`).join("") +
    `<th>Total</th></tr>`;

  const body = rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.name)}</td>` +
        row.values.map((v) => `<td>${v > 0 ? fmt(v) : "—"}</td>`).join("") +
        `<td class="is-total">${fmt(row.total)}</td></tr>`
    )
    .join("");

  const foot =
    `<tr class="is-foot"><td>All</td>` +
    totals.map((v) => `<td>${v > 0 ? fmt(v) : "—"}</td>`).join("") +
    `<td class="is-total">${fmt(grand)}</td></tr>`;

  return (
    `<div class="stats-block">` +
    `<h3 class="section-subtitle">${escapeHtml(caption)}</h3>` +
    `<div class="stats-scroll"><table class="stats-table">${head}${body}${foot}</table></div>` +
    `</div>`
  );
}

function renderResults() {
  const days = state.workDate ? summariseDays(state.workDate, rowsFor) : [];
  const showing = days.filter((day) => day.summary.grand > 0);

  if (showing.length === 0) {
    elements.printerResults.innerHTML = `<p class="entry-empty">${
      state.workDate
        ? `Nothing loaded for ${escapeHtml(dayLabel(state.workDate))} yet.`
        : "Pick a day, then upload a line's CSV."
    }</p>`;
    return;
  }

  elements.printerResults.innerHTML = showing
    .map(({ dateKey, partialNight, summary }) => {
      const heading = dayLabel(dateKey);
      return (
        `<section class="day-block">` +
        `<h3 class="day-block-title">${escapeHtml(heading)}` +
        // Its night can't be finished without the following day's file, so the
        // figure is only the evening half and must not read as a full night.
        (partialNight ? `<span>night to midnight only</span>` : "") +
        `</h3>` +
        table("Metres per operator", summary.operators, "Operator", summary.shiftTotals, summary.grand) +
        table("Metres per line", summary.lines, "Line", summary.shiftTotals, summary.grand) +
        `</section>`
      );
    })
    .join("");
}

// The days that have files, so a day's work can be found again instead of
// being guessed at in the date box.
function renderLoadedDays() {
  const list = elements.printerDays;
  if (!list) {
    return;
  }
  const days = loadedDays();
  if (days.length === 0) {
    list.innerHTML = `<p class="entry-empty">No days loaded yet.</p>`;
    return;
  }

  list.innerHTML = days
    .map((dateKey) => {
      const count = Object.keys(state.days[dateKey] || {}).length;
      return (
        `<button type="button" class="sb-day${dateKey === state.workDate ? " is-active" : ""}" ` +
        `data-printer-day="${escapeHtml(dateKey)}">` +
        `<strong>${escapeHtml(dayLabel(dateKey))}</strong>` +
        `<span>${count} line${count === 1 ? "" : "s"}</span>` +
        `</button>`
      );
    })
    .join("");

  list.querySelectorAll("[data-printer-day]").forEach((button) => {
    button.addEventListener("click", () => {
      state.workDate = button.dataset.printerDay;
      persist();
      renderPrinterStats();
    });
  });
}

export function renderPrinterStats() {
  elements.printerDate.value = state.workDate;
  renderSlots();
  renderResults();
  renderLoadedDays();
}

export function initPrinterStats(els) {
  elements = els;

  elements.printerDate.addEventListener("change", () => {
    state.workDate = elements.printerDate.value;
    persist();
    renderPrinterStats();
  });

  elements.printerFileInput.addEventListener("change", () => {
    const file = elements.printerFileInput.files?.[0];
    const target = pendingSlot;
    elements.printerFileInput.value = "";
    pendingSlot = null;
    if (file && target) {
      loadFile(file, target.line, target.dateKey);
    }
  });

  // Clears the day on screen, not the lot: every other day stays where it is.
  elements.printerClearButton.addEventListener("click", () => {
    if (!state.workDate || !state.days[state.workDate]) {
      return;
    }
    if (!window.confirm(`Clear the files loaded for ${dayLabel(state.workDate)}?`)) {
      return;
    }
    delete state.days[state.workDate];
    persist();
    renderPrinterStats();
    setStatus(`Cleared ${dayLabel(state.workDate)}.`);
  });

  restore();
}
