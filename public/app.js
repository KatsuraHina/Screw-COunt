import {
  addPairRecord,
  addWorkerRecord,
  deletePairRecord,
  deleteWorkerRecord,
  formatFirestoreError,
  loadJobRecords,
  loadPairRecords,
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
  pairLabel,
  renderAuthState,
  renderCalculator,
  renderEntries,
  renderHistory,
  renderTabState,
  renderWorkerAdminVisibility,
  renderWorkerManagement,
  renderWorkerSelector,
  setStatus,
  setWorkerStatus
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
  pairs: [],
  isAdmin: false,
  charts: {
    total: null,
    rate: null
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
  draft.assignedWorkerValue = elements.workerSelect.value;
}

function loadDraftIntoInputs() {
  const draft = getActiveDraft();
  elements.workDateInput.value = draft.workDate;
  elements.startTimeInput.value = draft.startTime;
  elements.endTimeInput.value = draft.endTime;
  elements.amountInput.value = draft.pendingAmount;
  elements.break15Input.checked = draft.break15Checked;
  elements.break24Input.checked = draft.break24Checked;
  draft.assignedWorkerValue = renderWorkerSelector(
    elements,
    state.workers,
    state.pairs,
    draft.assignedWorkerValue
  );
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
    assignedTo: resolveAssignedTo(elements.workerSelect.value)
  });
}

function resolveAssignedTo(value) {
  if (!value) {
    return null;
  }

  const [type, id] = value.split(":");

  if (type === "w") {
    const worker = state.workers.find((item) => item.id === id);
    return worker ? { type: "worker", id: worker.id, label: worker.name } : null;
  }

  if (type === "p") {
    const pair = state.pairs.find((item) => item.id === id);
    return pair ? { type: "pair", id: pair.id, label: pairLabel(pair) } : null;
  }

  return null;
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
  state.isAdmin = isAdminUser(user);
  renderAuthState(elements, user);
  renderWorkerAdminVisibility(elements, state.isAdmin);
  loadSavedJobs();
  loadWorkersAndPairs();
}

function renderWorkersSection() {
  if (!state.isAdmin) {
    return;
  }

  renderWorkerManagement(elements, state.workers, state.pairs, {
    onRemoveWorker: removeWorker,
    onRemovePair: removePair
  });
  renderWorkerSelectorSection();
}

function renderWorkerSelectorSection() {
  const draft = getActiveDraft();
  draft.assignedWorkerValue = renderWorkerSelector(
    elements,
    state.workers,
    state.pairs,
    draft.assignedWorkerValue
  );
}

async function loadWorkersAndPairs() {
  if (!state.isAdmin || !state.currentUser) {
    state.workers = [];
    state.pairs = [];
    renderWorkerSelectorSection();
    return;
  }

  try {
    const [workers, pairs] = await Promise.all([
      loadWorkerRecords(state.currentUser),
      loadPairRecords(state.currentUser)
    ]);
    state.workers = workers.sort((a, b) => a.name.localeCompare(b.name));
    state.pairs = pairs.sort((a, b) => pairLabel(a).localeCompare(pairLabel(b)));
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
  const affectedPairs = state.pairs.filter(
    (pair) => pair.firstId === workerId || pair.secondId === workerId
  );

  try {
    await deleteWorkerRecord(workerId);
    await Promise.all(affectedPairs.map((pair) => deletePairRecord(pair.id)));
    state.workers = state.workers.filter((item) => item.id !== workerId);
    state.pairs = state.pairs.filter(
      (pair) => pair.firstId !== workerId && pair.secondId !== workerId
    );
    renderWorkersSection();
    setWorkerStatus(elements, worker ? `Removed ${worker.name}.` : "Worker removed.", "success");
  } catch (error) {
    console.error(error);
    setWorkerStatus(elements, formatFirestoreError(error), "warning");
  }
}

async function addPair() {
  const firstId = elements.pairFirstSelect.value;
  const secondId = elements.pairSecondSelect.value;

  if (!firstId || !secondId) {
    setWorkerStatus(elements, "Choose two workers to pair together.", "warning");
    return;
  }

  if (firstId === secondId) {
    setWorkerStatus(elements, "Pick two different workers to pair.", "warning");
    return;
  }

  const alreadyPaired = state.pairs.some(
    (pair) =>
      (pair.firstId === firstId && pair.secondId === secondId) ||
      (pair.firstId === secondId && pair.secondId === firstId)
  );

  if (alreadyPaired) {
    setWorkerStatus(elements, "Those workers are already paired.", "warning");
    return;
  }

  const first = state.workers.find((item) => item.id === firstId);
  const second = state.workers.find((item) => item.id === secondId);

  if (!first || !second) {
    setWorkerStatus(elements, "Could not find those workers. Refresh and try again.", "warning");
    return;
  }

  try {
    const pair = await addPairRecord(
      {
        firstId: first.id,
        firstName: first.name,
        secondId: second.id,
        secondName: second.name
      },
      state.currentUser
    );
    state.pairs.push(pair);
    state.pairs.sort((a, b) => pairLabel(a).localeCompare(pairLabel(b)));
    renderWorkersSection();
    setWorkerStatus(elements, `Paired ${pairLabel(pair)}.`, "success");
  } catch (error) {
    console.error(error);
    setWorkerStatus(elements, formatFirestoreError(error), "warning");
  }
}

async function removePair(pairId) {
  const pair = state.pairs.find((item) => item.id === pairId);

  try {
    await deletePairRecord(pairId);
    state.pairs = state.pairs.filter((item) => item.id !== pairId);
    renderWorkersSection();
    setWorkerStatus(elements, pair ? `Unpaired ${pairLabel(pair)}.` : "Pair removed.", "success");
  } catch (error) {
    console.error(error);
    setWorkerStatus(elements, formatFirestoreError(error), "warning");
  }
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
  elements.workerSelect.addEventListener("change", syncDraftFromInputs);
  elements.addWorkerButton.addEventListener("click", addWorker);
  elements.addPairButton.addEventListener("click", addPair);
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
