import {
  addAdminRecord,
  addWorkerRecord,
  claimImportRow,
  deleteJobRecord,
  deleteWorkerRecord,
  formatFirestoreError,
  isEmailAdmin,
  loadAdminRecords,
  loadJobRecords,
  loadWorkerRecords,
  logoutCurrentUser,
  releaseImportRow,
  removeAdminRecord,
  RowAlreadyClaimedError,
  saveJobRecord,
  setJobHiddenRecord,
  subscribeToAuthChanges,
  subscribeToImportClaims,
  updateJobRecord
} from "./firebase-service.js";
import {
  BREAK_15,
  BREAK_24,
  JOB_TYPES,
  adjustStrapForBreakOverflow,
  autoWorkDateKey,
  benchFromAuthEmail,
  calculateBreakMinutes,
  calculateStrapMinutes,
  calculateWorkedMinutes,
  claimLabelForUser,
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
  importJobKey,
  isClaimStale,
  isSuperAdmin,
  isValidUsername,
  meridiemForShift,
  normalizeJob,
  parseFlexibleTime,
  SUPER_ADMIN_EMAIL,
  to24hString,
  usernameToAuthEmail
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
  renderAdminManagement,
  renderWorkerHistory,
  renderWorkerHistorySelect,
  renderWorkerManagement,
  renderWorkerPicker,
  renderJobTypeToggle,
  renderShiftToggle,
  renderDateModeToggle,
  renderImportLibrary,
  renderImportList,
  renderRangeCalendar,
  formatRangeLabel,
  showFormWarning,
  showSaveToast,
  clearFormWarning,
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
  admins: [],
  // The bench a worker signed in as (1–19), or null for admins / logged out.
  // In bench mode the app shows only the logging form with this bench locked.
  benchNumber: null,
  importLibrary: {
    trusses: [],
    walls: []
  },
  // Live row claims for the shared imported list currently loaded, keyed by row
  // number: { no, by, byLabel, at }. Plus the list being watched and the
  // Firestore listener that keeps it fresh.
  importClaims: {},
  importClaimsJobKey: null,
  importClaimsUnsub: null,
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
    // Job type of the drilled-into chart ("walls"/"trusses"), so the list can
    // show only that type. Null when no day is selected or the chart spans both.
    selectedJobType: null,
    // Custom period chosen from the calendar (YYYY-MM-DD keys), the calendar's
    // open state, and which month it is currently showing.
    customRange: { start: null, end: null },
    calendarOpen: false,
    calendarView: null,
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
  // On a shared list, rows another bench claimed are their work, so they are
  // left out of this bench's job.
  return draft.importRows
    .filter((row) => row.done && isRowMine(row))
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
    .filter((row) => row.done && isRowMine(row))
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
  // In auto mode the date is controlled (locked to the shift-aware date), so only
  // read the field back into the draft when the admin is entering it manually.
  if (draft.dateMode === "manual") {
    draft.workDate = elements.workDateInput.value;
  }
  // Bench workers stay pinned to their signed-in bench; admins read the picker.
  draft.benchNumber = isBenchUser() ? String(state.benchNumber) : elements.benchSelect.value;
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
  // The shift flips the start time's AM/PM (e.g. 10:00 → 10pm on Night), which
  // can change the auto work date, so refresh the locked date field.
  if (draft.dateMode !== "manual") {
    renderWorkDateField();
  }
  SMART_TIME_FIELDS.forEach(({ input, toggle, key }) => {
    renderSmartTimeField(elements[input], elements[toggle], draft[key]);
  });
  renderCalculatorSection();
}

// The work date is either automatic (locked to the shift-aware current date) or
// manual (an editable date the admin picks for a back-dated job).
function renderWorkDateField() {
  const draft = getActiveDraft();
  const manual = draft.dateMode === "manual";
  if (!manual) {
    // Derive the date from the start time: a 10pm start logged after midnight
    // dates to the previous evening; an after-midnight start to that morning.
    draft.workDate = autoWorkDateKey(draft.startTime);
  }
  elements.workDateInput.value = draft.workDate;
  elements.workDateInput.disabled = !manual;
  renderDateModeToggle(elements, manual ? "manual" : "auto");
}

function handleDateModeChange(mode) {
  const draft = getActiveDraft();
  const nextMode = mode === "manual" ? "manual" : "auto";
  if (draft.dateMode === nextMode) {
    return;
  }
  draft.dateMode = nextMode;
  renderWorkDateField();
  renderCalculatorSection();
}

