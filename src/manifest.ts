import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip-chat";
const PLUGIN_VERSION = "0.3.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Chat",
  description:
    "Multi-adapter AI chat for Paperclip. Supports all installed adapters, including Claude, Codex, OpenCode, and Oh My Pi, with real-time streaming, session persistence, and tool visibility.",
  author: "Paperclip",
  categories: ["workspace", "ui"],
  capabilities: [
    // UI
    "ui.page.register",
    "ui.sidebar.register",
    // Agent sessions (streaming chat)
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    // Read agents for adapter/model discovery
    "agents.read",
    // Plugin state for thread/message persistence
    "plugin.state.read",
    "plugin.state.write",
    // Activity logging
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },

  // Plugin-level config schema (operator-editable)
  instanceConfigSchema: {
    type: "object",
    properties: {
      defaultAdapterType: {
        type: "string",
        title: "Default Adapter",
        description: "Which adapter to use by default for new threads",
        default: "claude_local",
        enum: ["claude_local", "openai", "codex_local", "opencode_local", "omp_local"],
        oneOf: [
          { const: "claude_local", title: "Claude" },
          { const: "openai", title: "OpenAI" },
          { const: "codex_local", title: "Codex" },
          { const: "opencode_local", title: "OpenCode" },
          { const: "omp_local", title: "Oh My Pi" },
        ],
      },
      defaultAgentId: {
        type: "string",
        title: "Default Agent ID",
        description: "Specific active Paperclip agent ID to use for new threads when none is selected",
        default: "",
      },
      defaultModel: {
        type: "string",
        title: "Default Model",
        description: "Model to request for new threads when supported by the selected adapter",
        default: "",
      },
      systemPromptOverride: {
        type: "string",
        title: "System Prompt Override",
        description: "Custom system prompt prepended to the first chat message (optional)",
        default: "",
      },
      streamingEnabled: {
        type: "boolean",
        title: "Streaming Enabled",
        description: "Publish incremental text, thinking, and tool events while responses run",
        default: true,
      },
      showToolCalls: {
        type: "boolean",
        title: "Show Tool Calls",
        description: "Publish tool use and result events in the chat stream",
        default: true,
      },
      enrichContext: {
        type: "boolean",
        title: "Enrich Context",
        description: "Include available agent context in the first message of each thread",
        default: true,
      },
    },
  },

  ui: {
    slots: [
      {
        type: "page",
        id: "chat-page",
        displayName: "Chat",
        routePath: "chat",
        exportName: "ChatPage",
      },
      {
        type: "sidebar",
        id: "chat-sidebar",
        displayName: "Chat",
        exportName: "ChatSidebarLink",
      },
    ],
  },
};

export default manifest;
