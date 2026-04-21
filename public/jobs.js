export const BREAK_15 = 15;
export const BREAK_24 = 24;

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

export function formatDateTime(date) {
  return date.toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit"
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

export function calculateWorkedMinutes(startTimeValue, endTimeValue) {
  if (!startTimeValue) {
    return null;
  }

  const now = new Date();
  const start = parseTimeAgainstReference(startTimeValue, now);
  const hasEndTime = Boolean(endTimeValue);
  const end = hasEndTime ? parseTimeAgainstReference(endTimeValue, now) : new Date(now);

  if (start > now) {
    start.setDate(start.getDate() - 1);
  }

  if (hasEndTime && end < start) {
    end.setDate(end.getDate() + 1);
  }

  return Math.floor((end - start) / 60000);
}

export function getTotalMetres(entries) {
  return entries.reduce((total, entry) => total + entry.metres, 0);
}

export function createMetreEntry(metres) {
  return {
    metres,
    timeLabel: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  };
}

export function createJobPayload({
  startTimeValue,
  endTimeValue,
  breakMinutes,
  totalMetres,
  entries
}) {
  const rawWorkedMinutes = calculateWorkedMinutes(startTimeValue, endTimeValue);

  if (rawWorkedMinutes === null || totalMetres <= 0) {
    return null;
  }

  const now = new Date();
  const start = parseTimeAgainstReference(startTimeValue, now);
  const end = endTimeValue ? parseTimeAgainstReference(endTimeValue, now) : new Date(now);

  if (start > now) {
    start.setDate(start.getDate() - 1);
  }

  if (end < start) {
    end.setDate(end.getDate() + 1);
  }

  const netWorkedMinutes = Math.max(rawWorkedMinutes - breakMinutes, 0);

  return {
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    dayKey: formatDateKey(end),
    breakMinutes,
    rawWorkedMinutes,
    netWorkedMinutes,
    totalMetres,
    rate: netWorkedMinutes > 0 ? totalMetres / (netWorkedMinutes / 60) : 0,
    entries: entries.map((entry) => ({ ...entry }))
  };
}

export function getRangeStartDate(days) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start;
}

export function aggregateJobsByDay(jobs) {
  const totals = new Map();

  jobs.forEach((job) => {
    const existing = totals.get(job.dayKey) ?? 0;
    totals.set(job.dayKey, existing + job.totalMetres);
  });

  const sortedKeys = Array.from(totals.keys()).sort((a, b) => a.localeCompare(b));

  return {
    labels: sortedKeys.map(formatDateLabel),
    values: sortedKeys.map((key) => Number(totals.get(key).toFixed(2)))
  };
}

export function aggregateHistorySeriesByDay(jobs) {
  const dailyTotals = new Map();

  jobs.forEach((job) => {
    const current = dailyTotals.get(job.dayKey) ?? {
      totalMetres: 0,
      totalWorkedMinutes: 0
    };

    current.totalMetres += job.totalMetres;
    current.totalWorkedMinutes += job.netWorkedMinutes;
    dailyTotals.set(job.dayKey, current);
  });

  const sortedKeys = Array.from(dailyTotals.keys()).sort((a, b) => a.localeCompare(b));

  return {
    labels: sortedKeys.map(formatDateLabel),
    metresValues: sortedKeys.map((key) => Number(dailyTotals.get(key).totalMetres.toFixed(2))),
    rateValues: sortedKeys.map((key) => {
      const day = dailyTotals.get(key);
      const hoursWorked = day.totalWorkedMinutes / 60;
      const rate = hoursWorked > 0 ? day.totalMetres / hoursWorked : 0;
      return Number(rate.toFixed(2));
    })
  };
}

export function normalizeJob(job) {
  const endedAt = typeof job.endedAt === "string" ? job.endedAt : new Date().toISOString();

  return {
    ...job,
    endedAt,
    dayKey: typeof job.dayKey === "string" && job.dayKey ? job.dayKey : formatDateKey(new Date(endedAt)),
    breakMinutes: Number(job.breakMinutes) || 0,
    rawWorkedMinutes: Number(job.rawWorkedMinutes) || 0,
    netWorkedMinutes: Number(job.netWorkedMinutes) || 0,
    totalMetres: Number(job.totalMetres) || 0,
    rate: Number(job.rate) || 0,
    entries: Array.isArray(job.entries) ? job.entries : []
  };
}
