import {
  addWorkerRecord,
  deleteJobRecord,
  deleteWorkerRecord,
  formatFirestoreError,
  loadJobRecords,
  loadWorkerRecords,
  logoutCurrentUser,
  saveJobRecord,
  setJobHiddenRecord,
  subscribeToAuthChanges,
  updateJobRecord
} from "./firebase-service.js";
import {
  BREAK_15,
  BREAK_24,
  JOB_TYPES,
  adjustStrapForBreakOverflow,
  calculateBreakMinutes,
  calculateStrapMinutes,
  calculateWorkedMinutes,
  createEmptyDraft,
  createEntry,
  createJobPayload,
  deriveJobNumber,
  deriveRecentCrews,
  formatDateKey,
  from24hString,
  getRangeStartDate,
  getShiftDayKey,
  getTotalAmount,
  isAdminUser,
  meridiemForShift,
  normalizeJob,
  parseFlexibleTime,
  to24hString
} from "./jobs.js";
import { deriveImportTitle, detectJobTypeFromName, parseCutListPdf } from "./pdf-import.js";
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
  renderJobTypeToggle,
  renderShiftToggle,
  renderImportLibrary,
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
  // Remembers the last job type (trusses/walls) so leaving the Charts view
  // returns to the type you were logging.
  lastJobType: "trusses",
  // Whose imports are currently loaded in memory (see syncImportsForUser).
  importOwnerKey: null,
  // The logged job currently loaded into the Log job form for editing, or
  // null. { id, jobType, originalStrapMinutes }.
  editingJob: null,
  drafts: {
    trusses: createEmptyDraft(),
    walls: createEmptyDraft()
  },
  savedJobs: [],
  workers: [],
  importLibrary: {
    trusses: [],
    walls: []
  },
  isAdmin: false,
  charts: {
    total: null,
    rate: null
  },
  workerHistory: {
    selectedWorkerId: "all",
    showHidden: false,
    // Day drilled into by clicking a chart bar (shift-day key), or null for all.
    selectedDayKey: null,
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

function isEditingActiveTab() {
  return Boolean(state.editingJob && state.editingJob.jobType === state.activeTab);
}

// Shows/hides the "Editing a logged job" banner and swaps the End job button's
// label to match, for the active job-type tab.
function renderEditBanner() {
  const editing = isEditingActiveTab();
  elements.editBanner.classList.toggle("hidden", !editing);
  elements.endJobButton.textContent = editing ? "Save changes" : "End job";
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
  { input: "endTimeInput", toggle: "endTimeMeridiem", key: "endTime" }
];

// Strap & brace is entered as a plain start/end without AM/PM — the duration is
// read on a 12-hour dial (see calculateStrapMinutes), so it skips the smart-time
// machinery above and is synced/bound as a plain input.

// The smart-time fields are not synced here — their own handlers write the
// canonical 24-hour value straight into the draft as the user edits them.
function syncDraftFromInputs() {
  const draft = getActiveDraft();
  draft.workDate = elements.workDateInput.value;
  draft.benchNumber = elements.benchSelect.value;
  draft.pendingAmount = elements.amountInput.value;
  draft.break15Checked = elements.break15Input.checked;
  draft.break24Checked = elements.break24Input.checked;
  // Strap times are plain (no AM/PM), so they're synced here rather than by the
  // smart-time handlers.
  draft.strapStart = elements.strapStartInput.value;
  draft.strapEnd = elements.strapEndInput.value;
}

// Show a draft's canonical 24-hour value as 12-hour text plus a read-only AM/PM
// indicator. The AM/PM comes from the selected shift, not a manual toggle.
function renderSmartTimeField(input, indicator, value24) {
  const parts = from24hString(value24);
  if (!parts) {
    input.value = "";
    indicator.textContent = "AM";
    indicator.classList.add("is-empty");
    return;
  }
  input.value = parts.text12;
  indicator.textContent = parts.meridiem;
  indicator.classList.remove("is-empty");
}

// Parse a typed time and store its canonical 24-hour value in the draft. AM/PM
// is decided by the selected shift (unless the input was an explicit 24-hour
// time, which already carries its own meridiem).
function applySmartTimeInput(input, indicator, key) {
  const draft = getActiveDraft();
  const parsed = parseFlexibleTime(input.value);
  if (!parsed) {
    draft[key] = "";
  } else {
    const meridiem = parsed.meridiem || meridiemForShift(parsed.hour12, draft.shift);
    draft[key] = to24hString(parsed.hour12, parsed.minute, meridiem);
  }
  renderSmartTimeField(input, indicator, draft[key]);
}

// When the shift changes, re-resolve the AM/PM of any already-entered start/end
// times to the new shift (the clock values are kept; only AM/PM follows).
function reapplyShiftToTimes() {
  const draft = getActiveDraft();
  ["startTime", "endTime"].forEach((key) => {
    const parts = from24hString(draft[key]);
    if (!parts) {
      return;
    }
    const meridiem = meridiemForShift(parts.hour12, draft.shift);
    draft[key] = to24hString(parts.hour12, parts.minute, meridiem);
  });
}

function handleShiftChange(shift) {
  const draft = getActiveDraft();
  if (draft.shift === shift) {
    return;
  }
  draft.shift = shift;
  reapplyShiftToTimes();
  renderShiftToggle(elements, shift);
  SMART_TIME_FIELDS.forEach(({ input, toggle, key }) => {
    renderSmartTimeField(elements[input], elements[toggle], draft[key]);
  });
  renderCalculatorSection();
}

function loadDraftIntoInputs() {
  const draft = getActiveDraft();
  elements.workDateInput.value = draft.workDate;
  elements.benchSelect.value = draft.benchNumber;
  SMART_TIME_FIELDS.forEach(({ input, toggle, key }) => {
    renderSmartTimeField(elements[input], elements[toggle], draft[key]);
  });
  elements.strapStartInput.value = draft.strapStart;
  elements.strapEndInput.value = draft.strapEnd;
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
    handleWorkerPickerChange,
    deriveRecentCrews(state.savedJobs, state.workers, 4, draft.assignedWorkerIds)
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
  return calculateStrapMinutes(draft.strapStart, draft.strapEnd);
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
  // A break that runs past the finish time is taken out of the bracing instead.
  const adjustedStrapMinutes = adjustStrapForBreakOverflow(strapMinutes, breakMinutes, rawWorkedMinutes);

  return {
    hasStartTime: true,
    hasEndTime: Boolean(draft.endTime),
    breakMinutes,
    strapMinutes: adjustedStrapMinutes,
    totalAmount,
    netWorkedMinutes,
    rate: hoursWorked > 0 ? totalAmount / hoursWorked / numWorkers : 0,
    breaksExceedWorkedTime: rawWorkedMinutes < lostMinutes,
    strapAbsorbedBreak: adjustedStrapMinutes < strapMinutes
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
  renderJobTypeToggle(elements, state.activeTab);
  renderShiftToggle(elements, getActiveDraft().shift);
  renderEditBanner();
  loadDraftIntoInputs();
  renderImportSection();
  renderEntriesSection();
  renderCalculatorSection();

  if (showJobHistory) {
    renderHistorySection();
  }
}

// Preloaded import lists live in localStorage so the admin can load the day's
// PDF ahead of time and still have it after a reload. A list only lasts one
// shift (8 hours) from when it was imported, then it must be imported again.
//
// Storage is namespaced per signed-in user so imports stay private — one
// person (including the admin) never sees another user's imports on a shared
// device.
const IMPORT_STORE_PREFIX = "screwcount.importList.";
const IMPORT_LIB_PREFIX = "screwcount.importJobs.";
const IMPORT_MAX_AGE_MS = 8 * 60 * 60 * 1000;

// Identifies whose imports these are. Falls back to "anon" before sign-in.
function importUserKey() {
  return state.currentUser?.uid || state.currentUser?.email || "anon";
}

function importListKey(tab) {
  return `${IMPORT_STORE_PREFIX}${importUserKey()}.${tab}`;
}

function importLibraryKey(tab) {
  return `${IMPORT_LIB_PREFIX}${importUserKey()}.${tab}`;
}

function persistImportRows(tab) {
  const draft = state.drafts[tab];
  try {
    if (Array.isArray(draft.importRows) && draft.importRows.length > 0) {
      localStorage.setItem(
        importListKey(tab),
        JSON.stringify({
          loadedAt: draft.importLoadedAt ?? Date.now(),
          jobId: draft.importJobId ?? null,
          rows: draft.importRows
        })
      );
    } else {
      localStorage.removeItem(importListKey(tab));
    }
  } catch {
    // Storage unavailable (private mode etc.) — the list just won't persist.
  }
}

function restoreImportRows() {
  Object.keys(JOB_TYPES).forEach((tab) => {
    try {
      const raw = localStorage.getItem(importListKey(tab));
      if (!raw) {
        return;
      }
      const stored = JSON.parse(raw);
      if (!stored || !Array.isArray(stored.rows) || !Number.isFinite(stored.loadedAt)) {
        throw new Error("bad stored import");
      }
      if (Date.now() - stored.loadedAt > IMPORT_MAX_AGE_MS) {
        localStorage.removeItem(importListKey(tab));
        return;
      }
      state.drafts[tab].importRows = stored.rows.map((row) => ({ ...row }));
      state.drafts[tab].importLoadedAt = stored.loadedAt;
      state.drafts[tab].importJobId = stored.jobId ?? null;
    } catch {
      try {
        localStorage.removeItem(importListKey(tab));
      } catch {
        // ignore
      }
    }
  });
}

// The preloaded-jobs library: each imported PDF is kept as a reusable job
// ({ id, title, loadedAt, rows }) so the admin can load the day's sheets ahead
// of time and just tap one later. Each job lasts one shift (8 hours) from its
// own import, survives End job, and is removed manually or on expiry.
function persistImportLibrary(tab) {
  const jobs = state.importLibrary[tab] ?? [];
  try {
    if (jobs.length > 0) {
      localStorage.setItem(importLibraryKey(tab), JSON.stringify(jobs));
    } else {
      localStorage.removeItem(importLibraryKey(tab));
    }
  } catch {
    // Storage unavailable (private mode etc.) — the library just won't persist.
  }
}

function restoreImportLibrary() {
  Object.keys(JOB_TYPES).forEach((tab) => {
    try {
      const raw = localStorage.getItem(importLibraryKey(tab));
      if (!raw) {
        return;
      }
      const stored = JSON.parse(raw);
      if (!Array.isArray(stored)) {
        throw new Error("bad stored library");
      }
      const now = Date.now();
      state.importLibrary[tab] = stored
        .filter(
          (job) =>
            job &&
            typeof job.id === "string" &&
            Array.isArray(job.rows) &&
            Number.isFinite(job.loadedAt) &&
            now - job.loadedAt <= IMPORT_MAX_AGE_MS
        )
        .map((job) => ({
          id: job.id,
          title: job.title || "Imported list",
          loadedAt: job.loadedAt,
          rows: job.rows.map((row) => ({ ...row }))
        }));
      persistImportLibrary(tab);
    } catch {
      try {
        localStorage.removeItem(importLibraryKey(tab));
      } catch {
        // ignore
      }
    }
  });
}

// Imports are per-user. When the signed-in user changes, drop the previous
// user's in-memory imports and restore this user's own from their namespace.
// Admins get their preloaded-jobs library; everyone gets their single active
// list. Keeps imports private across users on a shared device.
function syncImportsForUser() {
  const key = importUserKey();
  if (key === state.importOwnerKey) {
    return;
  }
  state.importOwnerKey = key;

  Object.keys(JOB_TYPES).forEach((tab) => {
    state.importLibrary[tab] = [];
    const draft = state.drafts[tab];
    draft.importRows = [];
    draft.importLoadedAt = null;
    draft.importJobId = null;
  });

  if (state.isAdmin) {
    restoreImportLibrary();
  }
  restoreImportRows();
}

// Drop jobs older than one shift; returns true if anything expired so the
// caller can also unload a now-gone active list.
function pruneImportLibrary(tab) {
  const jobs = state.importLibrary[tab] ?? [];
  const now = Date.now();
  const fresh = jobs.filter((job) => now - job.loadedAt <= IMPORT_MAX_AGE_MS);
  if (fresh.length !== jobs.length) {
    state.importLibrary[tab] = fresh;
    persistImportLibrary(tab);
    return true;
  }
  return false;
}

// The preloaded-jobs list is shown as one merged list across both job types.
// Each entry carries its `type` so selecting it can switch the job type and
// flip the rate between metres/hour and screws/hour.
function getMergedImportLibrary() {
  return Object.keys(JOB_TYPES)
    .flatMap((type) => (state.importLibrary[type] ?? []).map((job) => ({ ...job, type })))
    .sort((a, b) => b.loadedAt - a.loadedAt);
}

// Shift/crew details that belong to a job regardless of its type. When an
// imported job of the OTHER type is picked, these carry over so nothing the
// admin already entered disappears. Type-specific fields (metres/screws
// amounts, entries, import rows) are not carried.
const SHARED_SHIFT_KEYS = [
  "shift",
  "workDate",
  "startTime",
  "endTime",
  "break15Checked",
  "break24Checked",
  "strapStart",
  "strapEnd",
  "benchNumber",
  "assignedWorkerIds"
];

// Copy the shared shift/crew details from one draft to another (arrays cloned
// so the two drafts don't alias). Type-specific fields (amounts, entries,
// import rows) are left untouched.
function carryShiftDetails(fromDraft, toDraft) {
  SHARED_SHIFT_KEYS.forEach((key) => {
    toDraft[key] = Array.isArray(fromDraft[key]) ? [...fromDraft[key]] : fromDraft[key];
  });
}

// Load a preloaded job's rows into the checklist, replacing whatever is there
// with a fresh (unticked) copy so nothing double-counts. If the job is of the
// other type, switch the job type first (so metres/screws and the rate follow)
// while carrying over the shared shift/crew details already entered.
function selectImportJob(type, id) {
  const job = (state.importLibrary[type] ?? []).find((entry) => entry.id === id);
  if (!job) {
    return;
  }

  const targetDraft = state.drafts[type];

  if (type !== state.activeTab) {
    // Carry the shared shift/crew details from the job we're leaving so the
    // admin doesn't lose what they entered when the picked job is a different
    // type. renderApp() then repaints the form for the new type.
    if (JOB_TYPES[state.activeTab]) {
      syncDraftFromInputs();
      carryShiftDetails(getActiveDraft(), targetDraft);
    }
    state.activeTab = type;
    state.lastJobType = type;
  }

  targetDraft.importRows = job.rows.map((row) => ({ ...row, done: false }));
  targetDraft.importLoadedAt = job.loadedAt;
  targetDraft.importJobId = job.id;
  persistImportRows(type);

  renderApp();
  setImportStatus(elements, `Loaded "${job.title}". Tick the ones completed.`, "success");
}

// Remove a preloaded job from the library. If it is the one currently loaded,
// unload its checklist too.
function removeImportJob(type, id) {
  state.importLibrary[type] = (state.importLibrary[type] ?? []).filter((entry) => entry.id !== id);
  persistImportLibrary(type);

  const draft = state.drafts[type];
  if (draft.importJobId === id) {
    draft.importRows = [];
    draft.importLoadedAt = null;
    draft.importJobId = null;
    persistImportRows(type);
  }
  renderImportSection();
  if (type === state.activeTab) {
    renderCalculatorSection();
  }
}

// The PDF importer is available to everyone (admins and workers) on both the
// Trusses and Walls tabs.
function renderImportSection() {
  const showImport = Boolean(JOB_TYPES[state.activeTab]);
  setImportVisible(elements, showImport);

  if (showImport) {
    const draft = getActiveDraft();
    // The preloaded-jobs library is admin-only; workers keep just one import at
    // a time. Only admins prune the library.
    if (state.isAdmin) {
      Object.keys(JOB_TYPES).forEach((type) => pruneImportLibrary(type));
    }

    // The active checklist also expires one shift after it was loaded, or (for
    // admins) when the job it came from is no longer in the library.
    const activeExpired =
      draft.importRows.length > 0 &&
      draft.importLoadedAt &&
      Date.now() - draft.importLoadedAt > IMPORT_MAX_AGE_MS;
    const activeJobGone =
      state.isAdmin &&
      draft.importJobId &&
      !(state.importLibrary[state.activeTab] ?? []).some((job) => job.id === draft.importJobId);
    if (activeExpired || activeJobGone) {
      draft.importRows = [];
      draft.importLoadedAt = null;
      draft.importJobId = null;
      persistImportRows(state.activeTab);
      if (activeExpired) {
        setImportStatus(elements, "Imported list expired after one shift (8 hours) — import the PDF again.", "warning");
      }
    }

    const config = getImportConfig();
    setImportLabels(elements, config.label, config.column);
    if (state.isAdmin) {
      renderImportLibrary(elements, getMergedImportLibrary(), state.activeTab, draft.importJobId, {
        onSelect: selectImportJob,
        onRemove: removeImportJob
      });
    } else {
      // Non-admins have no library — keep it hidden.
      elements.importLibrary.classList.add("hidden");
    }
    renderImportList(elements, draft.importRows ?? [], config, toggleImportRow);
  }
}

function toggleImportRow(index, done) {
  const draft = getActiveDraft();
  if (draft.importRows && draft.importRows[index]) {
    draft.importRows[index].done = done;
    persistImportRows(state.activeTab);
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
    const { rows, jobType: contentJobType } = await parseCutListPdf(file);

    if (rows.length === 0) {
      setImportStatus(elements, "No rows found in that PDF.", "warning");
      return;
    }

    // The job title tells us what the PDF is: wall packs carry "PACK", truss
    // jobs carry "TRUSS" (filename checked first, then the PDF's title text).
    // If it belongs on the other tab, switch there and import into that tab.
    const detectedJobType = detectJobTypeFromName(file.name) || contentJobType;
    let switchNote = "";
    if (JOB_TYPES[detectedJobType] && detectedJobType !== state.activeTab) {
      switchTab(detectedJobType);
      switchNote =
        detectedJobType === "walls"
          ? "Wall pack PDF detected — switched to Walls. "
          : "Truss PDF detected — switched to Trusses. ";
    }

    const config = getImportConfig();
    const noun = state.activeTab === "walls" ? "panels" : "trusses";
    const tab = state.activeTab;
    const total = rows.reduce((sum, row) => sum + config.value(row), 0);

    if (!state.isAdmin) {
      // Non-admins keep just one import at a time — a new PDF replaces the
      // current checklist (no preloaded-jobs library).
      const draft = getActiveDraft();
      draft.importRows = rows.map((row) => ({ ...row, done: false }));
      draft.importLoadedAt = Date.now();
      draft.importJobId = null;
      persistImportRows(tab);
      renderImportSection();
      renderCalculatorSection();
      setImportStatus(
        elements,
        `${switchNote}Loaded ${rows.length} ${noun} (${config.format(total)} total). Tick the ones completed.`,
        "success"
      );
      return;
    }

    const title = deriveImportTitle(file.name);
    const id = title.toLowerCase();
    const job = { id, title, loadedAt: Date.now(), rows: rows.map((row) => ({ ...row })) };

    // Same PDF imported again just refreshes the existing entry (import once).
    const library = state.importLibrary[tab] ?? [];
    const existingIndex = library.findIndex((entry) => entry.id === id);
    const alreadyThere = existingIndex >= 0;
    if (alreadyThere) {
      library[existingIndex] = job;
    } else {
      library.unshift(job);
    }
    state.importLibrary[tab] = library;
    persistImportLibrary(tab);

    // Load it straight away so it's ready to tick.
    selectImportJob(tab, id);
    setImportStatus(
      elements,
      `${switchNote}${alreadyThere ? "Refreshed" : "Added"} "${title}" — ${rows.length} ${noun} (${config.format(total)} total). Tick the ones completed.`,
      "success"
    );
  } catch (error) {
    console.error(error);
    setImportStatus(elements, error.message || "Could not read that PDF.", "warning");
  }
}

// "Clear" unloads the active checklist only — the preloaded job stays in the
// library so it can be loaded again (or for another bench).
function clearImport() {
  const draft = getActiveDraft();
  draft.importRows = [];
  draft.importLoadedAt = null;
  draft.importJobId = null;
  persistImportRows(state.activeTab);
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

  // Drop a stale day drill-down if the current filters/range no longer contain
  // that day, so the list can't get stuck showing "no jobs on this day".
  if (
    state.workerHistory.selectedDayKey &&
    !jobs.some((job) => getShiftDayKey(job) === state.workerHistory.selectedDayKey)
  ) {
    state.workerHistory.selectedDayKey = null;
  }

  state.workerHistory.charts = renderWorkerHistory(
    elements,
    jobs,
    isAll ? "" : worker ? worker.name : "",
    state.workerHistory.charts,
    {
      onRemoveJob: removeJob,
      onHideJob: setJobHidden,
      onEditJob: startEditJob,
      onDaySelect: selectHistoryDay,
      selectedDayKey: state.workerHistory.selectedDayKey,
      showHidden: state.workerHistory.showHidden
    }
  );
}

// Toggle the chart→list day drill-down. Clicking the already-selected day (or
// the "Show all days" button, which passes null) clears it back to all days.
function selectHistoryDay(dayKey) {
  const next = dayKey && state.workerHistory.selectedDayKey === dayKey ? null : dayKey;
  state.workerHistory.selectedDayKey = next || null;
  renderWorkerHistoryView();
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

// Hide (or unhide) a logged job: it stays in the database but is excluded from
// the charts and stats. Reversible via the "Show hidden jobs" toggle.
async function setJobHidden(jobId, hidden) {
  if (!state.isAdmin) {
    return;
  }

  try {
    await setJobHiddenRecord(jobId, hidden);
    const job = state.savedJobs.find((item) => item.id === jobId);
    if (job) {
      job.hidden = hidden;
    }
    renderWorkerHistoryView();
    renderHistorySection();
  } catch (error) {
    console.error(error);
    window.alert(formatFirestoreError(error));
  }
}

// Local "HH:MM" (24-hour) of a Date's clock time — matches the canonical
// format the smart-time fields store, so it can be dropped straight into a
// draft's startTime/endTime.
function formatClockKey(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// Load a logged job back into the Log job form for editing. Switches to that
// job's type/tab, replacing the draft there (after confirming if it holds
// unsaved progress), so the End job button becomes "Save changes" and updates
// the existing record instead of creating a new one.
function startEditJob(job) {
  if (!state.isAdmin) {
    return;
  }

  const targetTab = JOB_TYPES[job.jobType] ? job.jobType : "trusses";
  const targetDraft = state.drafts[targetTab];
  const hasUnsavedProgress =
    targetDraft.entries.length > 0 ||
    Number.parseFloat(targetDraft.pendingAmount) > 0 ||
    (targetDraft.importRows ?? []).some((row) => row.done);

  if (
    hasUnsavedProgress &&
    !window.confirm(
      `Editing this job will replace what you've currently entered on the ${JOB_TYPES[targetTab].label} tab. Continue?`
    )
  ) {
    return;
  }

  const startDate = new Date(job.startedAt);
  const endDate = new Date(job.endedAt);
  const breakMinutes = Number(job.breakMinutes) || 0;

  const editedDraft = createEmptyDraft();
  editedDraft.shift = job.shift || "night";
  editedDraft.workDate = formatDateKey(startDate);
  editedDraft.benchNumber = job.benchNumber ? String(job.benchNumber) : "";
  editedDraft.startTime = formatClockKey(startDate);
  editedDraft.endTime = formatClockKey(endDate);
  // Older jobs (saved before strap start/end were recorded) only have a
  // duration, not clock times — leave the fields blank in that case; saving
  // without touching them keeps the original duration (see createPendingJob).
  editedDraft.strapStart = job.strapStart || "";
  editedDraft.strapEnd = job.strapEnd || "";
  editedDraft.break15Checked = breakMinutes === BREAK_15 || breakMinutes === BREAK_15 + BREAK_24;
  editedDraft.break24Checked = breakMinutes === BREAK_24 || breakMinutes === BREAK_15 + BREAK_24;
  editedDraft.assignedWorkerIds = Array.isArray(job.assignedWorkerIds) ? [...job.assignedWorkerIds] : [];
  editedDraft.entries = Array.isArray(job.entries) ? job.entries.map((entry) => ({ ...entry })) : [];

  state.drafts[targetTab] = editedDraft;
  state.editingJob = { id: job.id, jobType: targetTab, originalStrapMinutes: Number(job.strapMinutes) || 0 };

  if (targetTab !== state.activeTab) {
    if (JOB_TYPES[state.activeTab]) {
      syncDraftFromInputs();
    }
    state.activeTab = targetTab;
    state.lastJobType = targetTab;
  }

  renderApp();
  elements.workDateInput.scrollIntoView({ behavior: "smooth", block: "center" });
  setStatus(elements, "Editing this job — make your changes and tap Save changes, or Cancel edit.", "warning");
}

function cancelEditJob() {
  if (!state.editingJob) {
    return;
  }

  const tab = state.editingJob.jobType;
  state.editingJob = null;
  state.drafts[tab] = createEmptyDraft();

  if (tab === state.activeTab) {
    renderApp();
  }
  setStatus(elements, "Edit cancelled.");
}

// After a save, keep the shared shift details (date, start/end, breaks) so the
// next crew's job in the same shift only needs crew, bench and amounts. Crew-
// specific fields (workers, bench, strap, amounts) are cleared. The imported
// PDF list survives too — another bench may be working the same job — with the
// just-saved ticks reset (so they don't double-count) and marked as logged.
function resetDraftForNextCrew() {
  const previous = getActiveDraft();
  const next = createEmptyDraft();
  next.shift = previous.shift;
  next.workDate = previous.workDate;
  next.startTime = previous.startTime;
  next.endTime = previous.endTime;
  next.break15Checked = previous.break15Checked;
  next.break24Checked = previous.break24Checked;
  next.importRows = (previous.importRows ?? []).map((row) =>
    row.done ? { ...row, done: false, loggedCount: (row.loggedCount || 0) + 1 } : { ...row }
  );
  next.importLoadedAt = previous.importLoadedAt;
  next.importJobId = previous.importJobId;
  state.drafts[state.activeTab] = next;
  persistImportRows(state.activeTab);
  elements.trussFileInput.value = "";
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
  const editing = isEditingActiveTab();
  let strapMinutes = getStrapMinutes();
  if (editing && strapMinutes === 0 && !draft.strapStart && !draft.strapEnd) {
    // Blank strap fields while editing keep the job's original strap time
    // rather than erasing it — needed for older jobs that predate storing
    // strapStart/strapEnd, so there's nothing to re-populate the fields with.
    strapMinutes = state.editingJob.originalStrapMinutes;
  }
  const config = getActiveConfig();
  const actionLabel = editing ? "saving your changes" : "ending and saving a job";

  if (!state.currentUser) {
    setStatus(elements, "Sign in before saving a job.", "warning");
    return null;
  }

  if (!draft.startTime) {
    setStatus(elements, `Enter a start time before ${actionLabel}.`, "warning");
    return null;
  }

  const benchNumber = Number(elements.benchSelect.value);
  if (!Number.isInteger(benchNumber) || benchNumber < 1 || benchNumber > 19) {
    setStatus(elements, `Select a bench (1–19) before ${actionLabel}.`, "warning");
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
    shift: draft.shift,
    workDateValue: draft.workDate,
    benchNumber,
    startTimeValue: draft.startTime,
    endTimeValue: draft.endTime,
    breakMinutes,
    strapMinutes,
    strapStartValue: draft.strapStart,
    strapEndValue: draft.strapEnd,
    totalAmount,
    importMetres: getTickedImportMetres(),
    entries,
    assignedWorkers: resolveAssignedWorkers(draft.assignedWorkerIds),
    // Tag the job with its source list's number (e.g. "512621") so it can be
    // identified on the Charts tab. Empty for manual entries with no import.
    jobNumber: deriveJobNumber(draft.importJobId)
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

  const editing = isEditingActiveTab();
  elements.endJobButton.disabled = true;
  elements.endJobButton.textContent = "Saving...";

  try {
    if (editing) {
      const jobId = state.editingJob.id;
      await updateJobRecord(jobId, job);
      // updateDoc only touches the given fields, so hidden/userId/createdAt on
      // the existing record are preserved — merge onto the cached copy to match.
      const index = state.savedJobs.findIndex((item) => item.id === jobId);
      const updated = normalizeJob({ ...(index >= 0 ? state.savedJobs[index] : {}), ...job, id: jobId });
      if (index >= 0) {
        state.savedJobs[index] = updated;
      } else {
        state.savedJobs.unshift(updated);
      }
      state.editingJob = null;
      state.drafts[state.activeTab] = createEmptyDraft();
      renderApp();
      renderHistorySection();
      setStatus(elements, `${getActiveConfig().label} job updated.`, "success");
    } else {
      const savedJob = await saveJobRecord(job, state.currentUser);
      state.savedJobs.unshift(normalizeJob(savedJob));
      resetDraftForNextCrew();
      renderHistorySection();
      setStatus(elements, `${getActiveConfig().label} job saved. Shift details kept — pick the next crew and bench.`);
    }
  } catch (error) {
    console.error(error);
    setStatus(elements, formatFirestoreError(error), "warning");
  } finally {
    elements.endJobButton.disabled = false;
    renderEditBanner();
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

  // Load this user's own imports (and drop the previous user's) so imports stay
  // private across accounts on a shared device.
  syncImportsForUser();

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
  // The "Log job" tab returns to whichever job type was last active.
  if (nextTab === "log") {
    nextTab = JOB_TYPES[state.activeTab] ? state.activeTab : state.lastJobType;
  }

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
    // Carry the shared shift/crew details across to the other job type so the
    // admin doesn't re-enter the date, times, shift, breaks, strap, bench and
    // crew when logging the same crew's other work. Skip when the target tab
    // holds a job being edited, so its saved values aren't overwritten.
    if (JOB_TYPES[nextTab] && !(state.editingJob && state.editingJob.jobType === nextTab)) {
      carryShiftDetails(getActiveDraft(), state.drafts[nextTab]);
    }
  }

  state.activeTab = nextTab;
  if (JOB_TYPES[nextTab]) {
    state.lastJobType = nextTab;
  }
  renderApp();
}

function bindEvents() {
  [
    elements.workDateInput,
    elements.benchSelect,
    elements.break15Input,
    elements.break24Input,
    elements.strapStartInput,
    elements.strapEndInput
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

  // 12-hour time fields: on edit, resolve AM/PM from the selected shift and
  // store the canonical 24-hour value. The AM/PM indicator is read-only.
  SMART_TIME_FIELDS.forEach(({ input, toggle, key }) => {
    const inputEl = elements[input];
    const indicatorEl = elements[toggle];
    inputEl.addEventListener("change", () => {
      applySmartTimeInput(inputEl, indicatorEl, key);
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
  elements.cancelEditButton.addEventListener("click", cancelEditJob);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.rangeSelect.addEventListener("change", renderHistorySection);
  elements.workerHistorySelect.addEventListener("change", () => {
    state.workerHistory.selectedWorkerId = elements.workerHistorySelect.value;
    renderWorkerHistoryView();
  });
  elements.workerRangeSelect.addEventListener("change", renderWorkerHistoryView);
  elements.benchFilterSelect.addEventListener("change", renderWorkerHistoryView);
  elements.showHiddenJobs.addEventListener("change", () => {
    state.workerHistory.showHidden = elements.showHiddenJobs.checked;
    renderWorkerHistoryView();
  });
  elements.workerJobsClearDay.addEventListener("click", () => selectHistoryDay(null));

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
  // Job-type segmented toggle: manual override of trusses/walls (normally set
  // automatically when a PDF is imported or a preloaded job is picked).
  elements.jobTypeButtons.forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.jobType));
  });
  // Shift segmented toggle: sets the shift, which decides the AM/PM of the times
  // and is stored as the job's shift.
  elements.shiftButtons.forEach((button) => {
    button.addEventListener("click", () => handleShiftChange(button.dataset.shift));
  });
}

function startLiveUpdates() {
  window.setInterval(renderCalculatorSection, 30000);
}

function init() {
  bindEvents();
  // Imports are restored per-user once auth resolves (see syncImportsForUser),
  // so nothing is loaded here.
  renderAuthState(elements, null);
  renderApp();
  subscribeToAuthChanges(handleAuthChanged);
  startLiveUpdates();
}

init();
