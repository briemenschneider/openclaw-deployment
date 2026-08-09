import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAgentStudioHttpHandler, type PanelRequestBroker } from "./http-handler.js";
import { PanelSessionBroker } from "./panel-sessions.js";

function loopbackGatewayUrl(config: unknown): string {
  if (typeof config !== "object" || config === null || !("gateway" in config)) {
    return "ws://127.0.0.1:18789";
  }
  const gateway = config.gateway;
  if (typeof gateway !== "object" || gateway === null || !("port" in gateway)) {
    return "ws://127.0.0.1:18789";
  }
  const port = gateway.port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535
    ? `ws://127.0.0.1:${port}`
    : "ws://127.0.0.1:18789";
}

export default definePluginEntry({
  id: "agent-studio",
  name: "Agent Studio",
  description: "Operator workspace for Agent Studio.",
  register(api) {
    let sessions: PanelSessionBroker | undefined;
    const getSessions = () => {
      sessions ??= new PanelSessionBroker({ gatewayUrl: loopbackGatewayUrl(api.config) });
      return sessions;
    };
    const broker: PanelRequestBroker = {
      async handle(request, sourceIp) {
        const panelSessions = getSessions();
        if (request.action === "connect") return await panelSessions.connect(request.token, sourceIp);
        if (request.action === "disconnect") {
          return await panelSessions.disconnect(request.connectionId);
        }
        if (!panelSessions.getClient(request.connectionId)) {
          return {
            ok: false,
            error: { code: "CONNECTION_EXPIRED", message: "Connection expired" },
          };
        }
        return {
          ok: false,
          error: { code: "UNSUPPORTED_OPERATION", message: "Unsupported operation" },
        };
      },
    };

    api.session.controls.registerControlUiDescriptor({
      id: "agent-studio",
      surface: "tab",
      label: "Agent Studio",
      group: "agent",
      requiredScopes: ["operator.write"],
      path: "/plugins/agent-studio/",
    });
    api.registerHttpRoute({
      path: "/plugins/agent-studio/",
      auth: "plugin",
      match: "prefix",
      handler: createAgentStudioHttpHandler({ broker }),
    });
    api.lifecycle?.registerRuntimeLifecycle({
      id: "agent-studio-panel-sessions",
      description: "Close Agent Studio Gateway clients during runtime cleanup.",
      cleanup: async () => await sessions?.shutdown(),
    });
  },
});
