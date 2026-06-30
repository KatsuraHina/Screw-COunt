import {
  addWorkerRecord,
  deleteJobRecord,
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
  calculateStrapMinutes,
  calculateWorkedMinutes,
  createEmptyDraft,
  createEntry,
  createJobPayload,
  formatDateKey,
  from24hString,
  getRangeStartDate,
  getTotalAmount,
  guessMeridiem,
  isAdminUser,
  normalizeJob,
  parseFlexibleTime,
  to24hString
} from "./jobs.js";
import { parseCutListPdf } from "./pdf-import.js";
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
  renderImportList,
  setActiveTabButtons,
  setImportLabels,
  setImportStatus,
  setImportVisible,
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
    selectedWorkerId: "all",
    charts: { metres: null, screws: null, trussMetresShift: null, wallMetresShift: null, screwsShift: null, benchMetres: null, benchScrews: null }
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

// How the imported cut list behaves per tab: trusses count lineal metres,
// walls count number of screws.
function getImportConfig() {
  if (state.activeTab === "walls") {
    return {
      value: (row) => row.screws,
      format: (value) => `${Math.round(value)} screws`,
      label: "Import panel list (PDF)",
      column: "No. of Screws"
    };
  }

  return {
    value: (row) => row.metres,
    format: (value) => `${value.toFixed(2)} m`,
    label: "Import truss list (PDF)",
    column: "Lineal M"
  };
}

// Ticked imported rows count toward the job as entries (number → metres/screws).
function getTickedImportEntries() {
  const draft = getActiveDraft();
  if (!Array.isArray(draft.importRows)) {
    return [];
  }

  const config = getImportConfig();
  return draft.importRows
    .filter((row) => row.done)
    .map((row) => ({ amount: config.value(row), timeLabel: row.number }));
}

function getCombinedEntries() {
  return [...getActiveDraft().entries, ...getTickedImportEntries()];
}

// Lineal metres from ticked import rows. Walls are measured in screws, but the
// panel PDF also lists each panel's Lineal M, so we record those metres too and
// feed them into the total-metres chart for an accurate company-wide total.
function getTickedImportMetres() {
  const draft = getActiveDraft();
  if (!Array.isArray(draft.importRows)) {
    return 0;
  }

  return draft.importRows
    .filter((row) => row.done)
    .reduce((sum, row) => sum + (Number(row.metres) || 0), 0);
}

// Maps each smart-time field to its input, AM/PM toggle, and draft key. The
// draft holds canonical 24-hour "HH:MM" so downstream calculations are
// unchanged; the text input shows the 12-hour value and the toggle the AM/PM.
const SMART_TIME_FIELDS = [
  { input: "startTimeInput", toggle: "startTimeMeridiem", key: "startTime" },
  { input: "endTimeInput", toggle: "endTimeMeridiem", key: "endTime" },
  { input: "strapStartInput", toggle: "strapStartMeridiem", key: "strapStart" },
  { input: "strapEndInput", toggle: "strapEndMeridiem", key: "strapEnd" }
];

// The smart-time fields are not synced here — their own handlers write the
// canonical 24-hour value straight into the draft as the user edits them.
function syncDraftFromInputs() {
  const draft = getActiveDraft();
  draft.workDate = elements.workDateInput.value;
  draft.benchNumber = elements.benchSelect.value;
  draft.pendingAmount = elements.amountInput.value;
  draft.break15Checked = elements.break15Input.checked;
  draft.break24Checked = elements.break24Input.checked;
}

// Show a draft's canonical 24-hour value as a 12-hour text + AM/PM toggle.
function renderSmartTimeField(input, toggle, value24) {
  const parts = from24hString(value24);
  if (!parts) {
    input.value = "";
    toggle.textContent = "AM";
    toggle.dataset.meridiem = "";
    toggle.disabled = true;
    return;
  }
  input.value = parts.text12;
  toggle.textContent = parts.meridiem;
  toggle.dataset.meridiem = parts.meridiem;
  toggle.disabled = false;
}

