// The shared report: the Charts tab's jobs, the printer stats and the steel
// bay's cut breakdown, gathered into one workbook to send on.
//
// Everything here is plain data in, sheet definitions out, so the numbers can
// be checked without a browser.

import { SHIFT_BANDS } from "./printer-stats.js";
import { downloadXlsx } from "./xlsx.js";

const SHIFT_LABELS = { morning: "Morning", afternoon: "Afternoon", night: "Night" };

const hours = (minutes) => (Number(minutes) || 0) / 60;

// The roster's name wins over the one stored on the job, so fixing a spelling
// fixes it everywhere the worker appears, past jobs included.
function crewNames(job, namesById) {
  const resolved = (job.assignedWorkerIds || []).map((id) => namesById.get(id)).filter(Boolean);
  if (resolved.length > 0) {
    return resolved;
  }
  const named = (job.assignedWorkers || []).map((worker) => worker?.name).filter(Boolean);
  if (named.length > 0) {
    return named;
  }
  return job.assignedToLabel ? [job.assignedToLabel] : [];
}

// A job's output counts for the whole crew, so each worker is credited with
// their share — the same split the Charts tab shows.
const perWorker = (job) => (Number(job.totalUnits) || 0) / Math.max(1, job.workerCount || 1);

const isWalls = (job) => job.jobType === "walls";

// Trusses and walls are counted in different units and read as different work,
// so each gets its own sheet rather than a Type column to filter on. The job
// number sits second, right after the date, because that is what gets looked up.
function jobsSheet(name, jobs, namesById, walls) {
  const header = [
    "Date",
    "Job number",
    "Shift",
    "Bench",
    "Crew",
    "Workers",
    ...(walls ? ["Screws", "Metres"] : ["Metres"]),
    walls ? "Screws per worker/hr" : "Metres per worker/hr",
    "Hidden"
  ];

  const rows = jobs.map((job) => {
    const crew = crewNames(job, namesById);
    return [
      { date: job.dayKey },
      job.jobNumber || "",
      SHIFT_LABELS[job.shift] || job.shift || "",
      job.benchNumber || "",
      crew.join(", "),
      crew.length || job.workerCount || "",
      ...(walls
        ? [Number(job.totalUnits) || 0, Number(job.metres) || 0]
        : [Number(job.totalUnits) || 0]),
      Number(job.rate) || 0,
      job.hidden ? "Hidden" : ""
    ];
  });

  if (rows.length === 0) {
    return {
      name,
      rows: [header, [`No ${walls ? "wall" : "truss"} jobs in this period.`]],
      boldRows: [0]
    };
  }

  // Hidden jobs are listed but left out of the totals, the same as the charts.
  const visible = jobs.filter((job) => !job.hidden);
  const sum = (pick) => visible.reduce((total, job) => total + (Number(pick(job)) || 0), 0);
  const totals = [
    "Total",
    "",
    "",
    "",
    "",
    "",
    ...(walls ? [sum((job) => job.totalUnits), sum((job) => job.metres)] : [sum((job) => job.totalUnits)]),
    "",
    ""
  ];

  return { name, rows: [header, ...rows, totals], boldRows: [0, rows.length + 1] };
}

// Per worker, over the same jobs. Hidden jobs are left out, as they are in the
// charts — hiding a job is how a mistake is taken out of the numbers.
export function workerTotals(jobs, workers) {
  const namesById = new Map(workers.map((worker) => [worker.id, worker.name]));
  const totals = new Map();

  const bucket = (key, name) => {
    if (!totals.has(key)) {
      totals.set(key, { name, jobs: 0, hours: 0, metres: 0, screws: 0, trussHours: 0, wallHours: 0 });
    }
    return totals.get(key);
  };

  jobs
    .filter((job) => !job.hidden)
    .forEach((job) => {
      const ids = (job.assignedWorkerIds || []).filter(Boolean);
      const named = (job.assignedWorkers || []).filter((worker) => worker?.id || worker?.name);
      const crew =
        ids.length > 0
          ? ids.map((id) => ({ key: id, name: namesById.get(id) || "(removed worker)" }))
          : named.length > 0
            ? named.map((worker) => ({ key: worker.id || worker.name, name: worker.name }))
            : [{ key: "__none__", name: "(no crew recorded)" }];

      crew.forEach(({ key, name }) => {
        const row = bucket(key, name);
        row.jobs += 1;
        row.hours += hours(job.netWorkedMinutes);
        if (isWalls(job)) {
          row.screws += perWorker(job);
          row.wallHours += hours(job.netWorkedMinutes);
        } else {
          row.metres += perWorker(job);
          row.trussHours += hours(job.netWorkedMinutes);
        }
      });
    });

  return [...totals.values()].sort((a, b) => b.metres + b.screws - (a.metres + a.screws));
}

