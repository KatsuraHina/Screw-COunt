import {
  aggregateHistorySeriesByDay,
  aggregateShiftTotals,
  formatDateLabel,
  formatMinutes,
  summarizeWorkerJobs
} from "./jobs.js";

export function getElements() {
  return {
    loginLink: document.getElementById("loginLink"),
    logoutButton: document.getElementById("logoutButton"),
    signedInPanel: document.getElementById("signedInPanel"),
    currentUserEmail: document.getElementById("currentUserEmail"),
    tabButtons: Array.from(document.querySelectorAll("[data-job-tab]")),
    workersTabButton: document.getElementById("workersTabButton"),
    contentSection: document.querySelector(".content"),
    jobHistoryPanel: document.getElementById("jobHistoryPanel"),
    workerHistoryPanel: document.getElementById("workerHistoryPanel"),
    workerHistorySelect: document.getElementById("workerHistorySelect"),
    workerRangeSelect: document.getElementById("workerRangeSelect"),
    whJobs: document.getElementById("whJobs"),
    whAvgMetres: document.getElementById("whAvgMetres"),
    whAvgScrews: document.getElementById("whAvgScrews"),
    whTimeLost: document.getElementById("whTimeLost"),
    workerMetresChartCanvas: document.getElementById("workerMetresChart"),
    workerScrewsChartCanvas: document.getElementById("workerScrewsChart"),
    workerMetresShiftChartCanvas: document.getElementById("workerMetresShiftChart"),
    workerScrewsShiftChartCanvas: document.getElementById("workerScrewsShiftChart"),
    workerJobsList: document.getElementById("workerJobsList"),
    workerJobsEmpty: document.getElementById("workerJobsEmpty"),
    tabTitle: document.getElementById("tabTitle"),
    tabDescription: document.getElementById("tabDescription"),
    activeTabLabel: document.getElementById("activeTabLabel"),
    workDateInput: document.getElementById("workDate"),
    startTimeInput: document.getElementById("startTime"),
    endTimeInput: document.getElementById("endTime"),
    strapStartInput: document.getElementById("strapStart"),
    strapEndInput: document.getElementById("strapEnd"),
    workerField: document.getElementById("workerField"),
    workerManage: document.getElementById("workerManage"),
    workerNameInput: document.getElementById("workerNameInput"),
    addWorkerButton: document.getElementById("addWorkerButton"),
    workerList: document.getElementById("workerList"),
    workerEmpty: document.getElementById("workerEmpty"),
    workerStatus: document.getElementById("workerStatus"),
    workerPicker: document.getElementById("workerPicker"),
    workerPickerSummary: document.getElementById("workerPickerSummary"),
    workerPickerSearch: document.getElementById("workerPickerSearch"),
    workerPickerOptions: document.getElementById("workerPickerOptions"),
    trussImport: document.getElementById("trussImport"),
    importLabel: document.getElementById("importLabel"),
    importColumn: document.getElementById("importColumn"),
    trussDropzone: document.getElementById("trussDropzone"),
    trussFileInput: document.getElementById("trussFileInput"),
    trussImportStatus: document.getElementById("trussImportStatus"),
    trussListWrap: document.getElementById("trussListWrap"),
    trussList: document.getElementById("trussList"),
    trussSelectedSummary: document.getElementById("trussSelectedSummary"),
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
    historyTitle: document.getElementById("historyTitle"),
    historyDescription: document.getElementById("historyDescription"),
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

export function renderAuthState(elements, user) {
  const isSignedIn = Boolean(user);

  elements.loginLink.classList.toggle("hidden", isSignedIn);
  elements.signedInPanel.classList.toggle("hidden", !isSignedIn);
  elements.signedInPanel.hidden = !isSignedIn;
  elements.endJobButton.disabled = !isSignedIn;
  elements.rangeSelect.disabled = !isSignedIn;

  if (isSignedIn) {
    elements.currentUserEmail.textContent = user.email ?? "Signed-in user";
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
  elements.historyDescription.textContent = "Multiple jobs on the same day are grouped together into one daily result.";
  elements.totalChartTitle.textContent = config.chartTotalTitle;
  elements.rateChartTitle.textContent = config.chartRateTitle;

  elements.tabButtons.forEach((button) => {
    const isActive = button.dataset.jobTab === activeTab;
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
      "Breaks and strap time are longer than the worked time so it is held at zero.",
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

export function renderWorkerAdminVisibility(elements, isAdmin) {
  elements.workerManage.classList.toggle("hidden", !isAdmin);
  elements.workerField.classList.toggle("hidden", !isAdmin);
  elements.workersTabButton.classList.toggle("hidden", !isAdmin);
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

export function setActiveTabButtons(elements, activeTab) {
  elements.tabButtons.forEach((button) => {
    const isActive = button.dataset.jobTab === activeTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
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
    option.textContent = worker.name;
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
export function renderWorkerPicker(elements, workers, selectedIds, onChange) {
  const validIds = selectedIds.filter((id) => workers.some((worker) => worker.id === id));
  const query = (elements.workerPickerSearch.value || "").trim().toLowerCase();
  const visible = query
    ? workers.filter((worker) => worker.name.toLowerCase().includes(query))
    : workers;

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

function renderRateChart(canvas, jobs, unit, currentChart) {
  const ChartLibrary = window.Chart;
  if (currentChart) {
    currentChart.destroy();
  }
  if (!ChartLibrary) {
    return null;
  }

  const aggregated = aggregateHistorySeriesByDay(jobs);

  return new ChartLibrary(canvas, {
    type: "line",
    data: {
      labels: aggregated.labels,
      datasets: [
        {
          label: `${unit}/hour`,
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
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (context) => `${context.parsed.y.toFixed(2)} ${unit}/h` }
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

// Bar chart of total units (metres or screws) produced per shift.
function renderShiftChart(canvas, jobs, unit, currentChart, getValue) {
  const ChartLibrary = window.Chart;
  if (currentChart) {
    currentChart.destroy();
  }
  if (!ChartLibrary) {
    return null;
  }

  const aggregated = aggregateShiftTotals(jobs, getValue);
  const decimals = unit === "screws" ? 0 : 2;

  return new ChartLibrary(canvas, {
    type: "bar",
    data: {
      labels: aggregated.labels,
      datasets: [
        {
          label: `Total ${unit}`,
          data: aggregated.values,
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
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (context) => `${context.parsed.y.toFixed(decimals)} ${unit}` }
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

// Render the Charts tab: average rate stats, rate-per-day charts and
// total-per-shift charts (metres and screws), and the job list. `workerName`
// labels co-workers on each job (empty for the "All workers" view). `charts`
// holds the existing charts so they can be destroyed before re-rendering.
export function renderWorkerHistory(elements, jobs, workerName, charts) {
  const summary = summarizeWorkerJobs(jobs);
  elements.whJobs.textContent = String(summary.jobs);
  elements.whAvgMetres.textContent = `${summary.avgMetresPerHour.toFixed(2)} m/h`;
  elements.whAvgScrews.textContent = `${summary.avgScrewsPerHour.toFixed(2)} screws/h`;
  elements.whTimeLost.textContent = formatMinutes(summary.avgStrapMinutes);

  // Job list (already sorted newest-first by the caller)
  elements.workerJobsList.innerHTML = "";
  elements.workerJobsEmpty.hidden = jobs.length > 0;

  jobs.forEach((job) => {
    const item = document.createElement("li");
    item.className = "entry-row";

    const text = document.createElement("span");
    text.className = "entry-text";
    const typeLabel = job.jobType === "walls" ? "Walls" : "Trusses";
    const coworkers = (job.assignedWorkers || [])
      .map((worker) => worker.name)
      .filter((name) => name && name !== workerName);
    const withText = coworkers.length > 0 ? ` · with ${coworkers.join(" & ")}` : "";
    const strapText = job.strapMinutes > 0 ? ` · strap ${job.strapMinutes}m` : "";
    text.textContent =
      `${formatDateLabel(job.dayKey)} · ${typeLabel} · ${formatJobUnits(job)} · ` +
      `${formatMinutes(job.netWorkedMinutes)} · ${formatJobRate(job)}${strapText}${withText}`;

    item.appendChild(text);
    elements.workerJobsList.appendChild(item);
  });

  const trussJobs = jobs.filter((job) => job.jobType !== "walls");
  const wallJobs = jobs.filter((job) => job.jobType === "walls");
  const existing = charts || {};

  return {
    metres: renderRateChart(elements.workerMetresChartCanvas, trussJobs, "m", existing.metres),
    screws: renderRateChart(elements.workerScrewsChartCanvas, wallJobs, "screws", existing.screws),
    // Total metres includes wall panels' lineal metres, so aggregate over all
    // jobs by their metres field; screws stay wall-only.
    metresShift: renderShiftChart(elements.workerMetresShiftChartCanvas, jobs, "m", existing.metresShift, (job) => job.metres),
    screwsShift: renderShiftChart(elements.workerScrewsShiftChartCanvas, wallJobs, "screws", existing.screwsShift, (job) => job.totalUnits)
  };
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

    const label = document.createElement("label");
    label.className = "truss-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(row.done);
    checkbox.addEventListener("change", () => onToggle(index, checkbox.checked));

    const text = document.createElement("span");
    text.className = "truss-text";
    text.innerHTML =
      `<span class="truss-name">${row.no}. ${row.number}</span>` +
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
}

export function setImportLabels(elements, label, column) {
  elements.importLabel.textContent = label;
  elements.importColumn.textContent = column;
}

export function setImportStatus(elements, message, tone = "hint") {
  elements.trussImportStatus.textContent = message;
  elements.trussImportStatus.className =
    tone === "warning" || tone === "success" ? `hint ${tone}` : "hint";
}

export function setImportVisible(elements, visible) {
  elements.trussImport.classList.toggle("hidden", !visible);
}
