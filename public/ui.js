import {
  aggregateBenchShiftTotals,
  aggregateHistorySeriesByDay,
  aggregateShiftRateSeriesByDay,
  aggregateShiftSeriesByDay,
  authEmailToUsername,
  benchFromAuthEmail,
  formatClockTime,
  formatDateKey,
  formatDateLabel,
  formatMinutes,
  getShiftDayKey,
  summarizeWorkerJobs
} from "./jobs.js";

const CALENDAR_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CALENDAR_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// Human-readable label for the range trigger button. Shows one calendar the
// admin picks a start and end day from, so the button reflects the current
// selection ("18 Jul – 24 Jul 2026") or prompts when nothing is chosen yet.
export function formatRangeLabel(startKey, endKey) {
  if (startKey && endKey) {
    return `${formatDateLabel(startKey)} – ${formatDateLabel(endKey)}`;
  }
  if (startKey) {
    return `${formatDateLabel(startKey)} – …`;
  }
  return "Select dates";
}

// Render a single month calendar the admin taps to choose a start day then an
// end day. `startKey`/`endKey` (YYYY-MM-DD) highlight the current selection and
// the days between. `handlers` gets onPrevMonth/onNextMonth/onPickDay(dayKey).
export function renderRangeCalendar(container, viewYear, viewMonth, startKey, endKey, handlers) {
  container.innerHTML = "";

  const head = document.createElement("div");
  head.className = "calendar-head";

  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "calendar-nav";
  prev.textContent = "‹";
  prev.setAttribute("aria-label", "Previous month");
  prev.addEventListener("click", () => handlers.onPrevMonth?.());

  const title = document.createElement("span");
  title.className = "calendar-title";
  title.textContent = `${CALENDAR_MONTHS[viewMonth]} ${viewYear}`;

  const next = document.createElement("button");
  next.type = "button";
  next.className = "calendar-nav";
  next.textContent = "›";
  next.setAttribute("aria-label", "Next month");
  next.addEventListener("click", () => handlers.onNextMonth?.());

  head.append(prev, title, next);
  container.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "calendar-grid";

  CALENDAR_WEEKDAYS.forEach((weekday) => {
    const cell = document.createElement("span");
    cell.className = "calendar-weekday";
    cell.textContent = weekday;
    grid.appendChild(cell);
  });

  // Blank cells before the 1st so weekdays line up. JS getDay() is Sun=0; shift
  // to a Monday-first week.
  const firstDow = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7;
  for (let i = 0; i < firstDow; i += 1) {
    const blank = document.createElement("span");
    blank.className = "calendar-day is-empty";
    grid.appendChild(blank);
  }

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayKey = formatDateKey(new Date());
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = formatDateKey(new Date(viewYear, viewMonth, day));
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "calendar-day";
    cell.textContent = String(day);
    if (key === todayKey) {
      cell.classList.add("is-today");
    }
    if (startKey && key === startKey) {
      cell.classList.add("is-start");
    }
    if (endKey && key === endKey) {
      cell.classList.add("is-end");
    }
    if (startKey && endKey && key > startKey && key < endKey) {
      cell.classList.add("in-range");
    }
    cell.addEventListener("click", () => handlers.onPickDay?.(key));
    grid.appendChild(cell);
  }

  container.appendChild(grid);
}

