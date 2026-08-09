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

  it("keeps every text token at WCAG AA against the darkest surface", async () => {
    const css = await readFile(resolve(process.cwd(), "src/ui/styles.css"), "utf8");
    const token = (name: string): string => {
      const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
      if (!match) throw new Error(`missing --${name}`);
      return match[1];
    };
    const luminance = (hex: string): number => {
      const channels = [1, 3, 5]
        .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const ratio = (a: string, b: string): number => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light + 0.05) / (dark + 0.05);
    };

    const raised = token("surface-raised");
    for (const name of ["ink", "muted", "dim", "coral", "signal-amber", "signal-cyan"]) {
      expect({ name, ratio: ratio(token(name), raised) >= 4.5 }).toEqual({ name, ratio: true });
    }
  });

  it("defines visible focus and reduced-motion behavior", async () => {
    const css = await readFile(resolve(process.cwd(), "src/ui/styles.css"), "utf8");
    expect(css).toMatch(/:focus-visible\s*\{/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/animation-duration:\s*0\.01ms/);
    expect(css).toMatch(/transition-duration:\s*0\.01ms/);
  });
});
