export const BREAK_15 = 15;
export const BREAK_24 = 24;

export const ADMIN_EMAIL = "mick.malaluan@gmail.com";

export function isAdminUser(user) {
  return Boolean(user?.email) && user.email.toLowerCase() === ADMIN_EMAIL;
}

export const JOB_TYPES = {
  trusses: {
    key: "trusses",
    label: "Trusses",
    unitLabel: "Linear metres",
    shortUnit: "m",
    rateLabel: "Metres per worker per hour",
    rateShortUnit: "m/h",
    addLabel: "Linear metres",
    addButtonLabel: "Add metres",
    emptyStatus:
      "Choose a start time to begin calculating. You can leave time ended empty for a live count.",
    emptyEntriesText: "No metres added yet.",
    addWarning: "Enter a metres value greater than zero before adding it.",
    saveWarning: "Add some metres before ending and saving a job.",
    entryText: (entry) => `${entry.amount.toFixed(2)} m - ${entry.timeLabel}`,
    chartTotalTitle: "Total metres per day",
    chartRateTitle: "Metres/worker/hour per day"
  },
  walls: {
    key: "walls",
    label: "Walls",
    unitLabel: "Screws",
    shortUnit: "screws",
    rateLabel: "Screws per worker per hour",
    rateShortUnit: "screws/h",
    addLabel: "Screws",
    addButtonLabel: "Add screws",
    emptyStatus:
      "Choose a start time to begin calculating. You can leave time ended empty for a live count.",
    emptyEntriesText: "No screws added yet.",
    addWarning: "Enter a screw count greater than zero before adding it.",
    saveWarning: "Add some screws before ending and saving a job.",
    entryText: (entry) => `${entry.amount.toFixed(0)} screws - ${entry.timeLabel}`,
    chartTotalTitle: "Total screws per day",
    chartRateTitle: "Screws/worker/hour per day"
  }
};

