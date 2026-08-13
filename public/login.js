import {
  createAccount,
  formatAuthError,
  loginWithEmail,
  signInBench,
  subscribeToAuthChanges
} from "./firebase-service.js";
import { BENCH_NUMBERS, isValidUsername, usernameToAuthEmail } from "./jobs.js";

const elements = {
  benchPanel: document.getElementById("benchPanel"),
  benchGrid: document.getElementById("benchGrid"),
  adminPanel: document.getElementById("adminPanel"),
  showAdminLogin: document.getElementById("showAdminLogin"),
  showBenchPicker: document.getElementById("showBenchPicker"),
  usernameInput: document.getElementById("usernameInput"),
  passwordInput: document.getElementById("passwordInput"),
  loginButton: document.getElementById("loginButton"),
  createAccountButton: document.getElementById("createAccountButton"),
  authStatusMessage: document.getElementById("authStatusMessage")
};

let isRedirecting = false;
let isSigningIn = false;

function setAuthStatus(message, tone = "hint") {
  elements.authStatusMessage.textContent = message;
  elements.authStatusMessage.className = tone === "warning" ? "hint warning" : "hint";
}

function getCredentials() {
  const username = elements.usernameInput.value.trim();
  return {
    username,
    // Usernames map to a synthetic email for Firebase; the owner's real email
    // (anything with an "@") is used as-is so their login is unchanged.
    email: usernameToAuthEmail(username),
    password: elements.passwordInput.value
  };
}

function redirectToCalculator() {
  if (isRedirecting) {
    return;
  }

  isRedirecting = true;
  window.location.href = "./index.html";
}

// Build the tappable bench grid (1–19). Each button signs in as that bench.
function renderBenchGrid() {
  BENCH_NUMBERS.forEach((bench) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bench-tile";
    button.textContent = String(bench);
    button.setAttribute("aria-label", `Bench ${bench}`);
    button.addEventListener("click", () => handleBenchPick(bench));
    elements.benchGrid.appendChild(button);
  });
}

async function handleBenchPick(bench) {
  if (isSigningIn) {
    return;
  }
  isSigningIn = true;
  setAuthStatus(`Signing in to Bench ${bench}...`);
  try {
    await signInBench(bench);
    // subscribeToAuthChanges below redirects once the sign-in resolves.
  } catch (error) {
    console.error(error);
    isSigningIn = false;
    setAuthStatus(formatAuthError(error), "warning");
  }
}

function showAdminPanel(show) {
  elements.adminPanel.classList.toggle("hidden", !show);
  elements.benchPanel.classList.toggle("hidden", show);
  setAuthStatus(show ? "Admins sign in with a username and password." : "Tap your bench to get started.");
  if (show) {
    elements.usernameInput.focus();
  }
}

async function handleLogin() {
  const { username, email, password } = getCredentials();

  if (!username || !password) {
    setAuthStatus("Enter both username and password to log in.", "warning");
    return;
  }
  if (!isValidUsername(username)) {
    setAuthStatus("Usernames use letters, numbers, dots, underscores or hyphens.", "warning");
    return;
  }

  setAuthStatus("Logging in...");

  try {
    await loginWithEmail(email, password);
    elements.passwordInput.value = "";
  } catch (error) {
    console.error(error);
    setAuthStatus(formatAuthError(error), "warning");
  }
}

async function handleCreateAccount() {
  const { username, email, password } = getCredentials();

  if (!username || !password) {
    setAuthStatus("Enter both username and password to create an account.", "warning");
    return;
  }
  if (!isValidUsername(username)) {
    setAuthStatus("Usernames use letters, numbers, dots, underscores or hyphens.", "warning");
    return;
  }

  setAuthStatus("Creating account...");

  try {
    await createAccount(email, password);
    elements.passwordInput.value = "";
  } catch (error) {
    console.error(error);
    setAuthStatus(formatAuthError(error), "warning");
  }
}

function bindEvents() {
  elements.showAdminLogin.addEventListener("click", () => showAdminPanel(true));
  elements.showBenchPicker.addEventListener("click", () => showAdminPanel(false));
  elements.loginButton.addEventListener("click", handleLogin);
  elements.createAccountButton.addEventListener("click", handleCreateAccount);
  elements.passwordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleLogin();
    }
  });
}

function init() {
  renderBenchGrid();
  bindEvents();
  subscribeToAuthChanges((user) => {
    if (user) {
      setAuthStatus("Signed in. Redirecting...");
      redirectToCalculator();
    }
  });
}

init();
