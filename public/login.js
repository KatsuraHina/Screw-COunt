import {
  createAccount,
  formatAuthError,
  loginWithEmail,
  subscribeToAuthChanges
} from "./firebase-service.js";
import { isValidUsername, usernameToAuthEmail } from "./jobs.js";

const elements = {
  usernameInput: document.getElementById("usernameInput"),
  passwordInput: document.getElementById("passwordInput"),
  loginButton: document.getElementById("loginButton"),
  createAccountButton: document.getElementById("createAccountButton"),
  authStatusMessage: document.getElementById("authStatusMessage")
};

let isRedirecting = false;

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
  bindEvents();
  subscribeToAuthChanges((user) => {
    if (user) {
      setAuthStatus("Signed in. Redirecting to your calculator...");
      redirectToCalculator();
    }
  });
}

init();