export function getElements() {
  return {
    loginLink: document.getElementById("loginLink"),
    logoutButton: document.getElementById("logoutButton"),
    signedInPanel: document.getElementById("signedInPanel"),
    currentUserEmail: document.getElementById("currentUserEmail"),
    tabButtons: Array.from(document.querySelectorAll("[data-job-tab]")),
    workersTabButton: document.getElementById("workersTabButton"),
    jobTypeToggle: document.getElementById("jobTypeToggle"),
    jobTypeButtons: Array.from(document.querySelectorAll("[data-job-type]")),
    shiftToggle: document.getElementById("shiftToggle"),
    shiftButtons: Array.from(document.querySelectorAll("[data-shift]")),
    editBanner: document.getElementById("editBanner"),
    editBannerText: document.getElementById("editBannerText"),
    cancelEditButton: document.getElementById("cancelEditButton"),
    contentSection: document.querySelector(".content"),
    jobHistoryPanel: document.getElementById("jobHistoryPanel"),
    workerHistoryPanel: document.getElementById("workerHistoryPanel"),
    workerHistorySelect: document.getElementById("workerHistorySelect"),
    workerRangeSelect: document.getElementById("workerRangeSelect"),
    workerCustomRange: document.getElementById("workerCustomRange"),
    workerRangeTrigger: document.getElementById("workerRangeTrigger"),
    workerRangeText: document.getElementById("workerRangeText"),
    workerCalendar: document.getElementById("workerCalendar"),
    benchFilterSelect: document.getElementById("benchFilterSelect"),
    showHiddenJobs: document.getElementById("showHiddenJobs"),
    whJobs: document.getElementById("whJobs"),
    whAvgMetres: document.getElementById("whAvgMetres"),
    whAvgScrews: document.getElementById("whAvgScrews"),
    whTimeLost: document.getElementById("whTimeLost"),
    workerMetresChartCanvas: document.getElementById("workerMetresChart"),
    workerScrewsChartCanvas: document.getElementById("workerScrewsChart"),
    workerTrussMetresShiftChartCanvas: document.getElementById("workerTrussMetresShiftChart"),
    workerWallMetresShiftChartCanvas: document.getElementById("workerWallMetresShiftChart"),
    workerScrewsShiftChartCanvas: document.getElementById("workerScrewsShiftChart"),
    workerBenchMetresChartCanvas: document.getElementById("workerBenchMetresChart"),
    workerBenchScrewsChartCanvas: document.getElementById("workerBenchScrewsChart"),
    workerJobsList: document.getElementById("workerJobsList"),
    workerJobsEmpty: document.getElementById("workerJobsEmpty"),
    workerJobsTitle: document.getElementById("workerJobsTitle"),
    workerJobsClearDay: document.getElementById("workerJobsClearDay"),
    tabTitle: document.getElementById("tabTitle"),
    tabDescription: document.getElementById("tabDescription"),
    activeTabLabel: document.getElementById("activeTabLabel"),
    workDateInput: document.getElementById("workDate"),
    dateModeToggle: document.getElementById("dateModeToggle"),
    dateModeButtons: Array.from(document.querySelectorAll("[data-date-mode]")),
    benchSelect: document.getElementById("benchNumber"),
    startTimeInput: document.getElementById("startTime"),
    startTimeMeridiem: document.getElementById("startTimeMeridiem"),
    endTimeInput: document.getElementById("endTime"),
    endTimeMeridiem: document.getElementById("endTimeMeridiem"),
    strapStartInput: document.getElementById("strapStart"),
    strapEndInput: document.getElementById("strapEnd"),
    workerField: document.getElementById("workerField"),
    workerManage: document.getElementById("workerManage"),
    workerNameInput: document.getElementById("workerNameInput"),
    addWorkerButton: document.getElementById("addWorkerButton"),
    workerList: document.getElementById("workerList"),
    workerEmpty: document.getElementById("workerEmpty"),
    workerStatus: document.getElementById("workerStatus"),
    adminManage: document.getElementById("adminManage"),
    adminEmailInput: document.getElementById("adminEmailInput"),
    addAdminButton: document.getElementById("addAdminButton"),
    adminList: document.getElementById("adminList"),
    adminEmpty: document.getElementById("adminEmpty"),
    adminStatus: document.getElementById("adminStatus"),
    workerPicker: document.getElementById("workerPicker"),
    workerPickerSummary: document.getElementById("workerPickerSummary"),
    workerPickerSearch: document.getElementById("workerPickerSearch"),
    workerPickerCrews: document.getElementById("workerPickerCrews"),
    workerPickerOptions: document.getElementById("workerPickerOptions"),
    trussImport: document.getElementById("trussImport"),
    importLabel: document.getElementById("importLabel"),
    trussDropzone: document.getElementById("trussDropzone"),
    trussFileInput: document.getElementById("trussFileInput"),
    trussImportStatus: document.getElementById("trussImportStatus"),
    importLibrary: document.getElementById("importLibrary"),
    importLibraryList: document.getElementById("importLibraryList"),
    trussListWrap: document.getElementById("trussListWrap"),
    trussList: document.getElementById("trussList"),
    trussSelectedSummary: document.getElementById("trussSelectedSummary"),
    trussTickAllButton: document.getElementById("trussTickAllButton"),
    trussClearButton: document.getElementById("trussClearButton"),
    amountLabel: document.getElementById("amountLabel"),
    amountInput: document.getElementById("amountInput"),
    addAmountButton: document.getElementById("addAmountButton"),
    endJobButton: document.getElementById("endJobButton"),
    break15Input: document.getElementById("break15"),
    break24Input: document.getElementById("break24"),
    rangeSelect: document.getElementById("rangeSelect"),
    workedTimeOutput: document.getElementById("workedTime"),
    breakTimeOutput: document.getElementById("breakTime"),
    strapTimeOutput: document.getElementById("strapTime"),
    totalUnitsStat: document.getElementById("totalUnitsStat"),
    totalUnitsLabel: document.getElementById("totalUnitsLabel"),
    totalUnitsOutput: document.getElementById("totalUnitsDisplay"),
    entriesTitle: document.getElementById("entriesTitle"),
    entriesEmpty: document.getElementById("entriesEmpty"),
    entriesOutput: document.getElementById("entriesList"),
    rateLabel: document.getElementById("rateLabel"),
    rateOutput: document.getElementById("rate"),
    statusMessage: document.getElementById("statusMessage"),
    formAlert: document.getElementById("formAlert"),
    formAlertIcon: document.getElementById("formAlertIcon"),
    formAlertText: document.getElementById("formAlertText"),
    saveToast: document.getElementById("saveToast"),
    saveToastText: document.getElementById("saveToastText"),
    historyTitle: document.getElementById("historyTitle"),
    totalChartTitle: document.getElementById("totalChartTitle"),
    rateChartTitle: document.getElementById("rateChartTitle"),
    totalChartCanvas: document.getElementById("totalChart"),
    rateChartCanvas: document.getElementById("rateChart")
  };
}

export function setStatus(elements, message, tone = "hint") {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = tone === "warning" || tone === "success" ? `hint ${tone}` : "hint";
}

// Red "you missed a required field" alert under the End job button, re-triggering
// the shake each time so a repeated tap still draws the eye.
export function showFormWarning(elements, message) {
  elements.formAlertText.textContent = message;
  elements.formAlert.classList.remove("hidden", "shake");
  // Force reflow so the animation restarts even when the alert is already shown.
  void elements.formAlert.offsetWidth;
  elements.formAlert.classList.add("shake");
}

export function clearFormWarning(elements) {
  elements.formAlert.classList.add("hidden");
  elements.formAlert.classList.remove("shake");
  elements.formAlertText.textContent = "";
}

// A prominent centred pop-up confirming a job was saved/updated. It floats over
// the page (more visible than an inline banner) and auto-dismisses.
let saveToastTimer = null;

