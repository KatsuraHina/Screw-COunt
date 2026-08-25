// Night (dark) / morning (light) switching, shared by the app and the login
// page. The stylesheet is dark-first and falls back to the device's own setting
// via prefers-color-scheme; picking a mode here stamps `data-theme` on <html>,
// which overrides that in both directions and is remembered on the device.
//
// The value is also read by a tiny inline script in each page's <head>, so the
// chosen mode is already on the element before the first paint — without it the
// page would flash the wrong palette while the modules load.

const THEME_KEY = "screwcount.theme";

// The stylesheet's own names for the two palettes. "Night" and "Morning" are
// what they're called on screen — the same words the shifts use.
export const NIGHT = "dark";
export const MORNING = "light";

function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? MORNING : NIGHT;
}

// The mode in force right now: the one that was picked, or the device's.
export function currentTheme() {
  const picked = document.documentElement.dataset.theme;
  return picked === NIGHT || picked === MORNING ? picked : systemTheme();
}

export function applyTheme(theme) {
  const next = theme === MORNING ? MORNING : NIGHT;
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage unavailable (private mode etc.) — the choice just won't be remembered.
  }
  return next;
}

export function toggleTheme() {
  return applyTheme(currentTheme() === NIGHT ? MORNING : NIGHT);
}

// The button names the mode it will switch to, so its label reads as the action
// it performs rather than the state it's in.
export function renderThemeToggle(button) {
  if (!button) {
    return;
  }
  const goingToMorning = currentTheme() === NIGHT;
  button.querySelector(".theme-toggle-icon").textContent = goingToMorning ? "☀" : "☾";
  button.querySelector(".theme-toggle-label").textContent = goingToMorning ? "Morning" : "Night";
  button.setAttribute(
    "aria-label",
    goingToMorning ? "Switch to morning mode" : "Switch to night mode"
  );
  button.setAttribute("title", button.getAttribute("aria-label"));
}

// Wire a toggle button up: paint it, and swap the mode on each press. `onChange`
// lets the app repaint anything that reads its colours from the stylesheet at
// render time (the charts).
export function bindThemeToggle(button, onChange) {
  if (!button) {
    return;
  }
  renderThemeToggle(button);
  button.addEventListener("click", () => {
    const next = toggleTheme();
    renderThemeToggle(button);
    if (onChange) {
      onChange(next);
    }
  });
}
