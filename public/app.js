import {
  addWorkerRecord,
  deleteWorkerRecord,
  formatFirestoreError,
  loadJobRecords,
  loadWorkerRecords,
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
  isAdminUser,
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
  renderWorkerAdminVisibility,
  renderWorkerHistory,
  renderWorkerHistorySelect,
  renderWorkerManagement,
  renderWorkerPicker,
  setActiveTabButtons,
  setStatus,
  setWorkerStatus,
  toggleWorkersView
} from "./ui.js";

const elements = getElements();
const state = {
  activeTab: "trusses",
  drafts: {
    trusses: createEmptyDraft(),
    walls: createEmptyDraft()
  },
  savedJobs: [],
  workers: [],
  isAdmin: false,
  charts: {
    total: null,
    rate: null
  },
  workerHistory: {
    selectedWorkerId: "",
    chart: null
  },
  currentUser: null,
  feedbackTimer: null
};

function getActiveConfig() {
  return JOB_TYPES[state.activeTab];
}

function getActiveDraft() {
  return state.drafts[state.activeTab];
}

function syncDraftFromInputs() {
  const draft = getActiveDraft();
  draft.workDate = elements.workDateInput.value;
  draft.startTime = elements.startTimeInput.value;
  draft.endTime = elements.endTimeInput.value;
  draft.pendingAmount = elements.amountInput.value;
  draft.break15Checked = elements.break15Input.checked;
  draft.break24Checked = elements.break24Input.checked;
}

function loadDraftIntoInputs() {
  const draft = getActiveDraft();
  elements.workDateInput.value = draft.workDate;
  elements.startTimeInput.value = draft.startTime;
  elements.endTimeInput.value = draft.endTime;
  elements.amountInput.value = draft.pendingAmount;
  elements.break15Input.checked = draft.break15Checked;
  elements.break24Input.checked = draft.break24Checked;
  renderWorkerPickerSection();
}

function renderWorkerPickerSection() {
  const draft = getActiveDraft();
  draft.assignedWorkerIds = renderWorkerPicker(
    elements,
    state.workers,
    draft.assignedWorkerIds,
    handleWorkerPickerChange
  );
}

function handleWorkerPickerChange(nextIds) {
  getActiveDraft().assignedWorkerIds = nextIds;
  renderWorkerPickerSection();
}

function parsePendingAmount() {
  const amount = Number.parseFloat(elements.amountInput.value);
  if (!Number.isFinite(amount)) {
    return 0;
  }

  return state.activeTab === "walls" ? Math.round(amount) : amount;
}

function formatAddedAmount(amount, config) {
  const value = config.key === "trusses" ? Number(amount.toFixed(2)) : Math.round(amount);
  return `${value} ${config.shortUnit}`;
}

function showAddFeedback(amount, config) {
  window.clearTimeout(state.feedbackTimer);
  elements.totalUnitsStat.classList.remove("stat-feedback");
  void elements.totalUnitsStat.offsetWidth;
  elements.totalUnitsStat.classList.add("stat-feedback");
  setStatus(elements, `Added ${formatAddedAmount(amount, config)}.`, "success");

  state.feedbackTimer = window.setTimeout(() => {
    elements.totalUnitsStat.classList.remove("stat-feedback");
  }, 900);
}

function getBreakMinutes() {
  return calculateBreakMinutes(elements.break15Input.checked, elements.break24Input.checked);
}

function getCalculatorViewModel() {
  const draft = getActiveDraft();
  const rawWorkedMinutes = calculateWorkedMinutes(
    elements.startTimeInput.value,
    elements.endTimeInput.value,
    elements.workDateInput.value
  );
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
  if (state.activeTab === "workers") {
    toggleWorkersView(elements, true, false);
    setActiveTabButtons(elements, state.activeTab);
    elements.activeTabLabel.textContent = "Charts";
    elements.tabTitle.textContent = "Worker history";
    elements.tabDescription.textContent = "Review each worker's logged jobs, hours, and output.";
    renderWorkerHistoryView();
    return;
  }

  // The admin doesn't use the per-job trusses/screw charts, so hide that panel for them.
  const showJobHistory = !state.isAdmin;
  toggleWorkersView(elements, false, showJobHistory);
  renderTabState(elements, getActiveConfig(), state.activeTab);
  loadDraftIntoInputs();
  renderEntriesSection();
  renderCalculatorSection();

  if (showJobHistory) {
    renderHistorySection();
  }
}

function renderWorkerHistoryView() {
  if (!state.isAdmin) {
    return;
  }

  const selectedId = renderWorkerHistorySelect(
    elements,
    state.workers,
    state.workerHistory.selectedWorkerId
  );
  state.workerHistory.selectedWorkerId = selectedId;

  const worker = state.workers.find((item) => item.id === selectedId);
  const rangeStart = getRangeStartDate(Number(elements.workerRangeSelect.value));
  const jobs = state.savedJobs
    .filter((job) => new Date(job.endedAt) >= rangeStart)
    .filter((job) => job.assignedWorkerIds.includes(selectedId))
    .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt));

  state.workerHistory.chart = renderWorkerHistory(
    elements,
    jobs,
    worker ? worker.name : "",
    state.workerHistory.chart
  );
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
  showAddFeedback(amount, config);
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
    workDateValue: elements.workDateInput.value,
    startTimeValue: elements.startTimeInput.value,
    endTimeValue: elements.endTimeInput.value,
    breakMinutes,
    totalAmount,
    entries: draft.entries,
    assignedWorkers: resolveAssignedWorkers(draft.assignedWorkerIds)
  });
}

