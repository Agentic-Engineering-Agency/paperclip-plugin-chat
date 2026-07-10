import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { AgentSessionEvent, PluginContext } from "@paperclipai/plugin-sdk";
import type {
  ChatThread,
  ChatMessage,
  ChatStreamEvent,
  ChatAdapterInfo,
  ChatAgentInfo,
  ChatPluginSettings,
} from "./types.js";

const PLUGIN_NAME = "paperclip-chat";

// ---------------------------------------------------------------------------
// Claude stream-json parser
// ---------------------------------------------------------------------------

/**
 * Buffers raw stdout chunks and emits ChatStreamEvents for complete lines.
 * Known Claude stream-json events keep their structured mapping; everything
 * else is surfaced as plain text so non-Claude adapters are not silent.
 */
export function createStreamJsonParser(emit: (event: ChatStreamEvent) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let emitted = false;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          const type = obj.type as string | undefined;

          // ── Claude CLI stream-json format ──────────────────────────
          // The CLI emits: system (init), assistant (full message),
          // user (tool_result), and result (final summary).
          if (type === "assistant") {
            const message = obj.message as Record<string, unknown> | undefined;
            const content = Array.isArray(message?.content) ? message!.content : [];
            for (const blockRaw of content) {
              if (typeof blockRaw !== "object" || blockRaw === null || Array.isArray(blockRaw)) continue;
              const block = blockRaw as Record<string, unknown>;
              const blockType = block.type as string | undefined;
              if (blockType === "text" && typeof block.text === "string") {
                emit({ type: "text", text: block.text });
                emitted = true;
              } else if (blockType === "thinking" && typeof block.thinking === "string") {
                emit({ type: "thinking", text: block.thinking });
                emitted = true;
              } else if (blockType === "tool_use") {
                emit({
                  type: "tool_use",
                  name: (block.name as string) ?? "tool",
                  input: block.input,
                });
                emitted = true;
              }
            }
          } else if (type === "user") {
            // Tool results come back as user messages with tool_result blocks
            const message = obj.message as Record<string, unknown> | undefined;
            const content = Array.isArray(message?.content) ? message!.content : [];
            for (const blockRaw of content) {
              if (typeof blockRaw !== "object" || blockRaw === null || Array.isArray(blockRaw)) continue;
              const block = blockRaw as Record<string, unknown>;
              if ((block.type as string) === "tool_result") {
                let resultContent = "";
                if (typeof block.content === "string") {
                  resultContent = block.content;
                } else if (Array.isArray(block.content)) {
                  resultContent = block.content
                    .map((p: unknown) => {
                      if (typeof p === "string") return p;
                      if (typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text") {
                        return (p as Record<string, unknown>).text as string;
                      }
                      return "";
                    })
                    .filter(Boolean)
                    .join("\n");
                }
                emit({
                  type: "tool_result",
                  content: resultContent,
                  isError: block.is_error === true,
                });
                emitted = true;
              }
            }
          } else if (type === "system" && obj.subtype === "init") {
            if (typeof obj.session_id === "string") {
              emit({ type: "session_init", sessionId: obj.session_id });
              emitted = true;
            }
          } else if (type === "result") {
            const usage = obj.usage as Record<string, unknown> | undefined;
            emit({
              type: "result",
              usage: usage ? {
                input_tokens: (usage.input_tokens as number) ?? 0,
                output_tokens: (usage.output_tokens as number) ?? 0,
              } : undefined,
              costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd
                : typeof obj.cost_usd === "number" ? obj.cost_usd
                : undefined,
            });
            emitted = true;
          } else if (type === "done") {
            emit({ type: "done" });
            emitted = true;
          }

          // ── Anthropic API streaming format (fallback) ──────────────
          // In case the adapter emits raw API events instead of CLI format.
          if (type === "content_block_delta") {
            const delta = obj.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              emit({ type: "text", text: delta.text });
              emitted = true;
            }
            if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              emit({ type: "thinking", text: delta.thinking });
              emitted = true;
            }
          }
          if (!emitted) {
            emit({ type: "text", text: trimmed });
          }
        } catch {
          emit({ type: "text", text: trimmed });
        }
      }
    },
    /** Flush any remaining buffer content */
    flush() {
      if (buffer.trim()) {
        this.push("\n");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// State key helpers — all chat data lives in plugin.state
// ---------------------------------------------------------------------------

function threadListKey(companyId: string) {
  return `threads:${companyId}`;
}

function threadKey(threadId: string) {
  return `thread:${threadId}`;
}

function messagesKey(threadId: string) {
  return `messages:${threadId}`;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function getThread(ctx: PluginContext, threadId: string): Promise<ChatThread | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: threadKey(threadId),
  });
  return (raw as ChatThread) ?? null;
}

