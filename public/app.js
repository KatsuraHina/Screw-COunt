import {
  formatFirestoreError,
  loadJobRecords,
  logoutCurrentUser,
  saveJobRecord,
  subscribeToAuthChanges
} from "./firebase-service.js";
import {
  JOB_TYPES,
  calculateBreakMinutes,
  calculateWorkedMinutes,
  createEmptyDraft,
  createEntry,
  createJobPayload,
  getRangeStartDate,
  getTotalAmount,
  normalizeJob
} from "./jobs.js";
import {
  clearHistoryOutputs,
  getElements,
  renderAuthState,
  renderCalculator,
  renderEntries,
  renderHistory,
  renderTabState,
  setStatus
} from "./ui.js";

const elements = getElements();
const state = {
  activeTab: "trusses",
  drafts: {
    trusses: createEmptyDraft(),
    walls: createEmptyDraft()
  },
  savedJobs: [],
  charts: {
    total: null,
    rate: null
  },
  currentUser: null
};

function getActiveConfig() {
  return JOB_TYPES[state.activeTab];
}

function getActiveDraft() {
  return state.drafts[state.activeTab];
}

function syncDraftFromInputs() {
  const draft = getActiveDraft();
  draft.startTime = elements.startTimeInput.value;
  draft.endTime = elements.endTimeInput.value;
  draft.pendingAmount = elements.amountInput.value;
  draft.break15Checked = elements.break15Input.checked;
  draft.break24Checked = elements.break24Input.checked;
}

function loadDraftIntoInputs() {
  const draft = getActiveDraft();
  elements.startTimeInput.value = draft.startTime;
  elements.endTimeInput.value = draft.endTime;
  elements.amountInput.value = draft.pendingAmount;
  elements.break15Input.checked = draft.break15Checked;
  elements.break24Input.checked = draft.break24Checked;
}

function parsePendingAmount() {
  const amount = Number.parseFloat(elements.amountInput.value);
  if (!Number.isFinite(amount)) {
    return 0;
  }

  return state.activeTab === "walls" ? Math.round(amount) : amount;
}

function getBreakMinutes() {
  return calculateBreakMinutes(elements.break15Input.checked, elements.break24Input.checked);
}

function getCalculatorViewModel() {
  const draft = getActiveDraft();
  const rawWorkedMinutes = calculateWorkedMinutes(elements.startTimeInput.value, elements.endTimeInput.value);
  const breakMinutes = getBreakMinutes();
  const totalAmount = getTotalAmount(draft.entries);

  if (rawWorkedMinutes === null) {
    return {
      hasStartTime: false,
      hasEndTime: Boolean(elements.endTimeInput.value),
      breakMinutes,
      totalAmount,
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
    totalAmount,
    netWorkedMinutes,
    rate: hoursWorked > 0 ? totalAmount / hoursWorked : 0,
    breaksExceedWorkedTime: rawWorkedMinutes < breakMinutes
  };
}

function renderCalculatorSection() {
  renderCalculator(elements, getCalculatorViewModel(), getActiveConfig());
}

function renderEntriesSection() {
  renderEntries(elements, getActiveDraft().entries, getActiveConfig(), removeEntry);
}

function getHistoryJobs() {
  const rangeStart = getRangeStartDate(Number(elements.rangeSelect.value));

  return state.savedJobs.filter((job) => {
    const inRange = new Date(job.endedAt) >= rangeStart;
    return inRange && job.jobType === state.activeTab;
  });
}

function renderHistorySection() {
  if (!state.currentUser) {
    if (state.charts.total) {
      state.charts.total.destroy();
      state.charts.total = null;
    }

    if (state.charts.rate) {
      state.charts.rate.destroy();
      state.charts.rate = null;
    }

    clearHistoryOutputs();
    return;
  }

  state.charts = renderHistory(elements, getHistoryJobs(), state.charts, getActiveConfig());
}

function renderApp() {
  renderTabState(elements, getActiveConfig(), state.activeTab);
  loadDraftIntoInputs();
  renderEntriesSection();
  renderCalculatorSection();
  renderHistorySection();
}

function resetCurrentDraft() {
  state.drafts[state.activeTab] = createEmptyDraft();
  renderApp();
}

function removeEntry(index) {
  getActiveDraft().entries.splice(index, 1);
  renderApp();
}

function addEntry() {
  const amount = parsePendingAmount();
  const config = getActiveConfig();

  if (amount <= 0) {
    setStatus(elements, config.addWarning, "warning");
    return;
  }

  getActiveDraft().entries.push(createEntry(amount));
  getActiveDraft().pendingAmount = "";
  elements.amountInput.value = "";
  renderApp();
}

function createPendingJob() {
  const draft = getActiveDraft();
  const totalAmount = getTotalAmount(draft.entries);
  const breakMinutes = getBreakMinutes();
  const config = getActiveConfig();

  if (!state.currentUser) {
    setStatus(elements, "Sign in before saving a job.", "warning");
    return null;
  }

  if (!elements.startTimeInput.value) {
    setStatus(elements, "Enter a start time before ending and saving a job.", "warning");
    return null;
  }

  if (totalAmount <= 0) {
    setStatus(elements, config.saveWarning, "warning");
    return null;
  }

  return createJobPayload({
    jobType: state.activeTab,
    startTimeValue: elements.startTimeInput.value,
    endTimeValue: elements.endTimeInput.value,
    breakMinutes,
    totalAmount,
    entries: draft.entries
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
    resetCurrentDraft();
    renderHistorySection();
    setStatus(elements, `${getActiveConfig().label} job saved successfully. You can start the next one straight away.`);
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

function switchTab(nextTab) {
  if (!JOB_TYPES[nextTab] || nextTab === state.activeTab) {
    return;
  }

  syncDraftFromInputs();
  state.activeTab = nextTab;
  renderApp();
}

function bindEvents() {
  [
    elements.startTimeInput,
    elements.endTimeInput,
    elements.break15Input,
    elements.break24Input
  ].forEach((element) => {
    element.addEventListener("input", () => {
      syncDraftFromInputs();
      renderCalculatorSection();
    });
    element.addEventListener("change", () => {
      syncDraftFromInputs();
      renderCalculatorSection();
    });
  });

  elements.amountInput.addEventListener("input", syncDraftFromInputs);
  elements.addAmountButton.addEventListener("click", addEntry);
  elements.endJobButton.addEventListener("click", saveJob);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.rangeSelect.addEventListener("change", renderHistorySection);
  elements.amountInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addEntry();
    }
  });
  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.jobTab));
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
