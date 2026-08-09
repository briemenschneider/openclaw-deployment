import { definePluginEntry as e } from "openclaw/plugin-sdk/plugin-entry";
const i = e({
  id: "agent-studio",
  name: "Agent Studio",
  description: "Operator workspace for Agent Studio.",
  register(t) {
    t.session.controls.registerControlUiDescriptor({
      id: "agent-studio",
      surface: "tab",
      label: "Agent Studio",
      group: "agent",
      requiredScopes: ["operator.write"],
      path: "/plugins/agent-studio/"
    }), t.registerHttpRoute({
      path: "/plugins/agent-studio/",
      auth: "plugin",
      match: "prefix",
      handler: () => {
      }
    });
  }
});
export {
  i as default
};
