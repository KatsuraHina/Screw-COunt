function getWorkerCount() {
  const selectedWorkers = document.querySelectorAll(
    "#workerPickerOptions input[type='checkbox']:checked"
  ).length;

  return Math.max(selectedWorkers, 1);
}

function getWorkedHours() {
  const workedTime = document.getElementById("workedTime")?.textContent ?? "";
  const match = workedTime.match(/(\d+)h\s+(\d+)m/);

  if (!match) {
    return 0;
  }

  return Number(match[1]) + Number(match[2]) / 60;
}

function getTotalUnits() {
  const totalText = document.getElementById("totalUnitsDisplay")?.textContent ?? "";
  const value = Number.parseFloat(totalText);
  return Number.isFinite(value) ? value : 0;
}

function getActiveJobType() {
  return document.querySelector(".tab-button.is-active")?.dataset.jobTab ?? "trusses";
}

function updateWorkerRate() {
  const rateLabel = document.getElementById("rateLabel");
  const rateOutput = document.getElementById("rate");

  if (!rateLabel || !rateOutput) {
    return;
  }

  const jobType = getActiveJobType();
  const isWalls = jobType === "walls";
  const totalUnits = getTotalUnits();
  const workedHours = getWorkedHours();
  const workers = getWorkerCount();
  const rate = workedHours > 0 ? totalUnits / workedHours / workers : 0;

  rateLabel.textContent = isWalls ? "Screws per worker per hour" : "Metres per worker per hour";
  rateOutput.textContent = `${rate.toFixed(2)} ${isWalls ? "screws/worker/h" : "m/worker/h"}`;
}

// app.js re-renders the calculator when times, entries, or selected workers change.
// This lightweight refresh keeps the displayed live rate per worker.
window.setInterval(updateWorkerRate, 1000);
window.addEventListener("load", updateWorkerRate);
