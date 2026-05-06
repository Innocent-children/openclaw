import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "./api.js";

export default definePluginEntry({
  id: "knowledge-bridge",
  name: "Knowledge Bridge",
  description:
    "Queries the local Knowledge Bridge service and injects evidence into the next LLM turn.",
  configSchema: emptyPluginConfigSchema,
  register() {
    // Scaffold only: register is a no-op for Task 1. Subsequent tasks will wire
    // up message_received and before_prompt_build hooks.
  },
});