function resolveAssignedWorkers(workerIds) {
  return workerIds
    .map((id) => state.workers.find((worker) => worker.id === id))
    .filter(Boolean)
    .map((worker) => ({ id: worker.id, name: worker.name }));
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
    elements.endJobButton.textContent = "End job";
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
    refreshActiveHistory();
  } catch (error) {
    console.error(error);
    setStatus(elements, formatFirestoreError(error), "warning");
    refreshActiveHistory();
  }
}

function refreshActiveHistory() {
  if (state.activeTab === "workers") {
    renderWorkerHistoryView();
  } else if (!state.isAdmin) {
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
  state.isAdmin = isAdminUser(user);
  renderAuthState(elements, user);
  renderWorkerAdminVisibility(elements, state.isAdmin);

  // The Charts tab is admin-only; fall back to the calculator if access is lost.
  if (!state.isAdmin && state.activeTab === "workers") {
    state.activeTab = "trusses";
  }

  // Re-render so admin-specific panel visibility (hidden trusses/screw charts) applies.
  renderApp();

  loadSavedJobs();
  loadWorkers();
}

function renderWorkersSection() {
  if (!state.isAdmin) {
    return;
  }

  renderWorkerManagement(elements, state.workers, {
    onRemoveWorker: removeWorker
  });
  renderWorkerPickerSection();

  if (state.activeTab === "workers") {
    renderWorkerHistoryView();
  }
}

async function loadWorkers() {
  if (!state.isAdmin || !state.currentUser) {
    state.workers = [];
    renderWorkerPickerSection();
    return;
  }

  try {
    const workers = await loadWorkerRecords(state.currentUser);
    state.workers = workers.sort((a, b) => a.name.localeCompare(b.name));
    renderWorkersSection();
  } catch (error) {
    console.error(error);
    setWorkerStatus(elements, formatFirestoreError(error), "warning");
  }
}

async function addWorker() {
  const name = elements.workerNameInput.value.trim();

  if (!name) {
    setWorkerStatus(elements, "Enter a worker name before adding.", "warning");
    return;
  }

  if (state.workers.some((worker) => worker.name.toLowerCase() === name.toLowerCase())) {
    setWorkerStatus(elements, `${name} is already on the list.`, "warning");
    return;
  }

  try {
    const worker = await addWorkerRecord(name, state.currentUser);
    state.workers.push(worker);
    state.workers.sort((a, b) => a.name.localeCompare(b.name));
    elements.workerNameInput.value = "";
    renderWorkersSection();
    setWorkerStatus(elements, `Added ${name}.`, "success");
  } catch (error) {
    console.error(error);
    setWorkerStatus(elements, formatFirestoreError(error), "warning");
  }
}

async function removeWorker(workerId) {
  const worker = state.workers.find((item) => item.id === workerId);

  try {
    await deleteWorkerRecord(workerId);
    state.workers = state.workers.filter((item) => item.id !== workerId);
    // Drop the removed worker from every tab's in-progress selection.
    Object.values(state.drafts).forEach((draft) => {
      draft.assignedWorkerIds = draft.assignedWorkerIds.filter((id) => id !== workerId);
    });
    renderWorkersSection();
    setWorkerStatus(elements, worker ? `Removed ${worker.name}.` : "Worker removed.", "success");
  } catch (error) {
    console.error(error);
    setWorkerStatus(elements, formatFirestoreError(error), "warning");
  }
}

function switchTab(nextTab) {
  if (nextTab === state.activeTab) {
    return;
  }

  if (nextTab === "workers") {
    if (!state.isAdmin) {
      return;
    }
  } else if (!JOB_TYPES[nextTab]) {
    return;
  }

  // Preserve any in-progress job before leaving a calculator tab.
  if (JOB_TYPES[state.activeTab]) {
    syncDraftFromInputs();
  }

  state.activeTab = nextTab;
  renderApp();
}

function bindEvents() {
  [
    elements.workDateInput,
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
  elements.addWorkerButton.addEventListener("click", addWorker);
  elements.workerNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addWorker();
    }
  });
  elements.addAmountButton.addEventListener("click", addEntry);
  elements.endJobButton.addEventListener("click", saveJob);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.rangeSelect.addEventListener("change", renderHistorySection);
  elements.workerHistorySelect.addEventListener("change", () => {
    state.workerHistory.selectedWorkerId = elements.workerHistorySelect.value;
    renderWorkerHistoryView();
  });
  elements.workerRangeSelect.addEventListener("change", renderWorkerHistoryView);
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