function workersSheet(jobs, workers) {
  const rows = workerTotals(jobs, workers);
  // Hours are still what the rates are worked out from; they just aren't a
  // column any more.
  const header = ["Worker", "Jobs", "Metres", "Screws", "Metres/hr", "Screws/hr"];
  const body = rows.map((row) => [
    row.name,
    row.jobs,
    row.metres,
    row.screws,
    row.trussHours > 0 ? row.metres / row.trussHours : "",
    row.wallHours > 0 ? row.screws / row.wallHours : ""
  ]);
  const totals = [
    "All",
    rows.reduce((sum, row) => sum + row.jobs, 0),
    rows.reduce((sum, row) => sum + row.metres, 0),
    rows.reduce((sum, row) => sum + row.screws, 0),
    "",
    ""
  ];
  return { name: "Workers", rows: [header, ...body, totals], boldRows: [0, body.length + 1] };
}

// Days with something in them, each kept apart. The one after the chosen day
// can only have its night as far as midnight, so it says so rather than
// pretending to a full night.
const printerDays = (printer) => (printer?.days || []).filter((day) => day.summary?.grand > 0);

function printerSheet(printer) {
  const rows = [];
  const bold = [];
  const days = printerDays(printer);

  if (days.length === 0) {
    rows.push(["No CSVs loaded on the Printer stats tab."]);
    return { name: "Printer stats", rows, boldRows: bold };
  }

  // A blank line between tables, but not between a day's heading and the
  // first table under it.
  let underHeading = false;
  const block = (title, entries, totalsRow, totalsLabel = "All") => {
    if (rows.length > 0 && !underHeading) {
      rows.push([]);
    }
    underHeading = false;
    bold.push(rows.length);
    rows.push([title, ...SHIFT_BANDS.map((band) => band.label), "Total"]);
    entries.forEach((entry) => rows.push([entry.name, ...entry.values, entry.total]));
    bold.push(rows.length);
    rows.push([totalsLabel, ...totalsRow.shiftTotals, totalsRow.grand]);
  };

  days.forEach((day) => {
    if (rows.length > 0) {
      rows.push([]);
    }
    bold.push(rows.length);
    rows.push([
      day.dateKey ? { date: day.dateKey } : "Day",
      day.partialNight ? "night to midnight only" : ""
    ]);
    underHeading = true;

    // Each roll former on its own, with the operators who ran it.
    (day.byLine || []).forEach(({ line, summary }) => {
      block(line, summary.operators, summary, `${line} total`);
    });

    // Then the day across all five, operator by operator and line by line —
    // skipped when only one line ran, where it would repeat that line's block.
    if ((day.byLine || []).length > 1) {
      block("Every line · operator", day.summary.operators, day.summary);
      block("Every line · line", day.summary.lines, day.summary);
    }
  });

  if (printer.files?.length) {
    rows.push([]);
    bold.push(rows.length);
    // Second column: a long file name in the first would stretch it for every
    // table on the sheet.
    rows.push(["Files read", printer.files[0]]);
    printer.files.slice(1).forEach((file) => rows.push(["", file]));
  }

  return { name: "Printer stats", rows, boldRows: bold };
}

function steelBaySheet(sheets) {
  const header = ["Date", "Cut by", "Job No.", "Dims", "Material", "Length", "Leftover", "Waste"];
  const body = [];

  sheets.forEach((day) => {
    (day.rows || []).forEach((row) => {
      body.push([
        { date: day.date },
        day.cutBy || "",
        row.jobNumber || "",
        row.dims || "",
        row.material || "",
        Number(row.length) || 0,
        Number(row.leftover) || 0,
        Number(row.waste) || 0
      ]);
    });
  });

  if (body.length === 0) {
    return {
      name: "Steel bay",
      rows: [header, ["No cut breakdown saved for these days."]],
      boldRows: [0]
    };
  }

  const totals = [
    "Total",
    "",
    "",
    "",
    "",
    body.reduce((sum, row) => sum + row[5], 0),
    "",
    body.reduce((sum, row) => sum + row[7], 0)
  ];

  return { name: "Steel bay", rows: [header, ...body, totals], boldRows: [0, body.length + 1] };
}

