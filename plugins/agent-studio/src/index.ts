import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AgentColorStore } from "./color-store.js";
import { createPanelRequestBroker } from "./gateway-operations.js";
import { createAgentStudioHttpHandler } from "./http-handler.js";
import { PanelSessionBroker } from "./panel-sessions.js";

type StateDirectoryRuntime = {
  runtime: {
    state: {
      resolveStateDir(environment: NodeJS.ProcessEnv): string;
    };
  };
};

export function createAgentStudioColorStore(api: StateDirectoryRuntime): AgentColorStore {
  return new AgentColorStore(api.runtime.state.resolveStateDir(process.env));
}

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
    let colors: AgentColorStore | undefined;
    const getSessions = () => {
      sessions ??= new PanelSessionBroker({ gatewayUrl: loopbackGatewayUrl(api.config) });
      return sessions;
    };
    const getColors = () => {
      colors ??= createAgentStudioColorStore(api);
      return colors;
    };
    const broker = createPanelRequestBroker({
      connect: async (token, sourceIp) => await getSessions().connect(token, sourceIp),
      disconnect: async (connectionId) => await getSessions().disconnect(connectionId),
      getOperationSession: (connectionId) => getSessions().getOperationSession(connectionId),
    }, {
      list: async () => await getColors().list(),
      set: async (agentId, color) => await getColors().set(agentId, color),
    });

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
