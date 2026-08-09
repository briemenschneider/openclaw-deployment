import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/ui/agent-studio-app.js";
import type { AgentStudioApp } from "../../src/ui/agent-studio-app.js";

const connectionId = "b".repeat(64);
const features = {
  listAgents: true,
  updateAgent: true,
  listAgentFiles: true,
  getAgentFile: true,
  setAgentFile: true,
  listModels: true,
  listSessions: true,
  createSession: true,
};

async function connectedApp(): Promise<AgentStudioApp> {
  const app = document.createElement("agent-studio-app") as AgentStudioApp;
  app.api = {
    connect: async () => ({ connectionId, features }),
    disconnect: vi.fn(),
    operation: async (_id: string, operation: string) =>
      operation === "listAgents" ? { agents: [] } : { colors: {} },
  };
  document.body.append(app);
  await app.updateComplete;
  const input = app.querySelector<HTMLInputElement>("#gateway-token");
  if (!input) throw new Error("missing token input");
  input.value = "temporary";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() => expect(app.connectionId).toBe(connectionId));
  return app;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Agent Studio shell", () => {
  it("renders the two-pane control-room shell with intentional deferred states", async () => {
    const app = await connectedApp();
    const directory = app.querySelector<HTMLElement>("#agent-directory");
    const workspace = app.querySelector<HTMLElement>("#agent-workspace");

    expect(directory?.getAttribute("aria-label")).toBe("Agent directory");
    expect(directory?.textContent).toContain("Agents");
    await vi.waitFor(() =>
      expect(directory?.textContent).toContain("No agents available on this Gateway."));
    expect(directory?.querySelector("#agent-search")).not.toBeNull();
    expect(workspace?.getAttribute("aria-label")).toBe("Agent workspace");
    expect(workspace?.textContent).toContain("Select an agent to begin");
    expect(app.querySelector(".signal-rail")).not.toBeNull();
  });

  it("exposes a drawer with correct expanded and open semantics", async () => {
    const app = await connectedApp();
    const toggle = app.querySelector<HTMLButtonElement>("#directory-toggle");
    const directory = app.querySelector<HTMLElement>("#agent-directory");
    if (!toggle || !directory) throw new Error("missing drawer controls");

    expect(toggle.getAttribute("aria-controls")).toBe("agent-directory");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(directory.hasAttribute("data-open")).toBe(false);
    toggle.click();
    await app.updateComplete;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(directory.hasAttribute("data-open")).toBe(true);

    app.querySelector<HTMLButtonElement>("#drawer-scrim")?.click();
    await app.updateComplete;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("defines visible focus and reduced-motion behavior", async () => {
    const css = await readFile(resolve(process.cwd(), "src/ui/styles.css"), "utf8");
    expect(css).toMatch(/:focus-visible\s*\{/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/animation-duration:\s*0\.01ms/);
    expect(css).toMatch(/transition-duration:\s*0\.01ms/);
  });
});
