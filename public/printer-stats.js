// Printer stats: the roll formers' hourly output, turned into per-operator
// totals for each shift.
//
// Each line (E1–E5) exports a CSV of metres run per hour per operator. A shift
// is read off the hour band, and because the night shift starts the evening
// before, each line needs two days of CSV: the night is the previous day's last
// two hours plus the chosen day's first six.

export const LINES = ["E1", "E2", "E3", "E4", "E5"];

// Whole-hour shift bands, so every row of the CSV lands in exactly one shift
// and the totals reconcile against the file. (The job log's own shifts change
// at 5:45 and 1:30; these are rounded to the hour to match the data.)
export const SHIFT_BANDS = [
  { key: "night", label: "Night", hint: "10pm–6am" },
  { key: "morning", label: "Morning", hint: "6am–2pm" },
  { key: "afternoon", label: "Afternoon", hint: "2pm–10pm" }
];

// Which shift an hour belongs to. `fromPreviousDay` marks rows read out of the
// day-before's file: only its last two hours count, as the start of the night.
export function shiftForHour(hour, fromPreviousDay) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  if (fromPreviousDay) {
    return hour >= 22 ? "night" : null;
  }
  if (hour < 6) {
    return "night";
  }
  if (hour < 14) {
    return "morning";
  }
  if (hour < 22) {
    return "afternoon";
  }
  // The chosen day's own evening belongs to the next day's night shift.
  return null;
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
// `files` is { E1: { previous: rows|null, day: rows|null }, … }.
export function summarise(files) {
  const operators = new Map();
  const lines = new Map();
  const shiftTotals = new Map(SHIFT_BANDS.map((s) => [s.key, 0]));
  let grand = 0;

  const blankShifts = () => new Map(SHIFT_BANDS.map((s) => [s.key, 0]));

  LINES.forEach((line) => {
    const slots = files[line] || {};
    [
      ["previous", true],
      ["day", false]
    ].forEach(([slot, fromPreviousDay]) => {
      const rows = slots[slot];
      if (!Array.isArray(rows)) {
        return;
      }
      rows.forEach((row) => {
        const shift = shiftForHour(row.hour, fromPreviousDay);
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

// --- The tab ----------------------------------------------------------------

const STORE_PREFIX = "screwcount.printerStats.";

let elements = {};
let userKey = "anon";
let pendingSlot = null;

const emptyState = () => ({
  workDate: "",
  // { E1: { previous: {name, rows} | null, day: {name, rows} | null }, … }
  files: Object.fromEntries(LINES.map((line) => [line, { previous: null, day: null }]))
});

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
    LINES.forEach((line) => {
      const slot = stored.files?.[line];
      if (!slot) {
        return;
      }
      ["previous", "day"].forEach((key) => {
        const entry = slot[key];
        if (entry && Array.isArray(entry.rows)) {
          state.files[line][key] = { name: String(entry.name ?? ""), rows: entry.rows };
        }
      });
    });
  } catch {
    state = emptyState();
  }
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

// The day before the chosen one, as YYYY-MM-DD.
export function previousDay(dateKey) {
  const match = String(dateKey ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return "";
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setDate(date.getDate() - 1);
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

async function loadFile(file, line, slot) {
  if (!file) {
    return;
  }
  try {
    const rows = parseMetersCsv(await file.text());
    state.files[line][slot] = { name: file.name, rows };
    persist();
    renderPrinterStats();
    const kept = rows.filter((row) => shiftForHour(row.hour, slot === "previous")).length;
    setStatus(
      `${line} · ${file.name}: ${rows.length} hourly rows, ${kept} counted toward this day.`,
      "success"
    );
  } catch (error) {
    console.error(error);
    setStatus(`${file.name}: ${error.message}`, "warning");
  }
}

function clearSlot(line, slot) {
  state.files[line][slot] = null;
  persist();
  renderPrinterStats();
}

function renderSlots() {
  const prevKey = previousDay(state.workDate);
  const wrap = elements.printerSlots;
  wrap.innerHTML = "";

  LINES.forEach((line) => {
    const card = document.createElement("div");
    card.className = "line-card";

    const name = document.createElement("div");
    name.className = "line-name";
    name.textContent = line;
    card.appendChild(name);

    // Each line takes two days: the night shift starts on the one before.
    [
      ["previous", prevKey],
      ["day", state.workDate]
    ].forEach(([slot, dateKey]) => {
      const loaded = state.files[line][slot];
      const box = document.createElement("div");
      box.className = loaded ? "line-slot is-loaded" : "line-slot";

      const label = document.createElement("div");
      label.className = "line-slot-label";
      label.textContent = dateKey ? dayLabel(dateKey) : slot === "previous" ? "Day before" : "Chosen day";

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
        pendingSlot = { line, slot };
        elements.printerFileInput.click();
      });

      box.append(label, hint, button);

      if (loaded) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "entry-remove";
        clear.textContent = "Clear";
        clear.addEventListener("click", () => clearSlot(line, slot));
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
  const loadedCount = LINES.reduce(
    (sum, line) => sum + (state.files[line].previous ? 1 : 0) + (state.files[line].day ? 1 : 0),
    0
  );

  if (loadedCount === 0) {
    elements.printerResults.innerHTML =
      `<p class="entry-empty">Upload a line's CSV to see who ran what.</p>`;
    return;
  }

  const summary = summarise(
    Object.fromEntries(
      LINES.map((line) => [
        line,
        {
          previous: state.files[line].previous?.rows ?? null,
          day: state.files[line].day?.rows ?? null
        }
      ])
    )
  );

  elements.printerResults.innerHTML =
    table("Metres per operator", summary.operators, "Operator", summary.shiftTotals, summary.grand) +
    table("Metres per line", summary.lines, "Line", summary.shiftTotals, summary.grand);
}

export function renderPrinterStats() {
  elements.printerDate.value = state.workDate;
  renderSlots();
  renderResults();
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
      loadFile(file, target.line, target.slot);
    }
  });

  elements.printerClearButton.addEventListener("click", () => {
    const keepDate = state.workDate;
    state = emptyState();
    state.workDate = keepDate;
    persist();
    renderPrinterStats();
    setStatus("Cleared. Upload the next day's files.");
  });

  restore();
}