export function formatMinutes(totalMinutes) {
  const safeMinutes = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateLabel(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString([], {
    day: "numeric",
    month: "short"
  });
}

// Format an ISO timestamp as a 12-hour clock time, e.g. "5:30 AM". Returns ""
// when the value is missing or unparseable (older jobs may lack startedAt).
export function formatClockTime(isoValue) {
  if (!isoValue) {
    return "";
  }
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function parseTimeAgainstReference(timeValue, referenceDate) {
  if (!timeValue) {
    return null;
  }

  const [hours, minutes] = timeValue.split(":").map(Number);
  const result = new Date(referenceDate);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

export function parseDateValue(dateValue) {
  if (!dateValue) {
    return null;
  }

  const [year, month, day] = dateValue.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function startOfReferenceDay(date) {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function resolveShiftBounds(startTimeValue, endTimeValue, workDateValue) {
  const now = new Date();
  const reference = parseDateValue(workDateValue) ?? startOfReferenceDay(now);
  const start = parseTimeAgainstReference(startTimeValue, reference);
  const hasEndTime = Boolean(endTimeValue);
  const end = hasEndTime ? parseTimeAgainstReference(endTimeValue, reference) : new Date(now);

  if (hasEndTime) {
    // An end earlier than the start means the shift ran past midnight.
    if (end < start) {
      end.setDate(end.getDate() + 1);
    }
  } else if (!workDateValue && start > end) {
    // Live count with no chosen date: assume an in-progress overnight shift began yesterday.
    start.setDate(start.getDate() - 1);
  }

  return { start, end };
}

export function calculateBreakMinutes(break15Checked, break24Checked) {
  let total = 0;

  if (break15Checked) {
    total += BREAK_15;
  }

  if (break24Checked) {
    total += BREAK_24;
  }

  return total;
}

export function calculateWorkedMinutes(startTimeValue, endTimeValue, workDateValue) {
  if (!startTimeValue) {
    return null;
  }

  const { start, end } = resolveShiftBounds(startTimeValue, endTimeValue, workDateValue);
  return Math.floor((end - start) / 60000);
}

// Strap time is a span (e.g. banding the finished product) that is lost from the
// shift. Both a start and end are required; an end before the start rolls over.
// How long strap & brace took. Strap is a short task done right after the job,
// so AM/PM is irrelevant — both times are read on a 12-hour dial and the end is
// rolled forward past the start. Returns whole minutes (0 if either is blank).
export function calculateStrapMinutes(strapStartValue, strapEndValue) {
  const start = parseFlexibleTime(strapStartValue);
  const end = parseFlexibleTime(strapEndValue);
  if (!start || !end) {
    return 0;
  }

  const startDial = (start.hour12 % 12) * 60 + start.minute;
  const endDial = (end.hour12 % 12) * 60 + end.minute;
  return (endDial - startDial + 720) % 720;
}

// Breaks come out of the worked window first. If they run past the job's finish
// time — i.e. the total break minutes are longer than the worked window
// (end − start) — that overflow is taken out of the strap & brace time instead
// of vanishing. Returns the strap minutes left after absorbing the overflow,
// never below zero.
export function adjustStrapForBreakOverflow(strapMinutes, breakMinutes, rawWorkedMinutes) {
  const worked = Number(rawWorkedMinutes) || 0;
  const breaks = Number(breakMinutes) || 0;
  const overflow = Math.max(breaks - worked, 0);
  return Math.max((Number(strapMinutes) || 0) - overflow, 0);
}

// --- Smart 12-hour time entry ---------------------------------------------
// Workers type a bare time (e.g. "5:30") and the app picks AM/PM for them.
//
// When a current time is known (live entry on today's date) we anchor the
// guess to "now": of the two readings (AM vs PM) we pick whichever clock time
// is closest to the current time, so the app follows the shift you're actually
// in. Example: at 4am, "10" resolves to 10pm — it is 6 hours away, while 10am
// would be 6 hours in the future. Ties go to the reading that already happened.
//
// Without a current time (a back-dated job on another day) we fall back to a
// static map tuned to the fixed shift hours (5:30a start; 1:30p / 2p / 10p).
// Either way the AM/PM toggle lets the user flip the occasional miss.
const AM_DEFAULT_HOURS = new Set([5, 6, 7, 8, 9, 11]);

// Times are usually logged at or shortly after they happen, so we score each
// reading by how long ago it was. A reading just ahead of now (within this
// grace window) is treated as "now" — e.g. logging the afternoon job at 1pm
// with a 2pm start should still read 2pm, not 2am.
const FUTURE_GRACE_MINUTES = 180;

function minutesSince(nowMinutes, candidate) {
  const ago = (nowMinutes - candidate + 1440) % 1440;
  return ago > 1440 - FUTURE_GRACE_MINUTES ? 0 : ago;
}

export function guessMeridiem(hour12, minute = 0, nowMinutes = null) {
  if (nowMinutes === null || !Number.isFinite(nowMinutes)) {
    return AM_DEFAULT_HOURS.has(hour12) ? "AM" : "PM";
  }

  const amTotal = (hour12 % 12) * 60 + minute;
  const pmTotal = ((hour12 % 12) + 12) * 60 + minute;
  // Pick whichever reading is the most recent (just-past or about-to-happen).
  return minutesSince(nowMinutes, pmTotal) <= minutesSince(nowMinutes, amTotal) ? "PM" : "AM";
}

// Parse free-form text ("5", "530", "5:30", "5.30", "17:30") into a 12-hour
// hour/minute. `meridiem` is set only when the input was an unambiguous 24-hour
// time (so the caller skips guessing); otherwise it is null.
export function parseFlexibleTime(text) {
  const digits = String(text ?? "").replace(/[^0-9]/g, "");
  if (!digits) {
    return null;
  }

  let hour;
  let minute;
  if (digits.length <= 2) {
    hour = Number(digits);
    minute = 0;
  } else if (digits.length === 3) {
    hour = Number(digits.slice(0, 1));
    minute = Number(digits.slice(1));
  } else {
    hour = Number(digits.slice(0, 2));
    minute = Number(digits.slice(2, 4));
  }

  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59 || hour > 23) {
    return null;
  }

  let meridiem = null;
  if (hour === 0) {
    // "0" / "00:56" is an unambiguous 24-hour midnight.
    hour = 12;
    meridiem = "AM";
  } else if (hour > 12) {
    // 13–23 is an unambiguous 24-hour evening time.
    hour -= 12;
    meridiem = "PM";
  }
  // A bare 12 is ambiguous (noon vs midnight), so its AM/PM is left unset for
  // the shift to resolve — e.g. "12:56" is midnight on a night shift but noon
  // on a morning shift. (1–11 are likewise left to the shift.)

  return { hour12: hour, minute, meridiem };
}

// No job runs longer than a full 8-hour shift. When a start/end pair works out
// longer than that, the AM/PM guess was wrong on one side.
export const MAX_SHIFT_MINUTES = 8 * 60;

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function flipMeridiem24(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${String((h + 12) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Minutes from start to end, rolling past midnight (matches how worked time
// treats an end earlier than the start).
export function timePairSpanMinutes(start24, end24) {
  return (hhmmToMinutes(end24) - hhmmToMinutes(start24) + 1440) % 1440;
}

// If the pair spans more than MAX_SHIFT_MINUTES, flipping either time by 12
// hours produces the only alternative span; when that alternative fits within
// a shift, return the corrected pair. Which side to flip: times are logged as
// (or just after) they happen, so the reading that occurred most recently is
// the trustworthy anchor — flip the other one. Without a current time (a
// back-dated job) we flip the end. Returns null when the pair is already
// plausible or cannot be fixed by an AM/PM flip.
export function reconcileTimePair(start24, end24, nowMinutes = null) {
  if (!start24 || !end24) {
    return null;
  }

  const base = timePairSpanMinutes(start24, end24);
  if (base > 0 && base <= MAX_SHIFT_MINUTES) {
    return null;
  }

  const alt = (base + 720) % 1440;
  if (!(alt > 0 && alt <= MAX_SHIFT_MINUTES)) {
    return null;
  }

  let flipStart = false;
  if (nowMinutes !== null && Number.isFinite(nowMinutes)) {
    const startAgo = (nowMinutes - hhmmToMinutes(start24) + 1440) % 1440;
    const endAgo = (nowMinutes - hhmmToMinutes(end24) + 1440) % 1440;
    flipStart = startAgo > endAgo;
  }

  return flipStart
    ? { start: flipMeridiem24(start24), end: end24, changed: "start" }
    : { start: start24, end: flipMeridiem24(end24), changed: "end" };
}

export function to24hString(hour12, minute, meridiem) {
  let hour = hour12 % 12; // 12 -> 0
  if (meridiem === "PM") {
    hour += 12;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Break a canonical 24-hour "HH:MM" back into 12-hour display parts.
export function from24hString(hhmm) {
  if (typeof hhmm !== "string" || !hhmm.includes(":")) {
    return null;
  }
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) {
    return null;
  }
  const meridiem = h >= 12 ? "PM" : "AM";
  let hour12 = h % 12;
  if (hour12 === 0) {
    hour12 = 12;
  }
  return { hour12, minute: m, meridiem, text12: `${hour12}:${String(m).padStart(2, "0")}` };
}

export function createEmptyDraft() {
  return {
    workDate: formatDateKey(new Date()),
    benchNumber: "",
    // The admin picks the shift up front; it resolves the AM/PM of the entered
    // times and is stored as the job's authoritative shift. Night is the default
    // since it's the main shift.
    shift: "night",
    startTime: "",
    endTime: "",
    strapStart: "",
    strapEnd: "",
    pendingAmount: "",
    break15Checked: false,
    break24Checked: false,
    assignedWorkerIds: [],
    importRows: [],
    importLoadedAt: null,
    importJobId: null,
    entries: []
  };
}

export function getTotalAmount(entries) {
  return entries.reduce((total, entry) => total + entry.amount, 0);
}

export function createEntry(amount) {
  return {
    amount,
    timeLabel: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  };
}

function getWorkerCount(job) {
  const savedCount = Number(job?.workerCount);
  const selectedIds = Array.isArray(job?.assignedWorkerIds) ? job.assignedWorkerIds.length : 0;
  const selectedWorkers = Array.isArray(job?.assignedWorkers) ? job.assignedWorkers.length : 0;

  return Math.max(1, Math.floor(savedCount) || 0, selectedIds, selectedWorkers);
}

function calculatePerWorkerRate(totalUnits, netWorkedMinutes, workerCount) {
  const hoursWorked = netWorkedMinutes / 60;
  return hoursWorked > 0 ? totalUnits / hoursWorked / workerCount : 0;
}

export function createJobPayload({
  jobType,
  shift = "night",
  workDateValue,
  benchNumber,
  startTimeValue,
  endTimeValue,
  breakMinutes,
  strapMinutes = 0,
  strapStartValue = "",
  strapEndValue = "",
  totalAmount,
  importMetres = 0,
  entries,
  assignedWorkers
}) {
  const rawWorkedMinutes = calculateWorkedMinutes(startTimeValue, endTimeValue, workDateValue);

  if (rawWorkedMinutes === null || totalAmount <= 0) {
    return null;
  }

  const { start, end } = resolveShiftBounds(startTimeValue, endTimeValue, workDateValue);
  // Strap & brace happens outside the start/end window, so it is recorded but
  // NOT deducted from worked time. Worked time only removes breaks.
  const netWorkedMinutes = Math.max(rawWorkedMinutes - breakMinutes, 0);
  // A break that runs past the finish time comes out of the bracing instead.
  const adjustedStrapMinutes = adjustStrapForBreakOverflow(strapMinutes, breakMinutes, rawWorkedMinutes);
  const workers = Array.isArray(assignedWorkers) ? assignedWorkers : [];
  const workerCount = Math.max(workers.length, 1);
  // Trusses are measured in metres already; walls are measured in screws but
  // also carry the panels' lineal metres so total-metres reporting is accurate.
  const metres = jobType === "walls" ? importMetres : totalAmount;

  return {
    jobType,
    shift,
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    dayKey: formatDateKey(start),
    benchNumber: Number(benchNumber) || null,
    breakMinutes,
    strapMinutes: adjustedStrapMinutes,
    // Kept alongside strapMinutes purely so a later edit can re-populate the
    // strap start/end fields exactly, instead of only the computed duration.
    ...(strapStartValue ? { strapStart: strapStartValue } : {}),
    ...(strapEndValue ? { strapEnd: strapEndValue } : {}),
    rawWorkedMinutes,
    netWorkedMinutes,
    totalUnits: totalAmount,
    metres,
    workerCount,
    rate: calculatePerWorkerRate(totalAmount, netWorkedMinutes, workerCount),
    entries: entries.map((entry) => ({ ...entry })),
    ...(workers.length > 0
      ? {
          assignedWorkers: workers.map((worker) => ({ id: worker.id, name: worker.name })),
          assignedWorkerIds: workers.map((worker) => worker.id),
          assignedToLabel: workers.map((worker) => worker.name).join(" & ")
        }
      : {})
  };
}

// Work shifts, classified by a job's local start time. The day is fully
// partitioned so every job lands in exactly one shift. The 1:30pm–2pm gap
// between the stated morning/afternoon shifts is folded into the afternoon.
export const SHIFTS = [
  { key: "morning", label: "Morning", hint: "5:45a–1:30p" },
  { key: "afternoon", label: "Afternoon", hint: "2p–10p" },
  { key: "night", label: "Night", hint: "10p–5:45a" }
];

const NIGHT_START = 22 * 60; // 22:00
// Night runs 10pm–5:45am: a job that starts before 5:45am is the tail of that
// night shift (grouped with the previous evening's 10pm start).
const MORNING_START = 5 * 60 + 45; // 05:45
const AFTERNOON_START = 13 * 60 + 30; // 13:30 (folds the 1:30–2pm gap into afternoon)

// Fallback shift classification from the start time, for jobs saved before the
// admin picked the shift explicitly. New jobs carry `job.shift` directly.
export function getJobShift(job) {
  const start = new Date(job.startedAt);
  const minutes = start.getHours() * 60 + start.getMinutes();

  if (minutes >= NIGHT_START || minutes < MORNING_START) {
    return "night";
  }
  if (minutes < AFTERNOON_START) {
    return "morning";
  }
  return "afternoon";
}

// The authoritative shift of a job: the one the admin selected when logging it,
// falling back to the start-time classification for older jobs.
export function resolveJobShift(job) {
  return job.shift || getJobShift(job);
}

// Which AM/PM a bare 12-hour time takes for a given shift, so the admin never
// picks AM/PM — the selected shift decides it:
//   night     → 10 & 11 are PM (10–11pm); everything else (12, 1–9) is AM (12–5:45am)
//   morning   → 12 (noon) & 1 (1pm) are PM; 5:45–11am are AM
//   afternoon → always PM (2–10pm)
export function meridiemForShift(hour12, shift) {
  if (shift === "afternoon") {
    return "PM";
  }
  if (shift === "morning") {
    return hour12 === 12 || hour12 === 1 ? "PM" : "AM";
  }
  // night (default)
  return hour12 === 10 || hour12 === 11 ? "PM" : "AM";
}

// The day a job's shift belongs to. A night shift spans 10pm–5:45am, so night
// work logged after midnight (before the 5:45a boundary) is the tail of the
// previous evening's night shift and is attributed to that earlier day, keeping
// one night shift in a single day-column. The roll-back applies to night shifts
// only — a morning/afternoon job never moves to the previous day.
export function getShiftDayKey(job) {
  const start = new Date(job.startedAt);
  const minutes = start.getHours() * 60 + start.getMinutes();

  if (resolveJobShift(job) === "night" && minutes < MORNING_START) {
    const previousDay = new Date(start);
    previousDay.setDate(previousDay.getDate() - 1);
    return formatDateKey(previousDay);
  }
  return formatDateKey(start);
}

// Total amount produced in each shift across the given jobs. `getValue` selects
// the metric per job (screws via totalUnits, or lineal metres via metres).
export function aggregateShiftTotals(jobs, getValue = (job) => job.totalUnits) {
  const totals = new Map(SHIFTS.map((shift) => [shift.key, 0]));

  jobs.forEach((job) => {
    const key = resolveJobShift(job);
    totals.set(key, totals.get(key) + (Number(getValue(job)) || 0));
  });

  return {
    labels: SHIFTS.map((shift) => `${shift.label} (${shift.hint})`),
    values: SHIFTS.map((shift) => Number(totals.get(shift.key).toFixed(2)))
  };
}

// Daily amount per shift: one row per day, with a separate value for each
// shift (morning/afternoon/night). Lets you read how much each shift produced
// on each individual day, rather than one accumulated total per shift type.
export function aggregateShiftSeriesByDay(jobs, getValue = (job) => job.totalUnits) {
  const dayTotals = new Map();

  jobs.forEach((job) => {
    const shift = resolveJobShift(job);
    const dayKey = getShiftDayKey(job);
    const day = dayTotals.get(dayKey) ?? new Map(SHIFTS.map((s) => [s.key, 0]));
    day.set(shift, day.get(shift) + (Number(getValue(job)) || 0));
    dayTotals.set(dayKey, day);
  });

  const sortedKeys = Array.from(dayTotals.keys()).sort((a, b) => a.localeCompare(b));

  return {
    labels: sortedKeys.map(formatDateLabel),
    // Raw shift-day keys aligned with `labels`, so a clicked bar index maps
    // back to the exact day for drill-down.
    dayKeys: sortedKeys,
    shifts: SHIFTS.map((shift) => ({
      key: shift.key,
      label: shift.label,
      values: sortedKeys.map((dayKey) =>
        Number(dayTotals.get(dayKey).get(shift.key).toFixed(2))
      )
    }))
  };
}

// Rate (units per worker-hour) per shift: one row per shift-day, with a value
// for each shift (morning/afternoon/night). Overnight shifts cross midnight, so
// jobs are grouped by getShiftDayKey (which rolls early-morning work back to the
// previous evening) rather than by calendar day — keeping a night shift as one
// column. Rate = units / worker-hours within each shift.
export function aggregateShiftRateSeriesByDay(jobs) {
  const dayShift = new Map();

  jobs.forEach((job) => {
    const shift = resolveJobShift(job);
    const dayKey = getShiftDayKey(job);
    const day =
      dayShift.get(dayKey) ??
      new Map(SHIFTS.map((s) => [s.key, { units: 0, workerMinutes: 0 }]));
    const bucket = day.get(shift);
    bucket.units += Number(job.totalUnits) || 0;
    bucket.workerMinutes += (Number(job.netWorkedMinutes) || 0) * getWorkerCount(job);
    dayShift.set(dayKey, day);
  });

  const sortedKeys = Array.from(dayShift.keys()).sort((a, b) => a.localeCompare(b));

  return {
    labels: sortedKeys.map(formatDateLabel),
    // Raw shift-day keys aligned with `labels`, so a clicked bar index maps
    // back to the exact day for drill-down.
    dayKeys: sortedKeys,
    shifts: SHIFTS.map((shift) => ({
      key: shift.key,
      label: shift.label,
      values: sortedKeys.map((dayKey) => {
        const bucket = dayShift.get(dayKey).get(shift.key);
        const workerHours = bucket.workerMinutes / 60;
        const rate = workerHours > 0 ? bucket.units / workerHours : 0;
        return Number(rate.toFixed(2));
      })
    }))
  };
}

// Benches are a fixed roster numbered 1–19.
export const BENCH_NUMBERS = Array.from({ length: 19 }, (_, index) => index + 1);

// Amount produced on each bench, split by shift. One bench per x-axis slot,
// with a value for each shift (morning/afternoon/night) so you can read how
// much each shift did on a bench rather than one accumulated bench total.
export function aggregateBenchShiftTotals(jobs, getValue = (job) => job.totalUnits) {
  const benchTotals = new Map(
    BENCH_NUMBERS.map((bench) => [bench, new Map(SHIFTS.map((s) => [s.key, 0]))])
  );

  jobs.forEach((job) => {
    const bench = Number(job.benchNumber);
    if (!benchTotals.has(bench)) {
      return;
    }
    const shift = resolveJobShift(job);
    const perShift = benchTotals.get(bench);
    perShift.set(shift, perShift.get(shift) + (Number(getValue(job)) || 0));
  });

  return {
    labels: BENCH_NUMBERS.map((bench) => `Bench ${bench}`),
    shifts: SHIFTS.map((shift) => ({
      key: shift.key,
      label: shift.label,
      values: BENCH_NUMBERS.map((bench) =>
        Number(benchTotals.get(bench).get(shift.key).toFixed(2))
      )
    }))
  };
}

export function getRangeStartDate(days) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start;
}

export function aggregateHistorySeriesByDay(jobs) {
  const dailyTotals = new Map();

  jobs.forEach((job) => {
    const current = dailyTotals.get(job.dayKey) ?? {
      totalUnits: 0,
      totalWorkerMinutes: 0
    };

    current.totalUnits += job.totalUnits;
    current.totalWorkerMinutes += job.netWorkedMinutes * getWorkerCount(job);
    dailyTotals.set(job.dayKey, current);
  });

  const sortedKeys = Array.from(dailyTotals.keys()).sort((a, b) => a.localeCompare(b));

  return {
    labels: sortedKeys.map(formatDateLabel),
    totalValues: sortedKeys.map((key) => Number(dailyTotals.get(key).totalUnits.toFixed(2))),
    rateValues: sortedKeys.map((key) => {
      const day = dailyTotals.get(key);
      const workerHours = day.totalWorkerMinutes / 60;
      const rate = workerHours > 0 ? day.totalUnits / workerHours : 0;
      return Number(rate.toFixed(2));
    })
  };
}

export function normalizeJob(job) {
  const endedAt = typeof job.endedAt === "string" ? job.endedAt : new Date().toISOString();
  const jobType = job.jobType === "walls" ? "walls" : "trusses";
  const assignedWorkerIds = Array.isArray(job.assignedWorkerIds) ? job.assignedWorkerIds : [];
  const assignedWorkers = Array.isArray(job.assignedWorkers) ? job.assignedWorkers : [];
  const netWorkedMinutes = Number(job.netWorkedMinutes) || 0;
  const totalUnits = Number(job.totalUnits ?? job.totalMetres) || 0;
  // Older jobs predate the metres field: trusses' units are metres, while older
  // wall jobs simply have no recorded metres.
  const metres = Number(job.metres) || (jobType === "trusses" ? totalUnits : 0);
  const workerCount = Math.max(
    1,
    Math.floor(Number(job.workerCount)) || 0,
    assignedWorkerIds.length,
    assignedWorkers.length
  );

  const validShift = SHIFTS.some((entry) => entry.key === job.shift);

  return {
    ...job,
    jobType,
    // The admin's selected shift; older jobs (no stored shift) fall back to the
    // start-time classification so every job carries an authoritative shift.
    shift: validShift ? job.shift : getJobShift({ startedAt: job.startedAt || endedAt }),
    endedAt,
    dayKey: typeof job.dayKey === "string" && job.dayKey ? job.dayKey : formatDateKey(new Date(endedAt)),
    benchNumber: Number(job.benchNumber) || null,
    breakMinutes: Number(job.breakMinutes) || 0,
    strapMinutes: Number(job.strapMinutes) || 0,
    rawWorkedMinutes: Number(job.rawWorkedMinutes) || 0,
    netWorkedMinutes,
    totalUnits,
    metres,
    workerCount,
    rate: calculatePerWorkerRate(totalUnits, netWorkedMinutes, workerCount),
    entries: Array.isArray(job.entries)
      ? job.entries.map((entry) => ({
          amount: Number(entry.amount ?? entry.metres) || 0,
          timeLabel: entry.timeLabel ?? ""
        }))
      : [],
    assignedWorkerIds,
    assignedWorkers,
    assignedToLabel: typeof job.assignedToLabel === "string" ? job.assignedToLabel : "",
    // Hidden jobs are kept in the database but excluded from charts and stats.
    hidden: Boolean(job.hidden)
  };
}

// Most recently used worker combinations, for one-tap crew selection when
// logging a job. Crews are distinct by membership (order ignored); names are
// resolved against the current roster and crews containing a removed worker
// are skipped. When workers are already selected (`withIds`), only crews that
// include all of them are suggested — i.e. the selected workers' most recent
// partners — and the crew identical to the current selection is omitted.
export function deriveRecentCrews(jobs, workers, limit = 4, withIds = []) {
  const namesById = new Map(workers.map((worker) => [worker.id, worker.name]));
  const selectionKey = [...withIds].sort().join("|");
  const seen = new Set();
  const crews = [];

  const sorted = [...jobs].sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt));
  for (const job of sorted) {
    const ids = Array.isArray(job.assignedWorkerIds) ? job.assignedWorkerIds : [];
    if (ids.length === 0) {
      continue;
    }
    const key = [...ids].sort().join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!withIds.every((id) => ids.includes(id)) || key === selectionKey) {
      continue;
    }
    if (!ids.every((id) => namesById.has(id))) {
      continue;
    }
    crews.push({ ids: [...ids], label: ids.map((id) => namesById.get(id)).join(" & ") });
    if (crews.length >= limit) {
      break;
    }
  }

  return crews;
}

export function summarizeWorkerJobs(jobs) {
  const totals = jobs.reduce(
    (acc, job) => {
      const allocatedUnits = job.totalUnits / getWorkerCount(job);
      acc.jobs += 1;
      acc.netWorkedMinutes += job.netWorkedMinutes;
      acc.strapMinutes += job.strapMinutes;
      if (job.jobType === "walls") {
        acc.screws += allocatedUnits;
        acc.wallMinutes += job.netWorkedMinutes;
      } else {
        acc.metres += allocatedUnits;
        acc.trussMinutes += job.netWorkedMinutes;
      }
      return acc;
    },
    { jobs: 0, netWorkedMinutes: 0, strapMinutes: 0, metres: 0, screws: 0, trussMinutes: 0, wallMinutes: 0 }
  );

  totals.avgMetresPerHour = totals.trussMinutes > 0 ? totals.metres / (totals.trussMinutes / 60) : 0;
  totals.avgScrewsPerHour = totals.wallMinutes > 0 ? totals.screws / (totals.wallMinutes / 60) : 0;
  totals.avgStrapMinutes = totals.jobs > 0 ? totals.strapMinutes / totals.jobs : 0;
  return totals;
}