function loadDraftIntoInputs() {
  const draft = getActiveDraft();
  renderWorkDateField();
  // Bench workers log everything against the bench they signed in as, so lock the
  // field to it. Admins pick the bench freely.
  if (isBenchUser()) {
    draft.benchNumber = String(state.benchNumber);
    elements.benchSelect.disabled = true;
  } else {
    elements.benchSelect.disabled = false;
  }
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
  // Every change to the job in progress ends up repainting the calculator, so
  // this is the one place that keeps the stored copy in step with the form.
  // Only for a signed-in user: a logged-out visitor has nothing worth keeping,
  // and writing here would land in the wrong namespace.
  if (state.currentUser) {
    persistDrafts();
  }
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

  // The per-job history charts belong to a job-type tab (trusses/walls). On the
  // Charts ("workers") tab there is no active config, so skip them — otherwise
  // callers that fire this after acting from the Charts tab (hide/delete a job)
  // would pass an undefined config into renderHistory and crash.
  const config = getActiveConfig();
  if (!config) {
    return;
  }

  state.charts = renderHistory(elements, getHistoryJobs(), state.charts, config);
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

  // The per-job trusses/screw charts need saved jobs, so only show that panel
  // when signed in (it would otherwise be an empty chart box) and not for the
  // admin (aggregate Charts tab) or a bench worker (logging form only).
  const showJobHistory = !state.isAdmin && Boolean(state.currentUser) && !isBenchUser();
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
const DRAFT_STORE_PREFIX = "screwcount.draft.";
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

function draftStoreKey() {
  return `${DRAFT_STORE_PREFIX}${importUserKey()}`;
}

// The job in progress (times, bench, crew, entries, breaks) is kept in
// localStorage so closing the tab or reloading mid-shift doesn't lose it — the
// bench picks up exactly where it left off. Like the imported lists it lasts one
// shift, and it is namespaced per signed-in user so a shared tablet never shows
// one bench the other's half-finished job.
//
// The import checklist itself is NOT stored here: it has its own store (and, for
// a shared list, its ticks live in Firestore), so it isn't duplicated.
const DRAFT_PERSIST_KEYS = [
  "dateMode",
  "workDate",
  "benchNumber",
  "shift",
  "startTime",
  "endTime",
  "strapStart",
  "strapEnd",
  "pendingAmount",
  "break15Checked",
  "break24Checked",
  "assignedWorkerIds",
  "entries"
];

function persistDrafts() {
  try {
    const payload = { savedAt: Date.now(), activeTab: state.activeTab, drafts: {} };
    Object.keys(JOB_TYPES).forEach((tab) => {
      const draft = state.drafts[tab];
      const slim = {};
      DRAFT_PERSIST_KEYS.forEach((key) => {
        slim[key] = Array.isArray(draft[key]) ? [...draft[key]] : draft[key];
      });
      payload.drafts[tab] = slim;
    });
    localStorage.setItem(draftStoreKey(), JSON.stringify(payload));
  } catch {
    // Storage unavailable (private mode etc.) — the job just won't survive a reload.
  }
}

function restoreDrafts() {
  try {
    const raw = localStorage.getItem(draftStoreKey());
    if (!raw) {
      return;
    }
    const stored = JSON.parse(raw);
    if (!stored || !stored.drafts || !Number.isFinite(stored.savedAt)) {
      throw new Error("bad stored draft");
    }
    if (Date.now() - stored.savedAt > IMPORT_MAX_AGE_MS) {
      localStorage.removeItem(draftStoreKey());
      return;
    }

    Object.keys(JOB_TYPES).forEach((tab) => {
      const slim = stored.drafts[tab];
      if (!slim) {
        return;
      }
      const draft = state.drafts[tab];
      DRAFT_PERSIST_KEYS.forEach((key) => {
        if (slim[key] === undefined) {
          return;
        }
        draft[key] = Array.isArray(slim[key]) ? [...slim[key]] : slim[key];
      });
      // Entries are objects; clone them so the restored draft never aliases the
      // parsed JSON.
      draft.entries = Array.isArray(slim.entries)
        ? slim.entries
            .filter((entry) => entry && Number.isFinite(Number(entry.amount)))
            .map((entry) => ({ amount: Number(entry.amount), timeLabel: String(entry.timeLabel ?? "") }))
        : [];
    });

    if (JOB_TYPES[stored.activeTab]) {
      state.activeTab = stored.activeTab;
      state.lastJobType = stored.activeTab;
    }
  } catch {
    try {
      localStorage.removeItem(draftStoreKey());
    } catch {
      // ignore
    }
  }
}

// --- Shared imported lists: live ticks and row claims across benches ---
//
// Two benches that import the same PDF work the same list. Each ticked row is
// claimed in Firestore, so a tick on one bench appears on the other within a
// moment, and a row someone else has taken can't be ticked or unticked by
// anyone else. Rows claimed by another bench are shown as theirs and left out of
// this bench's totals — their work counts for them, not for us.

function activeImportJobKey() {
  const draft = getActiveDraft();
  if (!draft?.importJobId || !state.currentUser) {
    return null;
  }
  return importJobKey(state.activeTab, draft.importJobId);
}

function claimForRow(row) {
  return state.importClaims[String(row?.no)] ?? null;
}

// A row counts for this bench when nobody else holds it: either we claimed it,
// or it was ticked offline/locally with no claim recorded at all. Straight after
// a reload the live claims haven't arrived yet, so fall back to the owner stored
// with the row — otherwise another bench's work would count as ours for the
// moment it takes the first snapshot to land.
function isRowMine(row) {
  const claim = claimForRow(row);
  const owner = claim ? claim.by : row?.claimedBy;
  if (!owner) {
    return Boolean(row?.done);
  }
  return owner === state.currentUser?.uid;
}

// Paint the live claims onto the loaded checklist. A row is ticked when someone
// holds it; who that is decides whether this bench may untick it and whether it
// counts toward this bench's total.
function applyClaimsToRows() {
  const draft = getActiveDraft();
  if (!Array.isArray(draft?.importRows)) {
    return;
  }
  const now = Date.now();
  draft.importRows.forEach((row) => {
    const claim = state.importClaims[String(row.no)];
    if (claim && !isClaimStale(claim, now)) {
      row.done = true;
      row.claimedBy = claim.by;
      row.claimedLabel = claim.byLabel ?? "Another bench";
      return;
    }
    // No live claim: an abandoned (stale) one frees the row again.
    if (row.claimedBy) {
      row.done = false;
      row.claimedBy = null;
      row.claimedLabel = null;
    }
  });
}

// Watch the shared list the active draft is on, swapping the listener when the
// loaded job changes and dropping it when there's nothing shared to watch.
function syncImportClaimSubscription() {
  const jobKey = activeImportJobKey();
  if (jobKey === state.importClaimsJobKey) {
    return;
  }

  if (state.importClaimsUnsub) {
    state.importClaimsUnsub();
    state.importClaimsUnsub = null;
  }
  state.importClaimsJobKey = jobKey;
  state.importClaims = {};

  if (!jobKey) {
    return;
  }

  state.importClaimsUnsub = subscribeToImportClaims(
    jobKey,
    (claims) => {
      // Ignore a snapshot that arrives after the user moved to another list.
      if (state.importClaimsJobKey !== jobKey) {
        return;
      }
      state.importClaims = claims;
      applyClaimsToRows();
      renderImportSection();
      renderCalculatorSection();
    },
    () => {
      setImportStatus(
        elements,
        "Couldn't sync ticks with the other benches — your ticks are still saved on this device.",
        "warning"
      );
    }
  );
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
    // A new user starts from a clean form, not the previous one's half-done job.
    state.drafts[tab] = createEmptyDraft();
  });

  if (state.isAdmin) {
    restoreImportLibrary();
  }
  restoreImportRows();
  // Restore this user's own job in progress, so a reload mid-shift keeps the
  // times, crew and entries they had already entered.
  restoreDrafts();
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

  // Watch the shared list the active draft is on — and, off the logging tabs or
  // signed out, stop listening rather than leaving a subscription running.
  syncImportClaimSubscription();

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
    renderImportList(elements, draft.importRows ?? [], config, toggleImportRow, {
      currentUserId: state.currentUser?.uid ?? null
    });
  }
}

