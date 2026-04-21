import {
  formatFirestoreError,
  loadJobRecords,
  logoutCurrentUser,
  saveJobRecord,
  subscribeToAuthChanges
} from "./firebase-service.js";
import {
  calculateBreakMinutes,
  calculateWorkedMinutes,
  createJobPayload,
  createMetreEntry,
  getRangeStartDate,
  getTotalMetres,
  normalizeJob
} from "./jobs.js";
import {
  clearHistoryOutputs,
  getElements,
  renderAuthState,
  renderCalculator,
  renderHistory,
  renderMetreEntries,
  setStatus
} from "./ui.js";

const elements = getElements();
const state = {
  metreEntries: [],
  savedJobs: [],
  chart: null,
  currentUser: null
};

function parseMetresInput() {
  const metres = Number.parseFloat(elements.metresInput.value);
  return Number.isFinite(metres) ? metres : 0;
}

function getBreakMinutes() {
  return calculateBreakMinutes(elements.break15Input.checked, elements.break24Input.checked);
}

function getCalculatorViewModel() {
  const rawWorkedMinutes = calculateWorkedMinutes(
    elements.startTimeInput.value,
    elements.endTimeInput.value
  );
  const breakMinutes = getBreakMinutes();
  const metres = getTotalMetres(state.metreEntries);

  if (rawWorkedMinutes === null) {
    return {
      hasStartTime: false,
      hasEndTime: Boolean(elements.endTimeInput.value),
      breakMinutes,
      metres,
      netWorkedMinutes: 0,
      rate: 0,
      breaksExceedWorkedTime: false
    };
  }

  const netWorkedMinutes = Math.max(rawWorkedMinutes - breakMinutes, 0);
  const hoursWorked = netWorkedMinutes / 60;

  return {
    hasStartTime: true,
    hasEndTime: Boolean(elements.endTimeInput.value),
    breakMinutes,
    metres,
    netWorkedMinutes,
    rate: hoursWorked > 0 ? metres / hoursWorked : 0,
    breaksExceedWorkedTime: rawWorkedMinutes < breakMinutes
  };
}

function renderCalculatorSection() {
  renderCalculator(elements, getCalculatorViewModel());
}

function renderEntriesSection() {
  renderMetreEntries(elements, state.metreEntries, removeMetreEntry);
}

function getHistoryViewModel() {
  const rangeStart = getRangeStartDate(Number(elements.rangeSelect.value));
  const jobs = state.savedJobs.filter((job) => new Date(job.endedAt) >= rangeStart);
  const totalMetres = jobs.reduce((sum, job) => sum + job.totalMetres, 0);
  const dayTotals = new Map();

  jobs.forEach((job) => {
    dayTotals.set(job.dayKey, (dayTotals.get(job.dayKey) ?? 0) + job.totalMetres);
  });

  return {
    jobs,
    totalMetres,
    averagePerDay: dayTotals.size > 0 ? totalMetres / dayTotals.size : 0
  };
}

function renderHistorySection() {
  if (!state.currentUser) {
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    clearHistoryOutputs(elements);
    return;
  }

  state.chart = renderHistory(elements, getHistoryViewModel(), state.chart);
}

function renderApp() {
  renderEntriesSection();
  renderCalculatorSection();
  renderHistorySection();
}

function resetCurrentJob() {
  elements.startTimeInput.value = "";
  elements.endTimeInput.value = "";
  elements.metresInput.value = "";
  elements.break15Input.checked = false;
  elements.break24Input.checked = false;
  state.metreEntries = [];
  renderApp();
}

function removeMetreEntry(index) {
  state.metreEntries.splice(index, 1);
  renderApp();
}

function addMetresEntry() {
  const metres = parseMetresInput();

  if (metres <= 0) {
    setStatus(elements, "Enter a metres value greater than zero before adding it.", "warning");
    return;
  }

  state.metreEntries.push(createMetreEntry(metres));
  elements.metresInput.value = "";
  renderApp();
}

function createPendingJob() {
  const totalMetres = getTotalMetres(state.metreEntries);
  const breakMinutes = getBreakMinutes();

  if (!state.currentUser) {
    setStatus(elements, "Sign in before saving a job.", "warning");
    return null;
  }

  if (!elements.startTimeInput.value) {
    setStatus(elements, "Enter a start time before ending and saving a job.", "warning");
    return null;
  }

  if (totalMetres <= 0) {
    setStatus(elements, "Add some metres before ending and saving a job.", "warning");
    return null;
  }

  return createJobPayload({
    startTimeValue: elements.startTimeInput.value,
    endTimeValue: elements.endTimeInput.value,
    breakMinutes,
    totalMetres,
    entries: state.metreEntries
  });
}

async function saveJob() {
  const job = createPendingJob();

  if (!job) {
    return;
  }

  elements.endJobButton.disabled = true;
  elements.endJobButton.textContent = "Saving...";

  try {
    const savedJob = await saveJobRecord(job, state.currentUser);
    state.savedJobs.unshift(normalizeJob(savedJob));
    resetCurrentJob();
    renderHistorySection();
    setStatus(elements, "Job saved successfully. You can start the next one straight away.");
  } catch (error) {
    console.error(error);
    setStatus(elements, formatFirestoreError(error), "warning");
  } finally {
    elements.endJobButton.disabled = false;
    elements.endJobButton.textContent = "Job end";
  }
}

async function loadSavedJobs() {
  if (!state.currentUser) {
    state.savedJobs = [];
    renderHistorySection();
    return;
  }

  try {
    const jobs = await loadJobRecords(state.currentUser);
    state.savedJobs = jobs.map(normalizeJob);
    renderHistorySection();
  } catch (error) {
    console.error(error);
    setStatus(elements, formatFirestoreError(error), "warning");
    renderHistorySection();
  }
}

async function handleLogout() {
  try {
    await logoutCurrentUser();
  } catch (error) {
    console.error(error);
    setStatus(elements, "Could not log out right now. Try again.", "warning");
  }
}

function handleAuthChanged(user) {
  state.currentUser = user;
  renderAuthState(elements, user);
  loadSavedJobs();
}

function bindEvents() {
  [
    elements.startTimeInput,
    elements.endTimeInput,
    elements.break15Input,
    elements.break24Input
  ].forEach((element) => {
    element.addEventListener("input", renderCalculatorSection);
    element.addEventListener("change", renderCalculatorSection);
  });

  elements.addMetresButton.addEventListener("click", addMetresEntry);
  elements.endJobButton.addEventListener("click", saveJob);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.rangeSelect.addEventListener("change", renderHistorySection);
  elements.metresInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addMetresEntry();
    }
  });
}

function startLiveUpdates() {
  window.setInterval(renderCalculatorSection, 30000);
}

function init() {
  bindEvents();
  renderAuthState(elements, null);
  renderApp();
  subscribeToAuthChanges(handleAuthChanged);
  startLiveUpdates();
}

init();
