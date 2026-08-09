import { accessSync, constants } from "node:fs";

/**
 * Locates a Chromium-family browser for the tests that need a real one.
 *
 * These tests prove things happy-dom cannot: that an opaque-origin iframe really does
 * send a simple request without a preflight, and that the built panel really is isolated
 * from its parent. They need a browser, but the suite must still run on a machine that
 * has none - a Linux or macOS checkout, or CI - so callers skip rather than fail when
 * this resolves to undefined.
 *
 * Set AGENT_STUDIO_BROWSER to an executable path to override the search.
 */
const CANDIDATES = [
  process.env.AGENT_STUDIO_BROWSER,
  // Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

export const browserExecutable = CANDIDATES.filter(
  (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
).find((candidate) => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

/** True when the browser-backed tests can run here. */
export const hasBrowser = browserExecutable !== undefined;