export function showSaveToast(elements, message) {
  const toast = elements.saveToast;
  if (!toast) {
    return;
  }
  if (saveToastTimer !== null) {
    clearTimeout(saveToastTimer);
    saveToastTimer = null;
  }
  elements.saveToastText.textContent = message;
  toast.hidden = false;
  toast.classList.remove("is-leaving", "show");
  void toast.offsetWidth;
  toast.classList.add("show");

  saveToastTimer = setTimeout(() => {
    toast.classList.add("is-leaving");
    saveToastTimer = setTimeout(() => {
      toast.hidden = true;
      toast.classList.remove("show", "is-leaving");
      saveToastTimer = null;
    }, 320);
  }, 2600);
}

export function renderAuthState(elements, user) {
  const isSignedIn = Boolean(user);

  elements.loginLink.classList.toggle("hidden", isSignedIn);
  elements.signedInPanel.classList.toggle("hidden", !isSignedIn);
  elements.signedInPanel.hidden = !isSignedIn;
  elements.endJobButton.disabled = !isSignedIn;
  elements.rangeSelect.disabled = !isSignedIn;

  if (isSignedIn) {
    const bench = benchFromAuthEmail(user.email);
    elements.currentUserEmail.textContent = bench !== null
      ? `Bench ${bench}`
      : user.email ? authEmailToUsername(user.email) : "Signed-in user";
    return;
  }

  elements.currentUserEmail.textContent = "";
}