// A row another bench is holding right now. Their work is theirs: it can't be
// ticked, unticked, dragged over or caught by "Tick all".
function isRowLockedByOther(row) {
  const claim = claimForRow(row);
  if (claim) {
    return !isClaimStale(claim) && claim.by !== state.currentUser?.uid;
  }
  // Same reload gap as isRowMine: trust the owner stored with the row until the
  // first snapshot replaces it.
  return Boolean(row?.claimedBy) && row.claimedBy !== state.currentUser?.uid;
}

// Push the local tick state of the given rows up to the shared list, claiming
// the ones now ticked and releasing the ones now unticked. Anything the server
// refuses (another bench got there first, or we're offline) is rolled back so
// the checklist never shows work this bench doesn't actually hold.
async function commitImportRowStates(indexes) {
  const tab = state.activeTab;
  const jobKey = activeImportJobKey();
  if (!jobKey) {
    persistImportRows(tab);
    return;
  }

  const draft = state.drafts[tab];
  const label = claimLabelForUser(state.currentUser);
  const refused = [];
  let otherError = null;

  await Promise.all(
    indexes.map(async (index) => {
      const row = draft.importRows?.[index];
      if (!row) {
        return;
      }
      try {
        if (row.done) {
          await claimImportRow(jobKey, row, state.currentUser, label);
        } else {
          await releaseImportRow(jobKey, row.no);
        }
      } catch (error) {
        row.done = !row.done;
        if (error instanceof RowAlreadyClaimedError) {
          refused.push(row.number);
        } else {
          otherError = error;
        }
      }
    })
  );

  persistImportRows(tab);
  renderImportSection();
  renderCalculatorSection();

  if (refused.length > 0) {
    const list = refused.slice(0, 3).join(", ");
    const more = refused.length > 3 ? ` and ${refused.length - 3} more` : "";
    setImportStatus(
      elements,
      `${list}${more} ${refused.length === 1 ? "was" : "were"} just ticked by another bench.`,
      "warning"
    );
  } else if (otherError) {
    setImportStatus(elements, formatFirestoreError(otherError), "warning");
  }
}

