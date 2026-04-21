import {
  aggregateHistorySeriesByDay,
  formatMinutes
} from "./jobs.js";

export function getElements() {
  return {
    loginLink: document.getElementById("loginLink"),
    logoutButton: document.getElementById("logoutButton"),
    signedInPanel: document.getElementById("signedInPanel"),
    currentUserEmail: document.getElementById("currentUserEmail"),
    startTimeInput: document.getElementById("startTime"),
    endTimeInput: document.getElementById("endTime"),
    metresInput: document.getElementById("metres"),
    addMetresButton: document.getElementById("addMetresButton"),
    endJobButton: document.getElementById("endJobButton"),
    break15Input: document.getElementById("break15"),
    break24Input: document.getElementById("break24"),
    rangeSelect: document.getElementById("rangeSelect"),
    workedTimeOutput: document.getElementById("workedTime"),
    breakTimeOutput: document.getElementById("breakTime"),
    metresOutput: document.getElementById("metresDisplay"),
    metresEntriesOutput: document.getElementById("metresEntries"),
    rateOutput: document.getElementById("rate"),
    statusMessage: document.getElementById("statusMessage"),
    metresChartCanvas: document.getElementById("metresChart"),
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
  elements.endJobButton.disabled = !isSignedIn;
  elements.rangeSelect.disabled = !isSignedIn;

  if (isSignedIn) {
    elements.currentUserEmail.textContent = user.email ?? "Signed-in user";
    return;
  }

  elements.currentUserEmail.textContent = "";
}

export function renderMetreEntries(elements, metreEntries, onRemove) {
  elements.metresEntriesOutput.innerHTML = "";

  metreEntries.forEach((entry, index) => {
    const item = document.createElement("li");
    item.className = "entry-row";

    const text = document.createElement("span");
    text.className = "entry-text";
    text.textContent = `${entry.metres.toFixed(2)} m added at ${entry.timeLabel}`;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "entry-remove";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => onRemove(index));

    item.append(text, removeButton);
    elements.metresEntriesOutput.appendChild(item);
  });
}

export function renderCalculator(elements, calculatorViewModel) {
  elements.metresOutput.textContent = `${calculatorViewModel.metres.toFixed(2)} m`;
  elements.breakTimeOutput.textContent = `${calculatorViewModel.breakMinutes}m`;

  if (!calculatorViewModel.hasStartTime) {
    elements.workedTimeOutput.textContent = "0h 0m";
    elements.rateOutput.textContent = "0.00 m/h";
    setStatus(
      elements,
      "Choose a start time to begin calculating. You can leave time ended empty for a live count."
    );
    return;
  }

  elements.workedTimeOutput.textContent = formatMinutes(calculatorViewModel.netWorkedMinutes);
  elements.rateOutput.textContent = `${calculatorViewModel.rate.toFixed(2)} m/h`;

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

export function renderHistory(elements, historyViewModel, currentChart) {
  return renderCharts(elements, historyViewModel.jobs, currentChart);
}

function renderCharts(elements, jobs, currentChart) {
  const ChartLibrary = window.Chart;
  const aggregated = aggregateHistorySeriesByDay(jobs);

  if (currentChart.metres) {
    currentChart.metres.destroy();
  }

  if (currentChart.rate) {
    currentChart.rate.destroy();
  }

  if (!ChartLibrary) {
    return { metres: null, rate: null };
  }

  return {
    metres: new ChartLibrary(elements.metresChartCanvas, {
      type: "bar",
      data: {
        labels: aggregated.labels,
        datasets: [
          {
            label: "Linear metres",
            data: aggregated.metresValues,
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
              label: (context) => `${context.parsed.y.toFixed(2)} m`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: (value) => `${value} m`
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
            label: "Metres per hour",
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
              label: (context) => `${context.parsed.y.toFixed(2)} m/h`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: (value) => `${value} m/h`
            }
          }
        }
      }
    })
  };
}

export function clearHistoryOutputs(elements) {
  return null;
}