export function renderTabState(elements, config, activeTab) {
  elements.tabTitle.textContent = config.label;
  elements.activeTabLabel.textContent = config.label;
  elements.tabDescription.textContent =
    activeTab === "trusses"
      ? "Track linear metres for truss jobs and see your metres per hour."
      : "Track screws for wall jobs and see your screws per hour.";
  elements.amountLabel.textContent = config.addLabel;
  elements.amountInput.placeholder = activeTab === "trusses" ? "Enter metres" : "Enter screws";
  elements.amountInput.step = activeTab === "trusses" ? "0.01" : "1";
  elements.addAmountButton.textContent = config.addButtonLabel;
  elements.totalUnitsLabel.textContent = config.unitLabel;
  elements.entriesTitle.textContent = "Added Entries";
  elements.entriesEmpty.textContent = config.emptyEntriesText;
  elements.rateLabel.textContent = config.rateLabel;
  elements.historyTitle.textContent = `${config.label} History`;
  elements.totalChartTitle.textContent = config.chartTotalTitle;
  elements.rateChartTitle.textContent = config.chartRateTitle;

  elements.tabButtons.forEach((button) => {
    const isActive = isTabButtonActive(button.dataset.jobTab, activeTab);
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
}

export function renderEntries(elements, entries, config, onRemove) {
  elements.entriesOutput.innerHTML = "";
  elements.entriesEmpty.hidden = entries.length > 0;

  entries.forEach((entry, index) => {
    const item = document.createElement("li");
    item.className = "entry-row";

    const text = document.createElement("span");
    text.className = "entry-text";
    text.textContent = config.entryText(entry);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "entry-remove";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => onRemove(index));

    item.append(text, removeButton);
    elements.entriesOutput.appendChild(item);
  });
}

export function renderCalculator(elements, calculatorViewModel, config) {
  const decimals = config.key === "trusses" ? 2 : 0;
  elements.totalUnitsOutput.textContent = `${calculatorViewModel.totalAmount.toFixed(decimals)} ${config.shortUnit}`;
  elements.breakTimeOutput.textContent = `${calculatorViewModel.breakMinutes}m`;
  elements.strapTimeOutput.textContent = `${calculatorViewModel.strapMinutes}m`;

  if (!calculatorViewModel.hasStartTime) {
    elements.workedTimeOutput.textContent = "0h 0m";
    elements.rateOutput.textContent = `0.00 ${config.rateShortUnit}`;
    setStatus(elements, config.emptyStatus);
    return;
  }

  elements.workedTimeOutput.textContent = formatMinutes(calculatorViewModel.netWorkedMinutes);
  elements.rateOutput.textContent = `${calculatorViewModel.rate.toFixed(2)} ${config.rateShortUnit}`;

  if (calculatorViewModel.breaksExceedWorkedTime) {
    setStatus(
      elements,
      calculatorViewModel.strapAbsorbedBreak
        ? "The break runs past the finish time, so the overflow was taken out of the strap & brace time."
        : "Breaks are longer than the worked time so it is held at zero.",
      "warning"
    );
    return;
  }

  setStatus(
    elements,
    calculatorViewModel.hasEndTime
      ? "Worked time is calculated from the selected start and end times with breaks removed."
      : "The total worked time updates live using the current time until you enter a finish time."
  );
}

export function renderHistory(elements, jobs, currentCharts, config) {
  const ChartLibrary = window.Chart;
  const aggregated = aggregateHistorySeriesByDay(jobs);
  const totalDecimals = config.key === "trusses" ? 2 : 0;
  const axisTickStyle = {
    color: "#2d2417",
    font: {
      size: 13,
      weight: "600"
    },
    padding: 8
  };
  const gridStyle = {
    color: "rgba(111, 96, 75, 0.14)",
    drawBorder: false
  };

  if (currentCharts.total) {
    currentCharts.total.destroy();
  }

  if (currentCharts.rate) {
    currentCharts.rate.destroy();
  }

  if (!ChartLibrary) {
    return { total: null, rate: null };
  }

  return {
    total: new ChartLibrary(elements.totalChartCanvas, {
      type: "bar",
      data: {
        labels: aggregated.labels,
        datasets: [
          {
            label: config.unitLabel,
            data: aggregated.totalValues,
            backgroundColor: "rgba(181, 83, 47, 0.88)",
            borderColor: "rgba(143, 63, 34, 1)",
            borderWidth: 1,
            borderRadius: 12,
            borderSkipped: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        layout: {
          padding: {
            top: 2
          }
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            callbacks: {
              label: (context) => `${context.parsed.y.toFixed(totalDecimals)} ${config.shortUnit}`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: gridStyle,
            ticks: {
              ...axisTickStyle,
              callback: (value) => `${Number(value).toFixed(totalDecimals)} ${config.shortUnit}`
            }
          },
          x: {
            grid: {
              display: false
            },
            ticks: axisTickStyle
          }
        }
      }
    }),
    rate: new ChartLibrary(elements.rateChartCanvas, {
      type: "line",
      data: {
        labels: aggregated.labels,
        datasets: [
          {
            label: config.rateLabel,
            data: aggregated.rateValues,
            borderColor: "rgba(181, 83, 47, 1)",
            backgroundColor: "rgba(181, 83, 47, 0.14)",
            fill: true,
            tension: 0.32,
            pointRadius: 4,
            pointHoverRadius: 5,
            pointBackgroundColor: "rgba(255, 250, 242, 1)",
            pointBorderColor: "rgba(143, 63, 34, 1)",
            pointBorderWidth: 2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        layout: {
          padding: {
            top: 2
          }
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            callbacks: {
              label: (context) => `${context.parsed.y.toFixed(2)} ${config.rateShortUnit}`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: gridStyle,
            ticks: {
              ...axisTickStyle,
              callback: (value) => `${value} ${config.rateShortUnit}`
            }
          },
          x: {
            grid: {
              display: false
            },
            ticks: axisTickStyle
          }
        }
      }
    })
  };
}

export function clearHistoryOutputs() {
  return null;
}

export function setWorkerStatus(elements, message, tone = "hint") {
  if (!elements.workerStatus) {
    return;
  }

  elements.workerStatus.textContent = message;
  elements.workerStatus.className = tone === "warning" || tone === "success" ? `hint ${tone}` : "hint";
}

// `showWorkerPicker` controls the "Workers on this job" field independently of
// the admin-only panels, so bench workers can pick their name without seeing the
// admin management/charts panels.
export function renderWorkerAdminVisibility(elements, isAdmin, showWorkerPicker = isAdmin) {
  elements.workerManage.classList.toggle("hidden", !isAdmin);
  elements.workerField.classList.toggle("hidden", !showWorkerPicker);
  elements.workersTabButton.classList.toggle("hidden", !isAdmin);
  if (elements.adminManage) {
    elements.adminManage.classList.toggle("hidden", !isAdmin);
  }
}

// Admin roster management (admin-only). Mirrors renderWorkerManagement, but the
// permanent super-admin (`superEmail`) shows an "Owner" tag and no Remove button
// so it can never be removed.
export function renderAdminManagement(elements, admins, superEmail, handlers) {
  elements.adminList.innerHTML = "";
  const superKey = String(superEmail).toLowerCase();

  // Always show the super-admin first, even if it has no roster doc.
  const emails = admins.map((admin) => String(admin.email).toLowerCase());
  const ordered = [superKey, ...emails.filter((email) => email !== superKey).sort()];

  elements.adminEmpty.hidden = ordered.length > 0;

  ordered.forEach((email) => {
    const item = document.createElement("li");
    item.className = "worker-row";

    const name = document.createElement("span");
    name.className = "worker-name";
    // Show the username; the owner's real email stays as-is.
    name.textContent = authEmailToUsername(email);

    item.appendChild(name);

    if (email === superKey) {
      const tag = document.createElement("span");
      tag.className = "admin-owner-tag";
      tag.textContent = "Owner";
      item.appendChild(tag);
    } else {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "entry-remove";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", () => handlers.onRemoveAdmin(email));
      item.appendChild(removeButton);
    }

    elements.adminList.appendChild(item);
  });
}

// Show the worker-history view (Charts tab) and the calculator/job history.
// `showJobHistory` is controlled separately so the admin can hide the
// trusses/screw charts entirely.
export function toggleWorkersView(elements, showWorkers, showJobHistory) {
  elements.contentSection.classList.toggle("hidden", showWorkers);
  elements.workerHistoryPanel.classList.toggle("hidden", !showWorkers);
  elements.workerHistoryPanel.hidden = !showWorkers;
  elements.jobHistoryPanel.classList.toggle("hidden", !showJobHistory);
}

// The "Log job" tab covers both job types, so it stays active for trusses and
// walls; other tabs match their key exactly.
function isTabButtonActive(buttonTab, activeTab) {
  if (buttonTab === "log") {
    return activeTab === "trusses" || activeTab === "walls";
  }
  return buttonTab === activeTab;
}

export function setActiveTabButtons(elements, activeTab) {
  elements.tabButtons.forEach((button) => {
    const isActive = isTabButtonActive(button.dataset.jobTab, activeTab);
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
}

// Highlight the active job type in the Trusses/Walls segmented toggle.
export function renderJobTypeToggle(elements, activeType) {
  elements.jobTypeButtons.forEach((button) => {
    const isActive = button.dataset.jobType === activeType;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

// Highlight the active shift in the Night/Morning/Afternoon segmented toggle.
export function renderShiftToggle(elements, shift) {
  elements.shiftButtons.forEach((button) => {
    const isActive = button.dataset.shift === shift;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

// Highlight the active work-date mode in the Auto/Manual segmented toggle.
export function renderDateModeToggle(elements, mode) {
  elements.dateModeButtons.forEach((button) => {
    const isActive = button.dataset.dateMode === mode;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

// Populate the worker dropdown in the Workers tab, returning the resolved
// selection. "all" aggregates every worker's jobs together.
export function renderWorkerHistorySelect(elements, workers, selectedId) {
  const select = elements.workerHistorySelect;
  select.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All workers";
  select.appendChild(allOption);

  workers.forEach((worker) => {
    const option = document.createElement("option");
    option.value = worker.id;
    // Ex-roster workers who still have logged jobs stay selectable so their
    // history remains viewable; flag them so it's clear they were removed.
    option.textContent = worker.removed ? `${worker.name} (removed)` : worker.name;
    select.appendChild(option);
  });

  const valid = selectedId === "all" || workers.some((worker) => worker.id === selectedId);
  const resolved = valid ? selectedId : "all";
  select.value = resolved;
  return resolved;
}

// Compact "Manage workers" dropdown: the list of workers with a remove button each.
export function renderWorkerManagement(elements, workers, handlers) {
  elements.workerList.innerHTML = "";
  elements.workerEmpty.hidden = workers.length > 0;

  workers.forEach((worker) => {
    const item = document.createElement("li");
    item.className = "worker-row";

    const name = document.createElement("span");
    name.className = "worker-name";
    name.textContent = worker.name;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "entry-remove";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => handlers.onRemoveWorker(worker.id));

    item.append(name, removeButton);
    elements.workerList.appendChild(item);
  });
}

// Per-job worker picker: pick one or more workers for this job (ad-hoc pairing).
// Returns the cleaned list of selected ids (dropping any that no longer exist).
export function renderWorkerPicker(elements, workers, selectedIds, onChange, recentCrews = []) {
  const validIds = selectedIds.filter((id) => workers.some((worker) => worker.id === id));
  const query = (elements.workerPickerSearch.value || "").trim().toLowerCase();
  const visible = query
    ? workers.filter((worker) => worker.name.toLowerCase().includes(query))
    : workers;

  // One-tap chips for recently used crews: tapping selects the whole crew.
  elements.workerPickerCrews.innerHTML = "";
  elements.workerPickerCrews.hidden = recentCrews.length === 0;
  recentCrews.forEach((crew) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "crew-chip";
    chip.textContent = crew.label;
    chip.addEventListener("click", () => onChange([...crew.ids]));
    elements.workerPickerCrews.appendChild(chip);
  });

  elements.workerPickerOptions.innerHTML = "";

  if (workers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "entry-empty";
    empty.textContent = "Add workers first using Manage workers above.";
    elements.workerPickerOptions.appendChild(empty);
  } else if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "entry-empty";
    empty.textContent = "No workers match your search.";
    elements.workerPickerOptions.appendChild(empty);
  }

  visible.forEach((worker) => {
    const option = document.createElement("label");
    option.className = "worker-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = worker.id;
    checkbox.checked = validIds.includes(worker.id);
    checkbox.addEventListener("change", () => {
      const next = checkbox.checked
        ? [...validIds, worker.id]
        : validIds.filter((id) => id !== worker.id);
      onChange(next);
    });

    const name = document.createElement("span");
    name.textContent = worker.name;

    option.append(checkbox, name);
    elements.workerPickerOptions.appendChild(option);
  });

  const selectedNames = workers
    .filter((worker) => validIds.includes(worker.id))
    .map((worker) => worker.name);
  elements.workerPickerSummary.textContent =
    selectedNames.length > 0 ? selectedNames.join(", ") : "No workers selected";

  return validIds;
}

function formatJobUnits(job) {
  return job.jobType === "walls"
    ? `${Math.round(job.totalUnits)} screws`
    : `${job.totalUnits.toFixed(2)} m`;
}

function formatJobRate(job) {
  return job.jobType === "walls"
    ? `${job.rate.toFixed(2)} screws/h`
    : `${job.rate.toFixed(2)} m/h`;
}

const RATE_AXIS_STYLE = {
  color: "#2d2417",
  font: { size: 13, weight: "600" },
  padding: 8
};

const SHIFT_BAR_COLORS = {
  morning:   { bg: "rgba(245, 158, 11, 0.85)",  border: "rgba(180, 113, 6, 1)" },
  afternoon: { bg: "rgba(181, 83, 47, 0.88)",   border: "rgba(143, 63, 34, 1)" },
  night:     { bg: "rgba(99, 102, 241, 0.85)",  border: "rgba(67, 56, 202, 1)" }
};

// Keep only the shifts that actually have data across the range. A shift with
// no jobs anywhere would otherwise still claim a slot inside every date group,
// pushing the remaining bar off to the side. Dropping it lets a single-shift
// worker's bar sit centred under each date. If nothing has data, keep the list
// as-is so the (empty) chart still renders its axes.
function activeShiftSeries(shifts) {
  const withData = shifts.filter((shift) => shift.values.some((value) => value > 0));
  return withData.length > 0 ? withData : shifts;
}

// Wire a bar/point chart so clicking a column drills into that day. `dayKeys`
// is aligned with the x-axis labels; the clicked element's index maps back to
// its day key, which is handed to `onDaySelect`. Also turns the cursor into a
// pointer while hovering a column so it reads as clickable. Returns options to
// spread into a Chart config; a no-op object when no handler is supplied.
function dayDrillOptions(dayKeys, onDaySelect, jobTypeFilter = null) {
  if (typeof onDaySelect !== "function") {
    return {};
  }
  return {
    onClick: (_event, active) => {
      if (active.length > 0) {
        const dayKey = dayKeys[active[0].index];
        if (dayKey) {
          // Each chart is specific to one job type, so tell the list which type
          // to show alongside the day (e.g. the screws chart → walls only).
          onDaySelect(dayKey, jobTypeFilter);
        }
      }
    },
    onHover: (event, active) => {
      const target = event?.native?.target;
      if (target) {
        target.style.cursor = active.length > 0 ? "pointer" : "default";
      }
    }
  };
}

// Grouped bar chart of the daily amount (metres or screws) per shift. The
// x-axis is each day; within a day there is one bar per shift so you can see
// how much each shift produced day by day, not one accumulated total.
function renderShiftChart(canvas, jobs, unit, currentChart, getValue, onDaySelect, jobTypeFilter = null) {
  const ChartLibrary = window.Chart;
  if (currentChart) {
    currentChart.destroy();
  }
  if (!ChartLibrary) {
    return null;
  }

  const series = aggregateShiftSeriesByDay(jobs, getValue);
  const decimals = unit === "screws" ? 0 : 2;

  const datasets = activeShiftSeries(series.shifts).map((shift) => ({
    label: shift.label,
    data: shift.values,
    backgroundColor: SHIFT_BAR_COLORS[shift.key]?.bg ?? "rgba(181,83,47,0.88)",
    borderColor: SHIFT_BAR_COLORS[shift.key]?.border ?? "rgba(143,63,34,1)",
    borderWidth: 1,
    borderRadius: 8,
    borderSkipped: false
  }));

  return new ChartLibrary(canvas, {
    type: "bar",
    data: {
      labels: series.labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      ...dayDrillOptions(series.dayKeys, onDaySelect, jobTypeFilter),
      plugins: {
        legend: { display: true, labels: { ...RATE_AXIS_STYLE } },
        tooltip: {
          callbacks: {
            label: (context) =>
              `${context.dataset.label}: ${context.parsed.y.toFixed(decimals)} ${unit}`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: "rgba(111, 96, 75, 0.14)", drawBorder: false },
          ticks: { ...RATE_AXIS_STYLE, callback: (value) => `${Number(value).toFixed(decimals)} ${unit}` }
        },
        x: {
          grid: { display: false },
          ticks: RATE_AXIS_STYLE
        }
      }
    }
  });
}

// Grouped bar chart of the rate (metres/hour or screws/hour) per shift. The
// x-axis is each shift-day; within it there is one bar per shift so you can
// read each shift's output rate. Overnight shifts stay in one column (grouped
// by shift-day, not calendar day).
function renderShiftRateChart(canvas, jobs, unit, currentChart, onDaySelect, jobTypeFilter = null) {
  const ChartLibrary = window.Chart;
  if (currentChart) {
    currentChart.destroy();
  }
  if (!ChartLibrary) {
    return null;
  }

  const series = aggregateShiftRateSeriesByDay(jobs);

  const datasets = activeShiftSeries(series.shifts).map((shift) => ({
    label: shift.label,
    data: shift.values,
    backgroundColor: SHIFT_BAR_COLORS[shift.key]?.bg ?? "rgba(181,83,47,0.88)",
    borderColor: SHIFT_BAR_COLORS[shift.key]?.border ?? "rgba(143,63,34,1)",
    borderWidth: 1,
    borderRadius: 8,
    borderSkipped: false
  }));

  return new ChartLibrary(canvas, {
    type: "bar",
    data: {
      labels: series.labels,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      ...dayDrillOptions(series.dayKeys, onDaySelect, jobTypeFilter),
      plugins: {
        legend: { display: true, labels: { ...RATE_AXIS_STYLE } },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${context.parsed.y.toFixed(2)} ${unit}/h`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: "rgba(111, 96, 75, 0.14)", drawBorder: false },
          ticks: { ...RATE_AXIS_STYLE, callback: (value) => `${value} ${unit}/h` }
        },
        x: {
          grid: { display: false },
          ticks: RATE_AXIS_STYLE
        }
      }
    }
  });
}

// Grouped bar chart of the amount (metres or screws) produced on each bench
// (1–19), split by shift. Each bench has one bar per shift so you can read how
// much each shift produced on that bench, not one accumulated bench total.
function renderBenchShiftChart(canvas, jobs, unit, currentChart, getValue) {
  const ChartLibrary = window.Chart;
  if (currentChart) {
    currentChart.destroy();
  }
  if (!ChartLibrary) {
    return null;
  }

  const series = aggregateBenchShiftTotals(jobs, getValue);
  const decimals = unit === "screws" ? 0 : 2;

  const datasets = activeShiftSeries(series.shifts).map((shift) => ({
    label: shift.label,
    data: shift.values,
    backgroundColor: SHIFT_BAR_COLORS[shift.key]?.bg ?? "rgba(181,83,47,0.88)",
    borderColor: SHIFT_BAR_COLORS[shift.key]?.border ?? "rgba(143,63,34,1)",
    borderWidth: 1,
    borderRadius: 8,
    borderSkipped: false
  }));

  return new ChartLibrary(canvas, {
    type: "bar",
    data: {
      // Use the bench number alone for a compact x-axis (the title says "bench").
      labels: series.labels.map((label) => label.replace("Bench ", "")),
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { ...RATE_AXIS_STYLE } },
        tooltip: {
          callbacks: {
            title: (items) => `Bench ${items[0].label}`,
            label: (context) =>
              `${context.dataset.label}: ${context.parsed.y.toFixed(decimals)} ${unit}`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: "rgba(111, 96, 75, 0.14)", drawBorder: false },
          ticks: { ...RATE_AXIS_STYLE, callback: (value) => `${Number(value).toFixed(decimals)} ${unit}` }
        },
        x: {
          grid: { display: false },
          // Show every bench (1–19); don't let Chart.js drop labels to save space.
          ticks: { ...RATE_AXIS_STYLE, autoSkip: false }
        }
      }
    }
  });
}

// Render the Charts tab: average rate stats, rate-per-day charts and
// total-per-shift charts (metres and screws), and the job list. `workerName`
// labels co-workers on each job (empty for the "All workers" view). `charts`
// holds the existing charts so they can be destroyed before re-rendering.
// `handlers.onRemoveJob` (admin only) deletes a job from the log.
export function renderWorkerHistory(elements, jobs, workerName, charts, handlers = {}) {
  // Charts and stats always exclude hidden jobs.
  const visibleJobs = jobs.filter((job) => !job.hidden);
  const summary = summarizeWorkerJobs(visibleJobs);
  elements.whJobs.textContent = String(summary.jobs);
  elements.whAvgMetres.textContent = `${summary.avgMetresPerHour.toFixed(2)} m/h`;
  elements.whAvgScrews.textContent = `${summary.avgScrewsPerHour.toFixed(2)} screws/h`;
  elements.whTimeLost.textContent = formatMinutes(summary.avgStrapMinutes);

  // The list shows visible jobs; hidden ones appear only when "Show hidden" is on
  // so they can be unhidden. (Both already sorted newest-first by the caller.)
  let listJobs = handlers.showHidden ? jobs : visibleJobs;

  // When a chart bar is clicked, narrow the list to that shift-day only. Match
  // on getShiftDayKey so it lines up with how the charts bucket the day (night
  // work after midnight belongs to the previous evening).
  const selectedDayKey = handlers.selectedDayKey || null;
  if (selectedDayKey) {
    listJobs = listJobs.filter((job) => getShiftDayKey(job) === selectedDayKey);
  }

  // The clicked chart is specific to one job type (trusses or walls), so narrow
  // the drilled-in list to that type — e.g. the screws chart shows walls only.
  const selectedJobType = handlers.selectedJobType || null;
  if (selectedDayKey && selectedJobType) {
    listJobs = listJobs.filter(
      (job) => (job.jobType === "walls" ? "walls" : "trusses") === selectedJobType
    );
  }

  if (elements.workerJobsTitle) {
    const typeLabelForTitle =
      selectedDayKey && selectedJobType ? (selectedJobType === "walls" ? "Walls" : "Trusses") : "";
    elements.workerJobsTitle.textContent = selectedDayKey
      ? `Logged jobs · ${typeLabelForTitle ? `${typeLabelForTitle} · ` : ""}${formatDateLabel(selectedDayKey)}`
      : "Logged jobs";
  }
  if (elements.workerJobsClearDay) {
    elements.workerJobsClearDay.classList.toggle("hidden", !selectedDayKey);
  }

  elements.workerJobsList.innerHTML = "";
  elements.workerJobsEmpty.hidden = listJobs.length > 0;
  if (selectedDayKey) {
    elements.workerJobsEmpty.textContent = "No jobs logged on this day.";
  } else {
    elements.workerJobsEmpty.textContent = "No jobs logged for this worker yet.";
  }

  listJobs.forEach((job) => {
    const item = document.createElement("li");
    item.className = job.hidden ? "entry-row is-hidden-job" : "entry-row";

    // Show the source list's job number (e.g. "512621") so each logged row can
    // be traced back to its job. Only jobs logged from an import carry one.
    if (job.jobNumber) {
      const jobNumberBadge = document.createElement("span");
      jobNumberBadge.className = "entry-job-number";
      jobNumberBadge.textContent = `#${job.jobNumber}`;
      item.appendChild(jobNumberBadge);
    }

    const text = document.createElement("span");
    text.className = "entry-text";
    const typeLabel = job.jobType === "walls" ? "Walls" : "Trusses";
    const coworkers = (job.assignedWorkers || [])
      .map((worker) => worker.name)
      .filter((name) => name && name !== workerName);
    const withText = coworkers.length > 0 ? ` · with ${coworkers.join(" & ")}` : "";
    const strapText = job.strapMinutes > 0 ? ` · strap ${job.strapMinutes}m` : "";
    const benchText = job.benchNumber ? ` · Bench ${job.benchNumber}` : "";
    const startText = formatClockTime(job.startedAt);
    const endText = formatClockTime(job.endedAt);
    const timeText = startText && endText ? ` · ${startText}–${endText}` : "";
    const jobLabel =
      `${formatDateLabel(job.dayKey)}${timeText} · ${typeLabel}${benchText} · ${formatJobUnits(job)} · ` +
      `${formatMinutes(job.netWorkedMinutes)} · ${formatJobRate(job)}${strapText}${withText}`;
    text.textContent = job.hidden ? `${jobLabel} · hidden` : jobLabel;

    item.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "entry-actions";

    if (typeof handlers.onEditJob === "function" && job.id) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "entry-action";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => handlers.onEditJob(job));
      actions.appendChild(editButton);
    }

    if (typeof handlers.onHideJob === "function" && job.id) {
      const hideButton = document.createElement("button");
      hideButton.type = "button";
      hideButton.className = "entry-action";
      hideButton.textContent = job.hidden ? "Unhide" : "Hide";
      hideButton.addEventListener("click", () => handlers.onHideJob(job.id, !job.hidden));
      actions.appendChild(hideButton);
    }

    if (typeof handlers.onRemoveJob === "function" && job.id) {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "entry-remove";
      removeButton.textContent = "Delete";
      removeButton.addEventListener("click", () => {
        if (window.confirm(`Delete this job?\n\n${jobLabel}`)) {
          handlers.onRemoveJob(job.id);
        }
      });
      actions.appendChild(removeButton);
    }

    if (actions.childElementCount > 0) {
      item.appendChild(actions);
    }

    elements.workerJobsList.appendChild(item);
  });

  const trussJobs = visibleJobs.filter((job) => job.jobType !== "walls");
  const wallJobs = visibleJobs.filter((job) => job.jobType === "walls");
  const existing = charts || {};

  const onDaySelect = handlers.onDaySelect;

  return {
    // Output rate per shift (overnight shifts stay in one column, not split
    // across two calendar days). Clicking a day drills the list into that day.
    // Each shift chart is job-type-specific, so drilling into a day also narrows
    // the list to that type (e.g. the screws chart shows walls only, not trusses).
    metres: renderShiftRateChart(elements.workerMetresChartCanvas, trussJobs, "m", existing.metres, onDaySelect, "trusses"),
    screws: renderShiftRateChart(elements.workerScrewsChartCanvas, wallJobs, "screws", existing.screws, onDaySelect, "walls"),
    // Metres are split by job type: trusses' metres are their units, while wall
    // metres come from the panels' lineal M. Screws stay wall-only.
    trussMetresShift: renderShiftChart(elements.workerTrussMetresShiftChartCanvas, trussJobs, "m", existing.trussMetresShift, (job) => job.metres, onDaySelect, "trusses"),
    wallMetresShift: renderShiftChart(elements.workerWallMetresShiftChartCanvas, wallJobs, "m", existing.wallMetresShift, (job) => job.metres, onDaySelect, "walls"),
    screwsShift: renderShiftChart(elements.workerScrewsShiftChartCanvas, wallJobs, "screws", existing.screwsShift, (job) => job.totalUnits, onDaySelect, "walls"),
    // Per-bench totals: metres spans all jobs (trusses + wall-panel metres),
    // screws stay wall-only.
    benchMetres: renderBenchShiftChart(elements.workerBenchMetresChartCanvas, visibleJobs, "m", existing.benchMetres, (job) => job.metres),
    benchScrews: renderBenchShiftChart(elements.workerBenchScrewsChartCanvas, wallJobs, "screws", existing.benchScrews, (job) => job.totalUnits)
  };
}

// Render the merged list of preloaded jobs (both trusses and walls). Each row
// shows a type badge, loads its rows when tapped, and can be removed with the ×
// button. A row is highlighted only when it is the loaded job of the active
// type. `jobs` are `{ id, title, rows, type }`; `handlers` are
// `onSelect(type, id)` / `onRemove(type, id)`.
export function renderImportLibrary(elements, jobs, activeType, activeId, handlers = {}) {
  const hasJobs = jobs.length > 0;
  elements.importLibrary.classList.toggle("hidden", !hasJobs);
  elements.importLibraryList.innerHTML = "";

  jobs.forEach((job) => {
    const item = document.createElement("li");
    item.className = "import-library-row";
    if (job.type === activeType && job.id === activeId) {
      item.classList.add("is-active");
    }

    const select = document.createElement("button");
    select.type = "button";
    select.className = "import-library-select";
    const count = job.rows.length;
    const typeLabel = job.type === "walls" ? "Walls" : "Trusses";
    select.innerHTML =
      `<span class="import-library-title">` +
      `<span class="import-library-type import-library-type-${job.type}">${typeLabel}</span>` +
      `${job.title}</span>` +
      `<span class="import-library-count">${count} row${count === 1 ? "" : "s"}</span>`;
    select.addEventListener("click", () => handlers.onSelect?.(job.type, job.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "import-library-remove";
    remove.setAttribute("aria-label", `Remove ${job.title}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => handlers.onRemove?.(job.type, job.id));

    item.append(select, remove);
    elements.importLibraryList.appendChild(item);
  });
}

// Render the imported cut-list checklist. `config` controls how each row's
// value is read and formatted (metres for trusses, screws for walls).
// `onToggle(index, done)` fires when a row is ticked/unticked.
export function renderImportList(elements, rows, config, onToggle) {
  const hasRows = rows.length > 0;
  elements.trussListWrap.classList.toggle("hidden", !hasRows);
  elements.trussList.innerHTML = "";

  rows.forEach((row, index) => {
    const item = document.createElement("li");
    item.className = "truss-row";
    // Lets the drag-to-select gesture map the row under the pointer to its row.
    item.dataset.index = String(index);

    const label = document.createElement("label");
    label.className = "truss-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(row.done);
    checkbox.addEventListener("change", () => onToggle(index, checkbox.checked));

    const text = document.createElement("span");
    text.className = "truss-text";
    // Rows saved with an earlier job this shift are tagged so the next crew
    // can see what's already been logged.
    const loggedBadge = row.loggedCount
      ? `<span class="truss-logged">logged${row.loggedCount > 1 ? ` ×${row.loggedCount}` : ""}</span>`
      : "";
    text.innerHTML =
      `<span class="truss-name">${row.no}. ${row.number}${loggedBadge}</span>` +
      `<span class="truss-metres">${config.format(config.value(row))}</span>`;

    label.append(checkbox, text);
    item.appendChild(label);
    elements.trussList.appendChild(item);
  });

  const ticked = rows.filter((row) => row.done);
  const tickedTotal = ticked.reduce((total, row) => total + config.value(row), 0);
  elements.trussSelectedSummary.textContent = hasRows
    ? `${ticked.length} of ${rows.length} ticked · ${config.format(tickedTotal)}`
    : `${ticked.length} of ${rows.length} ticked`;

  // The tick-all control flips to "Untick all" once every row is ticked, so the
  // one button both selects and clears the whole list.
  if (elements.trussTickAllButton) {
    const allTicked = hasRows && ticked.length === rows.length;
    elements.trussTickAllButton.textContent = allTicked ? "Untick all" : "Tick all";
  }
}

export function setImportLabels(elements, label) {
  elements.importLabel.textContent = label;
}

export function setImportStatus(elements, message, tone = "hint") {
  elements.trussImportStatus.textContent = message;
  elements.trussImportStatus.className =
    tone === "warning" || tone === "success" ? `hint ${tone}` : "hint";
}

export function setImportVisible(elements, visible) {
  elements.trussImport.classList.toggle("hidden", !visible);
}