// Minutes-since-midnight of the computer's clock, used to anchor the AM/PM
// guess — but only for a job on today's date. For a back-dated job "now" is
// not a meaningful anchor, so return null and let the static map decide.
function meridiemNowContext(draft) {
  const today = formatDateKey(new Date());
  if (draft.workDate && draft.workDate !== today) {
    return null;
  }
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

// Parse a typed time, pick AM/PM (unless the input was explicit 24-hour), and
// store the canonical value back into the draft.
function applySmartTimeInput(input, toggle, key) {
  const draft = getActiveDraft();
  const parsed = parseFlexibleTime(input.value);
  if (!parsed) {
    draft[key] = "";
  } else {
    const meridiem =
      parsed.meridiem || guessMeridiem(parsed.hour12, parsed.minute, meridiemNowContext(draft));
    draft[key] = to24hString(parsed.hour12, parsed.minute, meridiem);
  }
  renderSmartTimeField(input, toggle, draft[key]);
}

function toggleSmartTimeMeridiem(input, toggle, key) {
  const draft = getActiveDraft();
  const parts = from24hString(draft[key]);
  if (!parts) {
    return;
  }
  const flipped = parts.meridiem === "AM" ? "PM" : "AM";
  draft[key] = to24hString(parts.hour12, parts.minute, flipped);
  renderSmartTimeField(input, toggle, draft[key]);
  renderCalculatorSection();
}

function loadDraftIntoInputs() {
  const draft = getActiveDraft();
  elements.workDateInput.value = draft.workDate;
  elements.benchSelect.value = draft.benchNumber;
  SMART_TIME_FIELDS.forEach(({ input, toggle, key }) => {
    renderSmartTimeField(elements[input], elements[toggle], draft[key]);
  });
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
  // The rate is per worker, so it changes as workers are added or removed.
  renderCalculatorSection();
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

function getStrapMinutes() {
  const draft = getActiveDraft();
  return calculateStrapMinutes(draft.strapStart, draft.strapEnd, draft.workDate);
}

function getCalculatorViewModel() {
  const draft = getActiveDraft();
  const rawWorkedMinutes = calculateWorkedMinutes(
    draft.startTime,
    draft.endTime,
    draft.workDate
  );
  const breakMinutes = getBreakMinutes();
  const strapMinutes = getStrapMinutes();
  const totalAmount = getTotalAmount(getCombinedEntries());

  if (rawWorkedMinutes === null) {
    return {
      hasStartTime: false,
      hasEndTime: Boolean(draft.endTime),
      breakMinutes,
      strapMinutes,
      totalAmount,
      netWorkedMinutes: 0,
      rate: 0,
      breaksExceedWorkedTime: false
    };
  }

  const lostMinutes = breakMinutes;
  const netWorkedMinutes = Math.max(rawWorkedMinutes - lostMinutes, 0);
  const hoursWorked = netWorkedMinutes / 60;
  const numWorkers = Math.max(getActiveDraft().assignedWorkerIds.length, 1);

  return {
    hasStartTime: true,
    hasEndTime: Boolean(draft.endTime),
    breakMinutes,
    strapMinutes,
    totalAmount,
    netWorkedMinutes,
    rate: hoursWorked > 0 ? totalAmount / hoursWorked / numWorkers : 0,
    breaksExceedWorkedTime: rawWorkedMinutes < lostMinutes
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
  renderImportSection();
  renderEntriesSection();
  renderCalculatorSection();

  if (showJobHistory) {
    renderHistorySection();
  }
}

// The PDF importer is admin-only, on both the Trusses and Walls tabs.
function renderImportSection() {
  const showImport = state.isAdmin && JOB_TYPES[state.activeTab];
  setImportVisible(elements, Boolean(showImport));

  if (showImport) {
    const config = getImportConfig();
    setImportLabels(elements, config.label, config.column);
    renderImportList(elements, getActiveDraft().importRows ?? [], config, toggleImportRow);
  }
}

function toggleImportRow(index, done) {
  const draft = getActiveDraft();
  if (draft.importRows && draft.importRows[index]) {
    draft.importRows[index].done = done;
    renderImportSection();
    renderCalculatorSection();
  }
}

async function handleImportFile(file) {
  if (!file) {
    return;
  }

  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    setImportStatus(elements, "Please choose a PDF file.", "warning");
    return;
  }

  setImportStatus(elements, "Reading PDF...");

  try {
    const rows = await parseCutListPdf(file);

    if (rows.length === 0) {
      setImportStatus(elements, "No rows found in that PDF.", "warning");
      return;
    }

    const config = getImportConfig();
    const noun = state.activeTab === "walls" ? "panels" : "trusses";
    getActiveDraft().importRows = rows.map((row) => ({ ...row, done: false }));
    renderImportSection();
    renderCalculatorSection();
    const total = rows.reduce((sum, row) => sum + config.value(row), 0);
    setImportStatus(
      elements,
      `Loaded ${rows.length} ${noun} (${config.format(total)} total). Tick the ones completed.`,
      "success"
    );
  } catch (error) {
    console.error(error);
    setImportStatus(elements, error.message || "Could not read that PDF.", "warning");
  }
}

function clearImport() {
  getActiveDraft().importRows = [];
  elements.trussFileInput.value = "";
  renderImportSection();
  renderCalculatorSection();
  setImportStatus(elements, "");
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

  const isAll = selectedId === "all";
  const worker = state.workers.find((item) => item.id === selectedId);
  const rangeStart = getRangeStartDate(Number(elements.workerRangeSelect.value));
  const benchFilter = elements.benchFilterSelect.value;
  const isAllBenches = benchFilter === "all";
  const jobs = state.savedJobs
    .filter((job) => new Date(job.endedAt) >= rangeStart)
    .filter((job) =>
      isAll ? job.assignedWorkerIds.length > 0 : job.assignedWorkerIds.includes(selectedId)
    )
    .filter((job) => isAllBenches || job.benchNumber === Number(benchFilter))
    .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt));

  state.workerHistory.charts = renderWorkerHistory(
    elements,
    jobs,
    isAll ? "" : worker ? worker.name : "",
    state.workerHistory.charts,
    { onRemoveJob: removeJob }
  );
}

