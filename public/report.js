// The shared report: the Charts tab's jobs, the printer stats and the steel
// bay's cut breakdown, gathered into one workbook to send on.
//
// Everything here is plain data in, sheet definitions out, so the numbers can
// be checked without a browser.

import { SHIFT_BANDS } from "./printer-stats.js";
import { downloadXlsx } from "./xlsx.js";

const SHIFT_LABELS = { morning: "Morning", afternoon: "Afternoon", night: "Night" };

const hours = (minutes) => (Number(minutes) || 0) / 60;

function crewNames(job, namesById) {
  const named = (job.assignedWorkers || []).map((worker) => worker?.name).filter(Boolean);
  if (named.length > 0) {
    return named;
  }
  const resolved = (job.assignedWorkerIds || []).map((id) => namesById.get(id)).filter(Boolean);
  if (resolved.length > 0) {
    return resolved;
  }
  return job.assignedToLabel ? [job.assignedToLabel] : [];
}

// A job's output counts for the whole crew, so each worker is credited with
// their share — the same split the Charts tab shows.
const perWorker = (job) => (Number(job.totalUnits) || 0) / Math.max(1, job.workerCount || 1);

const isWalls = (job) => job.jobType === "walls";

function jobsSheet(jobs, namesById) {
  const header = [
    "Date",
    "Shift",
    "Type",
    "Job number",
    "Bench",
    "Crew",
    "Workers",
    "Worked (h)",
    "Break (min)",
    "Strap (min)",
    "Metres",
    "Screws",
    "Per worker/hr",
    "Hidden"
  ];

  const rows = jobs.map((job) => {
    const crew = crewNames(job, namesById);
    return [
      { date: job.dayKey },
      SHIFT_LABELS[job.shift] || job.shift || "",
      isWalls(job) ? "Walls" : "Trusses",
      job.jobNumber || "",
      job.benchNumber || "",
      crew.join(", "),
      crew.length || job.workerCount || "",
      hours(job.netWorkedMinutes),
      Number(job.breakMinutes) || 0,
      Number(job.strapMinutes) || 0,
      isWalls(job) ? Number(job.metres) || 0 : Number(job.totalUnits) || 0,
      isWalls(job) ? Number(job.totalUnits) || 0 : "",
      Number(job.rate) || 0,
      job.hidden ? "Hidden" : ""
    ];
  });

  const visible = jobs.filter((job) => !job.hidden);
  const totals = [
    "Total",
    "",
    "",
    "",
    "",
    "",
    "",
    visible.reduce((sum, job) => sum + hours(job.netWorkedMinutes), 0),
    visible.reduce((sum, job) => sum + (Number(job.breakMinutes) || 0), 0),
    visible.reduce((sum, job) => sum + (Number(job.strapMinutes) || 0), 0),
    visible.reduce((sum, job) => sum + (isWalls(job) ? Number(job.metres) || 0 : Number(job.totalUnits) || 0), 0),
    visible.reduce((sum, job) => sum + (isWalls(job) ? Number(job.totalUnits) || 0 : 0), 0),
    "",
    ""
  ];

  return {
    name: "Jobs",
    rows: [header, ...rows, totals],
    boldRows: [0, rows.length + 1]
  };
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
  const header = ["Worker", "Jobs", "Hours", "Metres", "Screws", "Metres/hr", "Screws/hr"];
  const body = rows.map((row) => [
    row.name,
    row.jobs,
    row.hours,
    row.metres,
    row.screws,
    row.trussHours > 0 ? row.metres / row.trussHours : "",
    row.wallHours > 0 ? row.screws / row.wallHours : ""
  ]);
  const totals = [
    "All",
    rows.reduce((sum, row) => sum + row.jobs, 0),
    rows.reduce((sum, row) => sum + row.hours, 0),
    rows.reduce((sum, row) => sum + row.metres, 0),
    rows.reduce((sum, row) => sum + row.screws, 0),
    "",
    ""
  ];
  return { name: "Workers", rows: [header, ...body, totals], boldRows: [0, body.length + 1] };
}

function printerSheet(printer) {
  const rows = [["Printer stats"], ["Day", printer?.workDate ? { date: printer.workDate } : "Not set"]];

  if (!printer || !printer.summary || printer.summary.grand === 0) {
    rows.push([], ["No CSVs loaded on the Printer stats tab."]);
    return { name: "Printer stats", rows, boldRows: [0], freezeHeader: false };
  }

  const { operators, lines, shiftTotals, grand } = printer.summary;
  const bold = [0];
  const block = (title, entries) => {
    rows.push([]);
    bold.push(rows.length);
    rows.push([title, ...SHIFT_BANDS.map((band) => band.label), "Total"]);
    entries.forEach((entry) => rows.push([entry.name, ...entry.values, entry.total]));
    bold.push(rows.length);
    rows.push(["All", ...shiftTotals, grand]);
  };

  block("Operator", operators);
  block("Line", lines);

  if (printer.files?.length) {
    rows.push([]);
    bold.push(rows.length);
    rows.push(["Files read"]);
    printer.files.forEach((file) => rows.push([file]));
  }

  return { name: "Printer stats", rows, boldRows: bold, freezeHeader: false };
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

  return {
    name: "Summary",
    freezeHeader: false,
    // The title and each section heading.
    boldRows: [0, 7, 14, 18],
    rows: [
      ["BBS Count"],
      ["Generated", generatedAt],
      ["Period", range.label],
      ["Worker", filters.worker],
      ["Bench", filters.bench],
      ["Shift", filters.shift],
      [],
      ["Jobs"],
      ["Logged", visible.length],
      ["Hidden", jobs.length - visible.length],
      ["Hours worked", visible.reduce((sum, job) => sum + hours(job.netWorkedMinutes), 0)],
      ["Metres", metres],
      ["Screws", screws],
      [],
      ["Printer stats"],
      ["Day", printer?.workDate ? { date: printer.workDate } : "No CSVs loaded"],
      ["Metres run", printer?.summary?.grand || 0],
      [],
      ["Steel bay"],
      ["Days", steelBay.length],
      ["Cut (mm)", cut],
      ["Waste (mm)", waste]
    ]
  };
}

export function buildReport(data) {
  const namesById = new Map((data.workers || []).map((worker) => [worker.id, worker.name]));
  return [
    summarySheet(data),
    jobsSheet(data.jobs, namesById),
    workersSheet(data.jobs, data.workers || []),
    printerSheet(data.printer),
    steelBaySheet(data.steelBay || [])
  ];
}

export function reportFilename(generatedKey) {
  return `bbs-count-${generatedKey}.xlsx`;
}

export function exportReport(data) {
  downloadXlsx(reportFilename(data.generatedKey), buildReport(data));
}