// Tick or untick one row. On a shared list the tick is a claim in Firestore, so
// the other benches see it immediately and can't take the same row; on a list
// nobody else is on it stays a local tick exactly as before.
function toggleImportRow(index, done) {
  const draft = getActiveDraft();
  const row = draft.importRows?.[index];
  if (!row) {
    return;
  }

  // Someone else holds this row — put the checkbox back and say who has it.
  if (isRowLockedByOther(row)) {
    renderImportSection();
    setImportStatus(
      elements,
      `${row.number} is already ticked by ${claimForRow(row)?.byLabel ?? "another bench"}.`,
      "warning"
    );
    return;
  }

  // Show the tick straight away, then confirm it against the shared list.
  row.done = done;
  renderImportSection();
  renderCalculatorSection();
  commitImportRowStates([index]);
}

// Drag-to-select for the import checklist (mouse/pen only — touch keeps its
// native scroll). Press on a row and drag down/up to tick (or untick) every row
// the pointer passes over, in one stroke. `setTo` is decided from the row you
// started on: from an unticked row it ticks, from a ticked row it unticks.
let importDrag = null;
let suppressImportClick = false;

function handleImportPointerDown(event) {
  if (event.pointerType === "touch") {
    return;
  }
  const row = event.target.closest(".truss-row");
  if (!row || !elements.trussList.contains(row)) {
    return;
  }
  const index = Number(row.dataset.index);
  const rows = getActiveDraft().importRows;
  if (!Array.isArray(rows) || !rows[index]) {
    return;
  }
  // Starting on another bench's row would read its tick as the direction for
  // the whole stroke, so the gesture doesn't begin there at all.
  if (isRowLockedByOther(rows[index])) {
    return;
  }
  // Don't tick yet: a plain click is left to the checkbox's own handler. The
  // drag only kicks in once the pointer reaches a different row.
  suppressImportClick = false;
  importDrag = { originIndex: index, setTo: !rows[index].done, active: false, changed: new Set() };
}

function handleImportPointerMove(event) {
  if (!importDrag) {
    return;
  }
  const under = document.elementFromPoint(event.clientX, event.clientY);
  const row = under && under.closest(".truss-row");
  if (!row || !elements.trussList.contains(row)) {
    return;
  }
  const index = Number(row.dataset.index);
  if (!importDrag.active) {
    if (index === importDrag.originIndex) {
      return;
    }
    // First move onto another row: now it's a drag, so include the row we
    // started on (a plain click won't fire once the pointer has moved away).
    importDrag.active = true;
    applyImportDragTo(importDrag.originIndex);
  }
  applyImportDragTo(index);
}

function applyImportDragTo(index) {
  const rows = getActiveDraft().importRows;
  if (!rows || !rows[index] || rows[index].done === importDrag.setTo) {
    return;
  }
  // Drag straight past rows another bench is working on.
  if (isRowLockedByOther(rows[index])) {
    return;
  }
  rows[index].done = importDrag.setTo;
  importDrag.changed.add(index);
  // Update just this row's checkbox during the drag; the list is re-rendered
  // once at the end so the stroke stays smooth.
  const checkbox = elements.trussList.querySelector(
    `.truss-row[data-index="${index}"] input[type="checkbox"]`
  );
  if (checkbox) {
    checkbox.checked = importDrag.setTo;
  }
}

function endImportDrag() {
  if (!importDrag) {
    return;
  }
  const wasActive = importDrag.active;
  const changedIndexes = importDrag.changed;
  const changed = changedIndexes.size;
  importDrag = null;
  if (!wasActive) {
    return;
  }
  // A drag that ends back on its origin still fires a click there; swallow it so
  // the row isn't toggled a second time.
  suppressImportClick = true;
  if (changed > 0) {
    renderImportSection();
    renderCalculatorSection();
    // Claim (or release) everything the stroke touched, in one go.
    commitImportRowStates([...changedIndexes]);
  }
}

// Tick every imported row at once (or untick them all if they're already all
// ticked), so the whole loaded list can be marked done in one tap.
function toggleAllImportRows() {
  const draft = getActiveDraft();
  const rows = draft.importRows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }
  // Only rows this bench can actually reach take part — the ones another bench
  // holds are left exactly as they are, and don't decide the direction either.
  const reachable = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !isRowLockedByOther(row));
  if (reachable.length === 0) {
    return;
  }

  const markDone = !reachable.every(({ row }) => row.done);
  const changed = [];
  reachable.forEach(({ row, index }) => {
    if (row.done !== markDone) {
      row.done = markDone;
      changed.push(index);
    }
  });
  if (changed.length === 0) {
    return;
  }

  renderImportSection();
  renderCalculatorSection();
  commitImportRowStates(changed);
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

    // Trust the PDF's own contents first (the item numbers — W-panels vs
    // T-trusses — then the PACK/TRUSS wording); fall back to the filename only
    // when the contents are inconclusive. If it belongs on the other tab, switch.
    const detectedJobType = contentJobType || detectJobTypeFromName(file.name);
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
      // The id is the PDF's own file name, so two benches importing the same
      // sheet land on the same shared list and see each other's ticks.
      draft.importJobId = deriveImportTitle(file.name).toLowerCase();
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

