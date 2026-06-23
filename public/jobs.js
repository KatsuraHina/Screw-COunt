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
    rateShortUnit: "m/worker/h",
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
    rateShortUnit: "screws/worker/h",
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
export function calculateStrapMinutes(strapStartValue, strapEndValue, workDateValue) {
  if (!strapStartValue || !strapEndValue) {
    return 0;
  }

  const reference = parseDateValue(workDateValue) ?? startOfReferenceDay(new Date());
  const start = parseTimeAgainstReference(strapStartValue, reference);
  const end = parseTimeAgainstReference(strapEndValue, reference);

  if (end < start) {
    end.setDate(end.getDate() + 1);
  }

  return Math.max(0, Math.floor((end - start) / 60000));
}

export function createEmptyDraft() {
  return {
    workDate: formatDateKey(new Date()),
    startTime: "",
    endTime: "",
    strapStart: "",
    strapEnd: "",
    pendingAmount: "",
    break15Checked: false,
    break24Checked: false,
    assignedWorkerIds: [],
    importRows: [],
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
  workDateValue,
  startTimeValue,
  endTimeValue,
  breakMinutes,
  strapMinutes = 0,
  totalAmount,
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
  const workers = Array.isArray(assignedWorkers) ? assignedWorkers : [];
  const workerCount = Math.max(workers.length, 1);

  return {
    jobType,
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    dayKey: formatDateKey(start),
    breakMinutes,
    strapMinutes,
    rawWorkedMinutes,
    netWorkedMinutes,
    totalUnits: totalAmount,
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
  const workerCount = Math.max(
    1,
    Math.floor(Number(job.workerCount)) || 0,
    assignedWorkerIds.length,
    assignedWorkers.length
  );

  return {
    ...job,
    jobType,
    endedAt,
    dayKey: typeof job.dayKey === "string" && job.dayKey ? job.dayKey : formatDateKey(new Date(endedAt)),
    breakMinutes: Number(job.breakMinutes) || 0,
    strapMinutes: Number(job.strapMinutes) || 0,
    rawWorkedMinutes: Number(job.rawWorkedMinutes) || 0,
    netWorkedMinutes,
    totalUnits,
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
    assignedToLabel: typeof job.assignedToLabel === "string" ? job.assignedToLabel : ""
  };
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
  return totals;
}
