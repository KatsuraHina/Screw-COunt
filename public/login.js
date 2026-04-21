import {
  createAccount,
  formatAuthError,
  loginWithEmail,
  subscribeToAuthChanges
} from "./firebase-service.js";

const elements = {
  emailInput: document.getElementById("emailInput"),
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
  return {
    email: elements.emailInput.value.trim(),
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
  const { email, password } = getCredentials();

  if (!email || !password) {
    setAuthStatus("Enter both email and password to log in.", "warning");
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
  const { email, password } = getCredentials();

  if (!email || !password) {
    setAuthStatus("Enter both email and password to create an account.", "warning");
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
