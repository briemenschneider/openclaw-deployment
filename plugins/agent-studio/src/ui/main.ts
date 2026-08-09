import "./agent-studio-app.js";

const mount = document.querySelector<HTMLElement>("#agent-studio-root");
if (!mount) throw new Error("Agent Studio mount point unavailable");
mount.replaceChildren(document.createElement("agent-studio-app"));
