import "./agent-studio-app.js";

const mount = document.querySelector<HTMLElement>("#agent-studio-root");
if (!mount) throw new Error("Agent Studio mount point unavailable");
const app = document.createElement("agent-studio-app");
window.addEventListener("pagehide", () => app.teardown());
window.addEventListener("pageshow", () => app.reactivate());
mount.replaceChildren(app);
