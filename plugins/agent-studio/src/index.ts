import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "agent-studio",
  name: "Agent Studio",
  description: "Operator workspace for Agent Studio.",
  register(api) {
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
      handler: () => undefined,
    });
  },
});