async function removeJob(jobId) {
  if (!state.isAdmin) {
    return;
  }

  try {
    await deleteJobRecord(jobId);
    state.savedJobs = state.savedJobs.filter((job) => job.id !== jobId);
    renderWorkerHistoryView();
    renderHistorySection();
  } catch (error) {
    console.error(error);
    window.alert(formatFirestoreError(error));
  }
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
  const entries = getCombinedEntries();
  const totalAmount = getTotalAmount(entries);
  const breakMinutes = getBreakMinutes();
  const strapMinutes = getStrapMinutes();
  const config = getActiveConfig();

  if (!state.currentUser) {
    setStatus(elements, "Sign in before saving a job.", "warning");
    return null;
  }

  if (!draft.startTime) {
    setStatus(elements, "Enter a start time before ending and saving a job.", "warning");
    return null;
  }

  const benchNumber = Number(elements.benchSelect.value);
  if (!Number.isInteger(benchNumber) || benchNumber < 1 || benchNumber > 19) {
    setStatus(elements, "Select a bench (1–19) before ending and saving a job.", "warning");
    return null;
  }

  // Live count (empty end time = "now") only makes sense for a job happening
  // today. A forgotten/back-dated job must have an explicit end time.
  if (!draft.endTime && draft.workDate && draft.workDate !== formatDateKey(new Date())) {
    setStatus(elements, "Enter an end time for a past job — live count only works for today.", "warning");
    return null;
  }

  if (totalAmount <= 0) {
    setStatus(elements, config.saveWarning, "warning");
    return null;
  }

  return createJobPayload({
    jobType: state.activeTab,
    workDateValue: draft.workDate,
    benchNumber,
    startTimeValue: draft.startTime,
    endTimeValue: draft.endTime,
    breakMinutes,
    strapMinutes,
    totalAmount,
    importMetres: getTickedImportMetres(),
    entries,
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
    elements.benchSelect,
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

  // Smart 12-hour time fields: parse + guess AM/PM on edit, flip on toggle.
  SMART_TIME_FIELDS.forEach(({ input, toggle, key }) => {
    const inputEl = elements[input];
    const toggleEl = elements[toggle];
    inputEl.addEventListener("change", () => {
      applySmartTimeInput(inputEl, toggleEl, key);
      renderCalculatorSection();
    });
    toggleEl.addEventListener("click", () => toggleSmartTimeMeridiem(inputEl, toggleEl, key));
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
  elements.benchFilterSelect.addEventListener("change", renderWorkerHistoryView);

  // Truss PDF import: click/keyboard to browse, drag-and-drop, and clear.
  elements.trussDropzone.addEventListener("click", () => elements.trussFileInput.click());
  elements.trussDropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.trussFileInput.click();
    }
  });
  elements.trussFileInput.addEventListener("change", () => {
    handleImportFile(elements.trussFileInput.files[0]);
  });
  ["dragenter", "dragover"].forEach((type) => {
    elements.trussDropzone.addEventListener(type, (event) => {
      event.preventDefault();
      elements.trussDropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "dragend"].forEach((type) => {
    elements.trussDropzone.addEventListener(type, () => {
      elements.trussDropzone.classList.remove("is-dragover");
    });
  });
  elements.trussDropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.trussDropzone.classList.remove("is-dragover");
    handleImportFile(event.dataTransfer.files[0]);
  });
  elements.trussClearButton.addEventListener("click", clearImport);

  // Worker picker search: filter list live, clear search when picker closes,
  // and auto-focus the search box when it opens so typing filters immediately.
  elements.workerPickerSearch.addEventListener("input", renderWorkerPickerSection);
  elements.workerPicker.addEventListener("toggle", () => {
    if (elements.workerPicker.open) {
      elements.workerPickerSearch.focus();
    } else {
      elements.workerPickerSearch.value = "";
    }
  });

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
