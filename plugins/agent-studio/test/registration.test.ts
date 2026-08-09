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

  it("wires the registered prefix route to the panel handler", async () => {
    const { routes } = register("full");
    const route = routes[0] as {
      handler: (request: unknown, response: unknown) => Promise<unknown> | unknown;
    };
    const headers = new Map<string, string | number>();
    let body: Buffer | string | undefined;
    const response = {
      statusCode: 0,
      setHeader(name: string, value: string | number) {
        headers.set(name.toLowerCase(), value);
      },
      end(value?: Buffer | string) {
        body = value;
      },
    };

    await route.handler(
      { method: "GET", url: "/plugins/agent-studio/", headers: {}, socket: {} },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(body?.toString()).toContain("Agent Studio");
  });
});