async function saveThread(ctx: PluginContext, thread: ChatThread): Promise<void> {
  await ctx.state.set({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: threadKey(thread.id),
  }, thread as unknown);
}

async function getThreadList(ctx: PluginContext, companyId: string): Promise<string[]> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: threadListKey(companyId),
  });
  return (raw as string[]) ?? [];
}

async function saveThreadList(ctx: PluginContext, companyId: string, ids: string[]): Promise<void> {
  await ctx.state.set({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: threadListKey(companyId),
  }, ids as unknown);
}

async function getMessages(ctx: PluginContext, threadId: string): Promise<ChatMessage[]> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: messagesKey(threadId),
  });
  return (raw as ChatMessage[]) ?? [];
}

async function saveMessages(ctx: PluginContext, threadId: string, msgs: ChatMessage[]): Promise<void> {
  await ctx.state.set({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: messagesKey(threadId),
  }, msgs as unknown);
}

function generateId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Adapter type → human-readable label
// ---------------------------------------------------------------------------

const ADAPTER_LABELS: Record<string, string> = {
  claude_local: "Claude",
  openai: "OpenAI",
  codex_local: "Codex",
  opencode_local: "OpenCode",
  omp_local: "Oh My Pi",
};

export function adapterTypeLabel(adapterType: string): string {
  return ADAPTER_LABELS[adapterType] ?? adapterType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const DEFAULT_SETTINGS: ChatPluginSettings = {
  defaultAdapterType: "claude_local",
  defaultAgentId: "",
  defaultModel: "",
  systemPromptOverride: "",
  streamingEnabled: true,
  showToolCalls: true,
  enrichContext: true,
};

export function normalizePluginSettings(rawConfig: unknown): ChatPluginSettings {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig as Record<string, unknown> : {};
  return {
    defaultAdapterType: typeof config.defaultAdapterType === "string" && config.defaultAdapterType ? config.defaultAdapterType : DEFAULT_SETTINGS.defaultAdapterType,
    defaultAgentId: typeof config.defaultAgentId === "string" ? config.defaultAgentId : DEFAULT_SETTINGS.defaultAgentId,
    defaultModel: typeof config.defaultModel === "string" ? config.defaultModel : DEFAULT_SETTINGS.defaultModel,
    systemPromptOverride: typeof config.systemPromptOverride === "string" ? config.systemPromptOverride : DEFAULT_SETTINGS.systemPromptOverride,
    streamingEnabled: typeof config.streamingEnabled === "boolean" ? config.streamingEnabled : DEFAULT_SETTINGS.streamingEnabled,
    showToolCalls: typeof config.showToolCalls === "boolean" ? config.showToolCalls : DEFAULT_SETTINGS.showToolCalls,
    enrichContext: typeof config.enrichContext === "boolean" ? config.enrichContext : DEFAULT_SETTINGS.enrichContext,
  };
}

async function getPluginSettings(ctx: PluginContext): Promise<ChatPluginSettings> {
  const looseCtx = ctx as unknown as {
    config?: { get?: () => Promise<Record<string, unknown>> } | Record<string, unknown>;
    instanceConfig?: Record<string, unknown>;
  };
  const rawConfig = typeof looseCtx.config?.get === "function"
    ? await looseCtx.config.get()
    : (looseCtx.instanceConfig ?? looseCtx.config ?? {});
  return normalizePluginSettings(rawConfig);
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    // ── Data: current plugin settings ───────────────────────────────
    ctx.data.register("settings", async () => getPluginSettings(ctx));

    // ── Data: list threads ──────────────────────────────────────────
    ctx.data.register("threads", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      if (!companyId) return [];
      const ids = await getThreadList(ctx, companyId);
      const threads: ChatThread[] = [];
      for (const id of ids) {
        const thread = await getThread(ctx, id);
        if (thread) threads.push(thread);
      }
      // Sort by updatedAt descending
      threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return threads;
    });

    // ── Data: get messages for a thread ─────────────────────────────
    ctx.data.register("messages", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      if (!threadId) return [];
      return getMessages(ctx, threadId);
    });

    // ── Data: list available adapters ───────────────────────────────
    ctx.data.register("adapters", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      if (!companyId) {
        return [
          { type: "claude_local", label: "Claude", available: true, models: [] },
        ] as ChatAdapterInfo[];
      }
      try {
        const agents = await ctx.agents.list({ companyId });

        // Deduplicate by adapterType — show distinct adapter types, not individual agents
        // Mark available if ANY agent of that type is not terminated
        const adapterMap = new Map<string, ChatAdapterInfo>();
        for (const a of agents) {
          const existing = adapterMap.get(a.adapterType);
          if (existing) {
            // If any agent of this type is available, mark the adapter available
            if (a.status !== "terminated") existing.available = true;
            continue;
          }
          adapterMap.set(a.adapterType, {
            type: a.adapterType,
            label: adapterTypeLabel(a.adapterType),
            available: a.status !== "terminated",
            models: [],
          });
        }
        const adapters = Array.from(adapterMap.values());
        return adapters.length > 0 ? adapters : [
          { type: "claude_local", label: "Claude", available: true, models: [] },
        ];
      } catch {
        return [
          { type: "claude_local", label: "Claude", available: true, models: [] },
        ] as ChatAdapterInfo[];
      }
    });

    // ── Data: list hired agents ─────────────────────────────────────
    ctx.data.register("agents", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      if (!companyId) return [] as ChatAgentInfo[];

      const agents = await ctx.agents.list({ companyId });
      return agents
        .filter((agent) => agent.status !== "terminated")
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: agent.role ?? null,
          title: agent.title ?? null,
          status: agent.status ?? null,
          adapterType: agent.adapterType,
          adapterLabel: adapterTypeLabel(agent.adapterType),
        } satisfies ChatAgentInfo))
        .sort((a, b) => a.name.localeCompare(b.name));
    });

    // ── Action: create thread ───────────────────────────────────────
    ctx.actions.register("createThread", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      if (!companyId) throw new Error("companyId is required");
      const settings = await getPluginSettings(ctx);
      let adapterType = typeof params.adapterType === "string" && params.adapterType ? params.adapterType : settings.defaultAdapterType;
      const model = typeof params.model === "string" && params.model ? params.model : settings.defaultModel;
      const title = (params.title as string) ?? "New Chat";
      let agentId = params.agentId as string | undefined;
      let agentName = params.agentName as string | undefined;
      if (!agentId && settings.defaultAgentId) {
        const agents = await ctx.agents.list({ companyId });
        const agent = agents.find((a) => a.id === settings.defaultAgentId && a.status !== "terminated");
        if (agent) {
          agentId = agent.id;
          agentName = agent.name;
          adapterType = agent.adapterType;
        }
      }

      const thread: ChatThread = {
        id: generateId(),
        companyId,
        title,
        sessionId: null,
        adapterType,
        model,
        agentId,
        agentName,
        status: "idle",
        createdBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveThread(ctx, thread);
      const ids = await getThreadList(ctx, companyId);
      ids.unshift(thread.id);
      await saveThreadList(ctx, companyId, ids);

      return thread;
    });

    // ── Action: delete thread ───────────────────────────────────────
    ctx.actions.register("deleteThread", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const companyId = params.companyId as string;
      if (!threadId || !companyId) throw new Error("threadId and companyId required");

      // Remove from thread list
      const ids = await getThreadList(ctx, companyId);
      const filtered = ids.filter((id) => id !== threadId);
      await saveThreadList(ctx, companyId, filtered);

      // Delete thread and messages state
      await ctx.state.delete({
        scopeKind: "instance",
        scopeId: "global",
        stateKey: threadKey(threadId),
      });
      await ctx.state.delete({
        scopeKind: "instance",
        scopeId: "global",
        stateKey: messagesKey(threadId),
      });

      return { ok: true };
    });

    // ── Action: update thread title ─────────────────────────────────
    ctx.actions.register("updateThreadTitle", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const title = params.title as string;
      if (!threadId || !title) throw new Error("threadId and title required");

      const thread = await getThread(ctx, threadId);
      if (!thread) throw new Error("Thread not found");

      thread.title = title;
      thread.updatedAt = new Date().toISOString();
      await saveThread(ctx, thread);
      return thread;
    });

    // ── Action: send message (starts streaming) ─────────────────────
    ctx.actions.register("sendMessage", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const message = params.message as string;
      const companyId = params.companyId as string;
      if (!threadId || !message || !companyId) {
        throw new Error("threadId, message, and companyId required");
      }

      const thread = await getThread(ctx, threadId);
      if (!thread) throw new Error("Thread not found");
      const settings = await getPluginSettings(ctx);

      // Save user message
      const msgs = await getMessages(ctx, threadId);
      const isFirstThreadMessage = msgs.length === 0;
      const userMsg: ChatMessage = {
        id: generateId(),
        threadId,
        role: "user",
        content: message,
        metadata: null,
        createdAt: new Date().toISOString(),
      };
      msgs.push(userMsg);
      await saveMessages(ctx, threadId, msgs);

      // Mark thread as running
      thread.status = "running";
      thread.updatedAt = new Date().toISOString();

      // Auto-generate title from first user message
      if (thread.title === "New Chat") {
        const shortTitle = message.length > 60
          ? message.slice(0, 57).replace(/\s+\S*$/, "") + "..."
          : message;
        const titleLine = shortTitle.split("\n")[0] ?? shortTitle;
        thread.title = titleLine;
        // TODO: emit title_updated via stream
      }
      await saveThread(ctx, thread);

      // Track whether this is the first message in the thread (new session)
      const isNewSession = !thread.sessionId;

      // Open SSE stream channel before any risky session work so failures are visible.
      const streamChannel = `chat:${threadId}`;
      ctx.streams.open(streamChannel, companyId);

      // Collect response segments for persistence
      const segments: ChatMessage["metadata"] = { segments: [] };
      let fullResponse = "";
      let runId: string | undefined;

      try {
        // Create or resume agent session
        let sessionId = thread.sessionId;
        if (!sessionId) {
          const agents = await ctx.agents.list({ companyId });
          const activeAgents = agents.filter((a) => a.status !== "terminated");
          const agent = thread.agentId
            ? activeAgents.find((a) => a.id === thread.agentId)
            : (() => {
              const matching = activeAgents.filter((a) => a.adapterType === thread.adapterType);
              return matching.find((a) => a.name === "Chat Assistant") ?? matching.find((a) => a.role === "general") ?? matching[0];
            })();
          if (!agent) {
            const available = activeAgents.map((a) => `${a.name}(${a.adapterType})`).join(", ") || "none";
            throw new Error(thread.agentId
              ? `No active agent found with id "${thread.agentId}". Available: ${available}`
              : `No agent found with adapter type "${thread.adapterType}". Available: ${available}`);
          }
          const session = await ctx.agents.sessions.create(agent.id, companyId, {
            reason: "Chat plugin: new conversation",
          });
          sessionId = session.sessionId;
          thread.sessionId = sessionId;
          await saveThread(ctx, thread);
        }

        // Build first-message context only when enabled.
        let enrichedMessage = message;
        if (isFirstThreadMessage) {
          const parts: string[] = [];
          const promptOverride = settings.systemPromptOverride.trim();
          if (promptOverride) parts.push(promptOverride);
          if (settings.enrichContext) {
            const allAgents = await ctx.agents.list({ companyId });
            if (allAgents.length > 0) {
              parts.push(`[Available Agents]\n${allAgents.map(a => `- @${a.name} (Role: ${a.role ?? "general"}, Title: ${a.title ?? "N/A"}, Status: ${a.status ?? "unknown"})`).join("\n")}`);
            }
          }
          parts.push(message);
          enrichedMessage = parts.join("\n\n");
        }

        // Emit title update if it changed
        if (thread.title !== "New Chat") {
          ctx.streams.emit(streamChannel, { type: "title_updated", title: thread.title });
        }

        // Send message and stream events.
        // ctx.agents.sessions.sendMessage returns immediately once the run is
        // queued — the onEvent callback fires asynchronously via JSON-RPC
        // notifications. We must wait for the terminal event before saving.
        const RUN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("Chat response timed out"));
          }, RUN_TIMEOUT_MS);

          // Helper to process parsed stream events
          const handleParsedEvent = (chatEvent: ChatStreamEvent) => {
            // Accumulate for persistence
            if (chatEvent.type === "text" && chatEvent.text) {
              fullResponse += chatEvent.text;
              const last = segments.segments[segments.segments.length - 1];
              if (last && last.kind === "text") {
                last.content += chatEvent.text;
              } else {
                segments.segments.push({ kind: "text", content: chatEvent.text });
              }
            }
            if (chatEvent.type === "thinking" && chatEvent.text) {
              const last = segments.segments[segments.segments.length - 1];
              if (last && last.kind === "thinking") {
                last.content += chatEvent.text;
              } else {
                segments.segments.push({ kind: "thinking", content: chatEvent.text });
              }
            }
            if (chatEvent.type === "error" && chatEvent.text) {
              fullResponse += chatEvent.text;
              segments.segments.push({ kind: "text", content: chatEvent.text });
            }
            if (settings.showToolCalls) {
              if (chatEvent.type === "tool_use") {
                segments.segments.push({
                  kind: "tool",
                  name: chatEvent.name ?? "tool",
                  input: chatEvent.input,
                });
              }
              if (chatEvent.type === "tool_result") {
                for (let i = segments.segments.length - 1; i >= 0; i--) {
                  const seg = segments.segments[i];
                  if (seg && seg.kind === "tool" && seg.result === undefined) {
                    seg.result = chatEvent.content ?? "";
                    seg.isError = chatEvent.isError ?? false;
                    break;
                  }
                }
              }
            }
            if (chatEvent.type === "session_init" && chatEvent.sessionId) {
              thread.sessionId = chatEvent.sessionId;
            }

            // Terminal events: run completed or errored — resolve the wait
            if (chatEvent.type === "result" || chatEvent.type === "error") {
              clearTimeout(timer);
              resolve();
            }

            // Push event to UI via SSE stream in real-time when enabled.
            const isToolEvent = chatEvent.type === "tool_use" || chatEvent.type === "tool_result";
            const isIncrementalEvent = chatEvent.type === "text" || chatEvent.type === "thinking" || isToolEvent;
            if ((!isIncrementalEvent || settings.streamingEnabled) && (!isToolEvent || settings.showToolCalls)) {
              ctx.streams.emit(streamChannel, chatEvent);
            }
          };

          // Parse raw stdout chunks (Claude stream-json format) into events
          const parser = createStreamJsonParser(handleParsedEvent);

          ctx.agents.sessions.sendMessage(sessionId, companyId, {
            prompt: enrichedMessage,
            reason: "Chat plugin: user message",
            onEvent: (event: AgentSessionEvent) => {
              // The host forwards raw stdout/stderr chunks as "chunk" events.
              // For stdout chunks, parse the Claude stream-json format.
              if (event.eventType === "chunk") {
                const stream = event.stream ?? (event.payload?.stream as string | undefined);
                if (stream === "stdout" && event.message) {
                  parser.push(event.message);
                }
                // Ignore stderr chunks
                return;
              }

              // Terminal events from the host (run status changes)
              if (event.eventType === "done") {
                parser.flush();
                handleParsedEvent({
                  type: "result",
                  usage: event.payload?.usage as ChatStreamEvent["usage"],
                  costUsd: event.payload?.costUsd as number | undefined,
                });
                return;
              }
              if (event.eventType === "error") {
                parser.flush();
                handleParsedEvent({ type: "error", text: event.message ?? "Unknown error" });
                return;
              }
              if (event.eventType === "status" && event.payload?.sessionId) {
                handleParsedEvent({ type: "session_init", sessionId: event.payload.sessionId as string });
              }
            },
          }).then((result) => {
            runId = result.runId;
          }).catch((err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        // Stream complete — save assistant message
        if (fullResponse || segments.segments.length > 0) {
          const assistantMsg: ChatMessage = {
            id: generateId(),
            threadId,
            role: "assistant",
            content: fullResponse,
            metadata: segments,
            createdAt: new Date().toISOString(),
          };
          const updatedMsgs = await getMessages(ctx, threadId);
          updatedMsgs.push(assistantMsg);
          await saveMessages(ctx, threadId, updatedMsgs);
        }

        ctx.logger.info(`Chat message completed`, { threadId, runId });
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        const assistantMsg: ChatMessage = {
          id: generateId(),
          threadId,
          role: "assistant",
          content: errorText,
          metadata: { segments: [{ kind: "text", content: errorText }] },
          createdAt: new Date().toISOString(),
        };
        const updatedMsgs = await getMessages(ctx, threadId);
        updatedMsgs.push(assistantMsg);
        await saveMessages(ctx, threadId, updatedMsgs);
        ctx.streams.emit(streamChannel, { type: "error", text: errorText });
        ctx.logger.error(`Chat message failed`, { threadId, runId, error: errorText });
      } finally {
        thread.status = "idle";
        thread.updatedAt = new Date().toISOString();
        await saveThread(ctx, thread);
        ctx.streams.emit(streamChannel, { type: "done" });
        ctx.streams.close(streamChannel);
      }

      return { ok: true, runId };
    });

    // ── Action: stop a running response ─────────────────────────────
    ctx.actions.register("stopThread", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const companyId = params.companyId as string;
      if (!threadId || !companyId) throw new Error("threadId and companyId required");

      const thread = await getThread(ctx, threadId);
      if (!thread || !thread.sessionId) return { ok: true, stopped: false };

      await ctx.agents.sessions.close(thread.sessionId, companyId);
      thread.status = "idle";
      thread.sessionId = null; // Force new session on next message
      thread.updatedAt = new Date().toISOString();
      await saveThread(ctx, thread);

      return { ok: true, stopped: true };
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