// Workers to offer in the Charts dropdown: the current roster plus anyone who
// appears on a saved job but has since been removed. Deleting a worker only
// takes them off the roster and the new-job picker — their logged history stays
// fully visible in the charts, so the chart area is unaffected by a deletion.
function getHistoryWorkers() {
  const byId = new Map();
  state.workers.forEach((worker) => {
    byId.set(worker.id, { id: worker.id, name: worker.name, removed: false });
  });
  state.savedJobs.forEach((job) => {
    (job.assignedWorkers || []).forEach((worker) => {
      if (worker && worker.id && !byId.has(worker.id)) {
        byId.set(worker.id, { id: worker.id, name: worker.name || "Removed worker", removed: true });
      }
    });
  });
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function renderWorkerHistoryView() {
  if (!state.isAdmin) {
    return;
  }

  const historyWorkers = getHistoryWorkers();
  const selectedId = renderWorkerHistorySelect(
    elements,
    historyWorkers,
    state.workerHistory.selectedWorkerId
  );
  state.workerHistory.selectedWorkerId = selectedId;

  // Show the calendar picker only when the "Custom range…" period is chosen.
  const isCustom = elements.workerRangeSelect.value === "custom";
  elements.workerCustomRange.classList.toggle("hidden", !isCustom);
  if (isCustom) {
    renderWorkerRangeControl();
  } else {
    closeWorkerCalendar();
  }

  const isAll = selectedId === "all";
  const worker = historyWorkers.find((item) => item.id === selectedId);
  const { start: rangeStart, end: rangeEnd } = resolveWorkerRange();
  const benchFilter = elements.benchFilterSelect.value;
  const isAllBenches = benchFilter === "all";
  const shiftFilter = elements.shiftFilterSelect.value;
  const isAllShifts = shiftFilter === "all";
  const jobs = state.savedJobs
    .filter((job) => {
      const ended = new Date(job.endedAt);
      return ended >= rangeStart && ended <= rangeEnd;
    })
    .filter((job) =>
      isAll ? job.assignedWorkerIds.length > 0 : job.assignedWorkerIds.includes(selectedId)
    )
    .filter((job) => isAllBenches || job.benchNumber === Number(benchFilter))
    .filter((job) => isAllShifts || job.shift === shiftFilter)
    .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt));

  // Drop a stale day drill-down if the current filters/range no longer contain
  // that day, so the list can't get stuck showing "no jobs on this day".
  if (
    state.workerHistory.selectedDayKey &&
    !jobs.some((job) => getShiftDayKey(job) === state.workerHistory.selectedDayKey)
  ) {
    state.workerHistory.selectedDayKey = null;
    state.workerHistory.selectedJobType = null;
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
      selectedJobType: state.workerHistory.selectedJobType,
      showHidden: state.workerHistory.showHidden
    }
  );
}

// Update the range trigger's label and, when open, repaint the calendar. Cheap
// (no chart work) so a first day-pick can refresh the calendar without redrawing
// the whole Charts view.
function renderWorkerRangeControl() {
  const { start, end } = state.workerHistory.customRange;
  elements.workerRangeText.textContent = formatRangeLabel(start, end);
  elements.workerRangeTrigger.setAttribute("aria-expanded", String(state.workerHistory.calendarOpen));
  elements.workerCalendar.classList.toggle("hidden", !state.workerHistory.calendarOpen);

  if (!state.workerHistory.calendarOpen) {
    return;
  }

  const view = resolveCalendarView();
  renderRangeCalendar(elements.workerCalendar, view.year, view.month, start, end, {
    onPrevMonth: () => stepCalendarMonth(-1),
    onNextMonth: () => stepCalendarMonth(1),
    onPickDay: pickCalendarDay
  });
}

// Which month the calendar shows: the explicit view if the admin navigated, else
// the selected start's month, else the current month.
function resolveCalendarView() {
  if (state.workerHistory.calendarView) {
    return state.workerHistory.calendarView;
  }
  const anchor = state.workerHistory.customRange.start
    ? new Date(`${state.workerHistory.customRange.start}T00:00:00`)
    : new Date();
  return { year: anchor.getFullYear(), month: anchor.getMonth() };
}

function stepCalendarMonth(delta) {
  const view = resolveCalendarView();
  const next = new Date(view.year, view.month + delta, 1);
  state.workerHistory.calendarView = { year: next.getFullYear(), month: next.getMonth() };
  renderWorkerRangeControl();
}

