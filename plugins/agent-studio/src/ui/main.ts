import "./agent-studio-app.js";

const mount = document.querySelector<HTMLElement>("#agent-studio-root");
if (!mount) throw new Error("Agent Studio mount point unavailable");
const app = document.createElement("agent-studio-app");
const handlePageHide = (): void => {
  window.removeEventListener("pagehide", handlePageHide);
  app.teardown();
};
window.addEventListener("pagehide", handlePageHide);
mount.replaceChildren(app);
