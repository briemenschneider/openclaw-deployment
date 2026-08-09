import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

type RegistrationMode =
  | "full"
  | "discovery"
  | "tool-discovery"
  | "setup-only"
  | "setup-runtime"
  | "cli-metadata";

function register(mode: RegistrationMode) {
  const descriptors: unknown[] = [];
  const routes: unknown[] = [];
  const api = {
    registrationMode: mode,
    session: {
      controls: {
        registerControlUiDescriptor: (descriptor: unknown) => descriptors.push(descriptor),
      },
    },
    registerHttpRoute: (route: unknown) => routes.push(route),
  };

  plugin.register(api as never);
  return { descriptors, routes };
}

describe("Agent Studio registration", () => {
  it("registers exactly one agent tab and one plugin-auth prefix route without runtime startup", () => {
    const originalSetInterval = globalThis.setInterval;
    let timersStarted = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      timersStarted += 1;
      return originalSetInterval(...args);
    }) as typeof setInterval;

    try {
      for (const mode of [
        "full",
        "discovery",
        "tool-discovery",
        "setup-only",
        "setup-runtime",
        "cli-metadata",
      ] as const) {
        const { descriptors, routes } = register(mode);

        expect(descriptors).toEqual([
          {
            id: "agent-studio",
            surface: "tab",
            label: "Agent Studio",
            group: "agent",
            requiredScopes: ["operator.write"],
            path: "/plugins/agent-studio/",
          },
        ]);
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({
          path: "/plugins/agent-studio/",
          auth: "plugin",
          match: "prefix",
        });
      }
    } finally {
      globalThis.setInterval = originalSetInterval;
    }

    expect(timersStarted).toBe(0);
  });
});