function summarySheet({ generatedAt, range, filters, jobs, printer, steelBay }) {
  const visible = jobs.filter((job) => !job.hidden);
  const metres = visible.reduce(
    (sum, job) => sum + (isWalls(job) ? Number(job.metres) || 0 : Number(job.totalUnits) || 0),
    0
  );
  const screws = visible.reduce((sum, job) => sum + (isWalls(job) ? Number(job.totalUnits) || 0 : 0), 0);
  const cut = steelBay.reduce(
    (sum, day) => sum + (day.rows || []).reduce((d, row) => d + (Number(row.length) || 0), 0),
    0
  );
  const waste = steelBay.reduce(
    (sum, day) => sum + (day.rows || []).reduce((d, row) => d + (Number(row.waste) || 0), 0),
    0
  );

  // Built row by row rather than as one literal, so a row that doesn't apply
  // can be left out without the bold headings sliding off their lines.
  const rows = [];
  const boldRows = [];
  const head = (text) => {
    boldRows.push(rows.length);
    rows.push([text]);
  };
  const line = (label, value) => rows.push([label, value]);
  const gap = () => rows.push([]);

  head("BBS Count");
  line("Generated", generatedAt);
  line("Period", range.label);
  // Left out when the period already names the shift ("This shift — …").
  if (filters.shift) {
    line("Shift", filters.shift);
  }

  gap();
  head("Jobs");
  // Counted the way they are now sheeted: trusses and walls apart.
  line("Trusses", visible.filter((job) => !isWalls(job)).length);
  line("Metres", metres);
  line("Walls", visible.filter(isWalls).length);
  line("Screws", screws);

  gap();
  head("Printer stats");
  const days = printerDays(printer);
  if (days.length === 0) {
    line("Metres run", "No CSVs loaded");
  }
  days.forEach((day) => {
    // Each day on its own, and its metres split across the shifts that ran.
    line(day.dateKey ? { date: day.dateKey } : "Day", day.partialNight ? "night to midnight only" : "");
    SHIFT_BANDS.forEach((band, index) => line(band.label, day.summary.shiftTotals[index]));
    line("Metres run", day.summary.grand);
  });

  gap();
  head("Steel bay");
  line("Days", steelBay.length);
  line("Cut (mm)", cut);
  line("Waste (mm)", waste);

  return { name: "Summary", freezeHeader: false, boldRows, rows };
}

// It all goes on one sheet: the summary at the top, then each section under
// its own heading, so the whole report reads top to bottom without anyone
// hunting through tabs.
export function buildReport(data) {
  const namesById = new Map((data.workers || []).map((worker) => [worker.id, worker.name]));
  const jobs = data.jobs || [];
  const sections = [
    summarySheet(data),
    jobsSheet("Trusses", jobs.filter((job) => !isWalls(job)), namesById, false),
    jobsSheet("Walls", jobs.filter(isWalls), namesById, true),
    workersSheet(data.jobs, data.workers || []),
    printerSheet(data.printer),
    steelBaySheet(data.steelBay || [])
  ];

  const rows = [];
  const boldRows = [];

  sections.forEach((section, index) => {
    // The summary leads with the report's own title, so it needs no heading of
    // its own; every section after it gets one, with a blank line above.
    if (index > 0) {
      rows.push([]);
      boldRows.push(rows.length);
      rows.push([section.name.toUpperCase()]);
    }
    const offset = rows.length;
    (section.boldRows || []).forEach((row) => boldRows.push(offset + row));
    section.rows.forEach((row) => rows.push(row));
  });

  return [{ name: "BBS Count", rows, boldRows, freezeHeader: false }];
}

export function reportFilename(generatedKey) {
  return `bbs-count-${generatedKey}.xlsx`;
}

export function exportReport(data) {
  downloadXlsx(reportFilename(data.generatedKey), buildReport(data));
}