// First pick sets the start (and clears any old end); the second pick completes
// the range and applies it. The two days are ordered so either click order works.
function pickCalendarDay(dayKey) {
  const range = state.workerHistory.customRange;
  if (!range.start || (range.start && range.end)) {
    range.start = dayKey;
    range.end = null;
    renderWorkerRangeControl();
    return;
  }

  const [start, end] = dayKey < range.start ? [dayKey, range.start] : [range.start, dayKey];
  range.start = start;
  range.end = end;
  state.workerHistory.calendarOpen = false;
  renderWorkerHistoryView();
}

function toggleWorkerCalendar() {
  const nowOpen = !state.workerHistory.calendarOpen;
  state.workerHistory.calendarOpen = nowOpen;
  // Reset the shown month to follow the current selection each time it opens.
  if (nowOpen) {
    state.workerHistory.calendarView = null;
  }
  renderWorkerRangeControl();
}

function closeWorkerCalendar() {
  if (!state.workerHistory.calendarOpen) {
    return;
  }
  state.workerHistory.calendarOpen = false;
  renderWorkerRangeControl();
}

// The period shown on the Charts tab: either a rolling window ending today
// ("Last N days") or an explicit custom range chosen from the calendar. An
// unfinished custom range falls back to the last 30 days; the two picked days
// are ordered so the range is always ascending.
function resolveWorkerRange() {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  if (elements.workerRangeSelect.value === "custom") {
    const { start: startKey, end: endKey } = state.workerHistory.customRange;
    if (startKey && endKey) {
      const a = startOfDay(new Date(`${startKey}T00:00:00`));
      const b = startOfDay(new Date(`${endKey}T00:00:00`));
      // Whichever day is earlier is the start, so the two picks work either way.
      const earlier = a <= b ? a : b;
      const later = a <= b ? b : a;
      return { start: startOfDay(earlier), end: endOfDay(later) };
    }
    // Custom picked but not fully chosen yet — show the last 30 days.
    return { start: getRangeStartDate(30), end: endOfToday };
  }

  return { start: getRangeStartDate(Number(elements.workerRangeSelect.value)), end: endOfToday };
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

// Toggle the chart→list day drill-down. Clicking the already-selected day on
// the same chart type (or the "Show all days" button, which passes null) clears
// it back to all days. Clicking the same day on a different chart type instead
// switches the filter to that type rather than clearing.
function selectHistoryDay(dayKey, jobType = null) {
  const type = jobType || null;
  const sameSelection =
    Boolean(dayKey) &&
    state.workerHistory.selectedDayKey === dayKey &&
    state.workerHistory.selectedJobType === type;
  state.workerHistory.selectedDayKey = sameSelection ? null : dayKey || null;
  state.workerHistory.selectedJobType = sameSelection ? null : dayKey ? type : null;
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
  // Editing an existing job: show its own (fixed, historical) date in Manual mode
  // rather than auto-jumping to the current shift-day.
  editedDraft.dateMode = "manual";
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
  // Keep the admin's date mode for the next crew: Auto recomputes the shift-aware
  // date, Manual keeps the date they entered.
  next.dateMode = previous.dateMode;
  next.workDate = previous.workDate;
  next.startTime = previous.startTime;
  next.endTime = previous.endTime;
  // Breaks are per-job, so a saved job clears its ticked breaks — the next crew
  // starts with none rather than inheriting the last job's breaks.
  next.break15Checked = false;
  next.break24Checked = false;
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

// Inputs currently outlined red by the missing-field alert, so they can be
// cleared together when the alert is dismissed.
let flaggedFields = [];

// Join a list into readable prose: "a, b and c".
function joinWithAnd(items) {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Show the big alert, outline the offending fields, and scroll the first one
// into view so the fix is obvious even on a long form.
function showFormValidationWarning(message, fields) {
  showFormWarning(elements, message);
  clearFieldHighlights();
  fields.forEach((field) => {
    if (field) {
      field.classList.add("input-error");
      flaggedFields.push(field);
    }
  });
  const firstField = flaggedFields[0];
  if (firstField && typeof firstField.scrollIntoView === "function") {
    firstField.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function clearFieldHighlights() {
  flaggedFields.forEach((field) => field.classList.remove("input-error"));
  flaggedFields = [];
}

function clearFormValidationWarning() {
  clearFormWarning(elements);
  clearFieldHighlights();
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
    showFormValidationWarning("Sign in before saving a job.", []);
    return null;
  }

  // Collect every missing required field so one warning lists them all, instead
  // of surfacing them one tap at a time.
  const missing = [];
  const errorFields = [];

  if (!draft.startTime) {
    missing.push("a start time");
    errorFields.push(elements.startTimeInput);
  }

  const benchNumber = Number(elements.benchSelect.value);
  if (!Number.isInteger(benchNumber) || benchNumber < 1 || benchNumber > 19) {
    missing.push("a bench number");
    errorFields.push(elements.benchSelect);
  }

  // Live count (empty end time = "now") only makes sense for a job on the
  // current shift-day (the date the entered start time last occurred). A
  // genuinely back-dated job must have an explicit end time.
  if (!draft.endTime && draft.workDate && draft.workDate !== autoWorkDateKey(draft.startTime)) {
    missing.push("an end time (past jobs can't use the live count)");
    errorFields.push(elements.endTimeInput);
  }

  if (totalAmount <= 0) {
    missing.push(`some ${config.unitLabel.toLowerCase()}`);
    errorFields.push(elements.amountInput);
  }

  if (missing.length > 0) {
    showFormValidationWarning(`Before ${actionLabel}, add ${joinWithAnd(missing)}.`, errorFields);
    return null;
  }

  clearFormValidationWarning();

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
      showSaveToast(elements, `${getActiveConfig().label} job updated!`);
    } else {
      const savedJob = await saveJobRecord(job, state.currentUser);
      state.savedJobs.unshift(normalizeJob(savedJob));
      resetDraftForNextCrew();
      renderHistorySection();
      setStatus(elements, `${getActiveConfig().label} job saved. Shift details kept — pick the next crew and bench.`);
      showSaveToast(elements, `${getActiveConfig().label} job saved!`);
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
    // Admins load the shared pool (every job); workers only their own — so a
    // bench worker's recent-crew suggestions are scoped to that bench's jobs.
    const jobs = await loadJobRecords(state.currentUser, { all: state.isAdmin });
    state.savedJobs = jobs.map(normalizeJob);
    refreshActiveHistory();
    // Recent-crew chips come from savedJobs, so refresh the picker once loaded.
    renderWorkerPickerSection();
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

function isBenchUser() {
  return state.benchNumber !== null;
}

function handleAuthChanged(user) {
  state.currentUser = user;
  // A bench account (worker) puts the app in locked bench mode; admins/others get null.
  state.benchNumber = benchFromAuthEmail(user?.email);
  // The super-admin resolves instantly; roster admins are confirmed by an async
  // Firestore check below. Start from the synchronous answer so the UI is right
  // for the common (super-admin) case without waiting on the network.
  state.isAdmin = isSuperAdmin(user);
  renderAuthState(elements, user);
  applyAdminState();

  // Load this user's own imports (and drop the previous user's) so imports stay
  // private across accounts on a shared device.
  syncImportsForUser();

  // Re-render so admin-specific panel visibility (hidden trusses/screw charts) applies.
  renderApp();

  loadSavedJobs();
  loadWorkers();
  loadAdmins();

  // Non-super-admins might still be on the admin roster — confirm asynchronously,
  // then re-apply if it changes their access (guarding against a fast re-login).
  if (user && !state.isAdmin) {
    resolveRosterAdmin(user);
  }
}

// Re-apply everything that depends on admin status: panel visibility, and a
// fallback off the admin-only Charts tab if access was lost.
function applyAdminState() {
  // Admins and bench workers can both pick workers for a job; the admin-only
  // management/charts panels stay admin-only.
  renderWorkerAdminVisibility(elements, state.isAdmin, state.isAdmin || isBenchUser());
  if (!state.isAdmin && state.activeTab === "workers") {
    state.activeTab = "trusses";
  }
}

async function resolveRosterAdmin(user) {
  try {
    const granted = await isEmailAdmin(user.email);
    // Ignore a stale result if the signed-in user changed while we waited.
    if (!granted || state.currentUser !== user || state.isAdmin) {
      return;
    }
    state.isAdmin = true;
    applyAdminState();
    renderApp();
    loadSavedJobs();
    loadWorkers();
    loadAdmins();
  } catch (error) {
    console.error(error);
  }
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
  // Admins and bench workers both need the roster (bench workers pick their name);
  // logged-out or other users get none.
  if (!state.currentUser || (!state.isAdmin && !isBenchUser())) {
    state.workers = [];
    renderWorkerPickerSection();
    return;
  }

  try {
    // The worker roster is shared, so load every worker. De-dupe by name in case
    // the same person was added twice.
    const workers = await loadWorkerRecords(state.currentUser, { all: true });
    state.workers = dedupeWorkersByName(workers).sort((a, b) => a.name.localeCompare(b.name));
    if (state.isAdmin) {
      renderWorkersSection();
    } else {
      // Bench worker: just refresh the picker (no admin management panel).
      renderWorkerPickerSection();
    }
  } catch (error) {
    console.error(error);
    setWorkerStatus(elements, formatFirestoreError(error), "warning");
  }
}

// With a shared pool, two admins can create a worker of the same name. Keep the
// first of each name so the roster and picker don't show duplicates.
function dedupeWorkersByName(workers) {
  const seen = new Set();
  const unique = [];
  workers.forEach((worker) => {
    const key = String(worker.name).trim().toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(worker);
  });
  return unique;
}

// --- Admin roster management (admin-only) ---

async function loadAdmins() {
  if (!state.isAdmin || !state.currentUser) {
    state.admins = [];
    return;
  }
  try {
    state.admins = await loadAdminRecords();
    renderAdminsSection();
  } catch (error) {
    console.error(error);
    setAdminStatus(formatFirestoreError(error), "warning");
  }
}

function renderAdminsSection() {
  if (!state.isAdmin) {
    return;
  }
  renderAdminManagement(elements, state.admins, SUPER_ADMIN_EMAIL, {
    onRemoveAdmin: removeAdmin
  });
}

function setAdminStatus(message, tone = "hint") {
  if (!elements.adminStatus) {
    return;
  }
  elements.adminStatus.textContent = message;
  elements.adminStatus.className = tone === "warning" || tone === "success" ? `hint ${tone}` : "hint";
}

async function addAdmin() {
  const username = elements.adminEmailInput.value.trim();

  if (!isValidUsername(username)) {
    setAdminStatus("Enter a valid username.", "warning");
    return;
  }
  // Map the username to the account identity Firebase uses (a synthetic email);
  // the owner's real email passes through unchanged.
  const email = usernameToAuthEmail(username);
  if (email === SUPER_ADMIN_EMAIL) {
    setAdminStatus("That is already the owner.", "warning");
    return;
  }
  if (state.admins.some((admin) => String(admin.email).toLowerCase() === email)) {
    setAdminStatus(`${username} is already an admin.`, "warning");
    return;
  }

  try {
    await addAdminRecord(email, state.currentUser);
    state.admins.push({ email });
    elements.adminEmailInput.value = "";
    renderAdminsSection();
    setAdminStatus(`${username} can now sign in as an admin.`, "success");
  } catch (error) {
    console.error(error);
    setAdminStatus(formatFirestoreError(error), "warning");
  }
}

async function removeAdmin(email) {
  const key = String(email).toLowerCase();
  if (key === SUPER_ADMIN_EMAIL) {
    return;
  }
  try {
    await removeAdminRecord(key);
    state.admins = state.admins.filter((admin) => String(admin.email).toLowerCase() !== key);
    renderAdminsSection();
    setAdminStatus(`Removed ${key}.`, "success");
  } catch (error) {
    console.error(error);
    setAdminStatus(formatFirestoreError(error), "warning");
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
  // Don't carry a missing-field alert across to the other tab.
  clearFormValidationWarning();
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
      // The start time drives the auto work date, so refresh the locked date.
      if (key === "startTime" && getActiveDraft().dateMode !== "manual") {
        renderWorkDateField();
      }
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
  elements.addAdminButton.addEventListener("click", addAdmin);
  elements.adminEmailInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addAdmin();
    }
  });
  elements.addAmountButton.addEventListener("click", addEntry);
  elements.endJobButton.addEventListener("click", saveJob);
  // Dismiss the missing-field alert as soon as the admin edits any flagged field.
  [
    elements.benchSelect,
    elements.startTimeInput,
    elements.endTimeInput,
    elements.amountInput,
    elements.workDateInput
  ].forEach((field) => {
    field.addEventListener("input", clearFormValidationWarning);
    field.addEventListener("change", clearFormValidationWarning);
  });
  elements.cancelEditButton.addEventListener("click", cancelEditJob);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.rangeSelect.addEventListener("change", renderHistorySection);
  elements.workerHistorySelect.addEventListener("change", () => {
    state.workerHistory.selectedWorkerId = elements.workerHistorySelect.value;
    renderWorkerHistoryView();
  });
  elements.workerRangeSelect.addEventListener("change", () => {
    // Seed a fresh custom range with the last 30 days so the charts aren't blank
    // before the admin picks their own start/end from the calendar.
    if (
      elements.workerRangeSelect.value === "custom" &&
      !state.workerHistory.customRange.start &&
      !state.workerHistory.customRange.end
    ) {
      state.workerHistory.customRange = {
        start: formatDateKey(getRangeStartDate(30)),
        end: formatDateKey(new Date())
      };
    }
    renderWorkerHistoryView();
  });
  elements.workerRangeTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleWorkerCalendar();
  });
  // Clicks inside the calendar shouldn't reach the outside-click closer below.
  elements.workerCalendar.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", closeWorkerCalendar);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeWorkerCalendar();
    }
  });
  elements.benchFilterSelect.addEventListener("change", renderWorkerHistoryView);
  elements.shiftFilterSelect.addEventListener("change", renderWorkerHistoryView);
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
  elements.trussTickAllButton.addEventListener("click", toggleAllImportRows);
  // Drag-to-select ticking across the import checklist (mouse/pen).
  elements.trussList.addEventListener("pointerdown", handleImportPointerDown);
  elements.trussList.addEventListener("pointermove", handleImportPointerMove);
  elements.trussList.addEventListener(
    "click",
    (event) => {
      if (suppressImportClick) {
        event.preventDefault();
        event.stopPropagation();
        suppressImportClick = false;
      }
    },
    true
  );
  document.addEventListener("pointerup", endImportDrag);
  document.addEventListener("pointercancel", endImportDrag);
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
  elements.dateModeButtons.forEach((button) => {
    button.addEventListener("click", () => handleDateModeChange(button.dataset.dateMode));
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
