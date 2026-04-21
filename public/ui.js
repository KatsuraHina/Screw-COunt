import {
  aggregateJobsByDay,
  formatDateTime,
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
    historyTotalMetresOutput: document.getElementById("historyTotalMetres"),
    historyJobCountOutput: document.getElementById("historyJobCount"),
    historyAverageOutput: document.getElementById("historyAverage"),
    jobHistoryList: document.getElementById("jobHistoryList"),
    jobsChartCanvas: document.getElementById("jobsChart")
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
  elements.historyTotalMetresOutput.textContent = `${historyViewModel.totalMetres.toFixed(2)} m`;
  elements.historyJobCountOutput.textContent = String(historyViewModel.jobs.length);
  elements.historyAverageOutput.textContent = `${historyViewModel.averagePerDay.toFixed(2)} m`;

  renderJobList(elements, historyViewModel.jobs);
  return renderChart(elements, historyViewModel.jobs, currentChart);
}

function renderChart(elements, jobs, currentChart) {
  const ChartLibrary = window.Chart;
  const aggregated = aggregateJobsByDay(jobs);

  if (currentChart) {
    currentChart.destroy();
  }

  if (!ChartLibrary) {
    return null;
  }

  return new ChartLibrary(elements.jobsChartCanvas, {
    type: "bar",
    data: {
      labels: aggregated.labels,
      datasets: [
        {
          label: "Metres completed",
          data: aggregated.values,
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
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: (value) => `${value} m`
          }
        }
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: (context) => `${context.parsed.y.toFixed(2)} m`
          }
        }
      }
    }
  });
}

function renderJobList(elements, jobs) {
  elements.jobHistoryList.innerHTML = "";

  if (jobs.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "job-item";
    emptyState.innerHTML = "<strong>No saved jobs in this period yet.</strong><span>Save a finished job and it will appear here and in the graph.</span>";
    elements.jobHistoryList.appendChild(emptyState);
    return;
  }

  jobs
    .slice()
    .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt))
    .forEach((job) => {
      const item = document.createElement("div");
      item.className = "job-item";
      item.innerHTML = `
        <strong>${job.totalMetres.toFixed(2)} m on ${formatDateTime(new Date(job.endedAt))}</strong>
        <span>
          Worked ${formatMinutes(job.netWorkedMinutes)} after ${job.breakMinutes}m breaks.
          Rate: ${job.rate.toFixed(2)} m/h.
        </span>
      `;
      elements.jobHistoryList.appendChild(item);
    });
}

export function clearHistoryOutputs(elements) {
  elements.historyTotalMetresOutput.textContent = "0.00 m";
  elements.historyJobCountOutput.textContent = "0";
  elements.historyAverageOutput.textContent = "0.00 m";
  elements.jobHistoryList.innerHTML = "<div class=\"job-item\"><strong>Sign in to see saved jobs.</strong><span>Your graph and history are shown per signed-in person.</span></div>";
}
