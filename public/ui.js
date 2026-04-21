import { aggregateHistorySeriesByDay, formatMinutes } from "./jobs.js";

export function getElements() {
  return {
    loginLink: document.getElementById("loginLink"),
    logoutButton: document.getElementById("logoutButton"),
    signedInPanel: document.getElementById("signedInPanel"),
    currentUserEmail: document.getElementById("currentUserEmail"),
    tabButtons: Array.from(document.querySelectorAll("[data-job-tab]")),
    tabTitle: document.getElementById("tabTitle"),
    tabDescription: document.getElementById("tabDescription"),
    activeTabLabel: document.getElementById("activeTabLabel"),
    startTimeInput: document.getElementById("startTime"),
    endTimeInput: document.getElementById("endTime"),
    amountLabel: document.getElementById("amountLabel"),
    amountInput: document.getElementById("amountInput"),
    addAmountButton: document.getElementById("addAmountButton"),
    endJobButton: document.getElementById("endJobButton"),
    break15Input: document.getElementById("break15"),
    break24Input: document.getElementById("break24"),
    rangeSelect: document.getElementById("rangeSelect"),
    workedTimeOutput: document.getElementById("workedTime"),
    breakTimeOutput: document.getElementById("breakTime"),
    totalUnitsLabel: document.getElementById("totalUnitsLabel"),
    totalUnitsOutput: document.getElementById("totalUnitsDisplay"),
    entriesTitle: document.getElementById("entriesTitle"),
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
  elements.statusMessage.className = tone === "warning" ? "hint warning" : "hint";
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
  elements.amountInput.placeholder = activeTab === "trusses" ? "Enter metres to add" : "Enter screws to add";
  elements.amountInput.step = activeTab === "trusses" ? "0.01" : "1";
  elements.addAmountButton.textContent = config.addButtonLabel;
  elements.totalUnitsLabel.textContent = config.unitLabel;
  elements.entriesTitle.textContent = "Added Entries";
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
      "Selected breaks are longer than the worked time so the total is held at zero.",
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
            backgroundColor: "rgba(181, 83, 47, 0.72)",
            borderColor: "rgba(143, 63, 34, 1)",
            borderWidth: 1.5,
            borderRadius: 10
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
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
            ticks: {
              callback: (value) => `${Number(value).toFixed(totalDecimals)} ${config.shortUnit}`
            }
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
            borderColor: "rgba(111, 96, 75, 1)",
            backgroundColor: "rgba(111, 96, 75, 0.16)",
            fill: true,
            tension: 0.25,
            pointRadius: 4,
            pointHoverRadius: 5
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
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
            ticks: {
              callback: (value) => `${value} ${config.rateShortUnit}`
            }
          }
        }
      }
    })
  };
}

export function clearHistoryOutputs() {
  return null;
}
