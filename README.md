# @agentic-engineering-agency/plugin-chat

Multi-adapter AI chat plugin for Paperclip. Provides an agent-first conversational interface with thread management, slash commands, a sidebar entry point, and a full-screen chat page.

## How It Works

The plugin adds a Chat sidebar entry that opens a full-screen page in the Paperclip UI. When a user sends a message, the plugin:

1. Creates a thread (persisted in plugin state)
2. Locks the thread to the selected hired agent when one is chosen, otherwise discovers a compatible agent via `ctx.agents.list()`
3. Creates or resumes an agent session via `ctx.agents.sessions`
4. Streams the agent's response back to the page UI

All LLM access goes through Paperclip's agent session system. The plugin does not talk to models directly — it talks to hired agents that talk to models. Agent-backed chat supports the installed local adapters, including `claude_local`, `codex_local`, `opencode_local`, and `omp_local`. See [Plugin vs Core Analysis](docs/plugin-vs-core-chat.md) for the implications of this architecture.

## Prerequisites

- A running Paperclip instance
- At least one hired agent backed by an installed adapter (`claude_local`, `codex_local`, `opencode_local`, `omp_local`, or another compatible adapter)
- The plugin installed and enabled in **Settings > Plugins**

## Install & test

```bash
npm install
npm run build
```

Then copy the built bundle into the Paperclip server image, enable the plugin in **Settings > Plugins**, and hard refresh the browser.

For a local smoke test, open the Chat sidebar entry, start a thread with a hired agent, send a message, and confirm the assistant response streams back into the full-screen page.

Run `npm test` for parser coverage, or `npm run typecheck` when you want a fast sanity check without rebuilding the UI.

## Build

```bash
npm run build
```

Produces `dist/worker.js` (server-side) and `dist/ui/index.js` (browser bundle).

### Docker deployment

```bash
docker cp dist/ui/index.js paperclip-plugin-chat-server-1:/app/packages/plugins/plugin-chat/dist/ui/index.js
```

Hard refresh the browser after deploying — the server caches bundles with ETags.

## Features

### Chat UI
- Full-screen chat page with a sidebar entry point instead of a bottom-right modal
- Agent-first start flow that lets users choose a hired agent before falling back to adapter-based selection
- Welcome screen with quick action chips (check issues, review goals, plan work, agent status)
- Threaded conversations with sidebar navigation
- Rich markdown rendering (tables, code blocks, lists, links, blockquotes)
- Collapsible tool usage display ("Used 3 tools Bash x3")
- Auto-generated thread titles from first message
- Inline thread rename (double-click) and delete (with confirmation)
- UI error boundary that keeps plugin rendering failures contained

### Slash Commands
Type `/` in the input to access built-in commands:

| Command | Action |
|---------|--------|
| `/tasks` | List active tasks |
| `/dashboard` | Workspace dashboard |
| `/agents` | Agent status overview |
| `/create` | Create a new task |
| `/projects` | List projects |
| `/costs` | Cost breakdown |
| `/activity` | Recent activity |
| `/blocked` | Blocked tasks |
| `/plan` | Plan and break down work |
| `/handoff` | Hand off work to an agent |

### Streaming
The plugin supports real-time streaming via SSE (`ctx.streams`). Claude stream-json events are mapped to structured chat events; plain text and unknown JSON lines from non-Claude adapters are surfaced as text so `codex_local`, `opencode_local`, `omp_local`, and other adapters can stream without being dropped. During agent execution, users see live text output with a blinking cursor, tool activity indicators, and a stop button.

## Configuration

Navigate to **Settings > Plugins > Chat** (gear icon):

| Setting | Description |
|---------|-------------|
| Default Adapter | Adapter type for new threads (`claude_local`, `codex_local`, `opencode_local`, `omp_local`); the UI preselects it when starting a new adapter-backed chat. |
| System Prompt Override | Custom operator instructions prepended to the first message in each new agent session. |

## Plugin Capabilities

| Capability | Purpose |
|-----------|---------|
| `ui.page.register` | Full chat page at `/:prefix/plugins/:pluginId` |
| `ui.sidebar.register` | Sidebar entry point |
| `agent.sessions.*` | Create and message agent sessions |
| `agents.read` | Discover available agents/adapters |
| `plugin.state.*` | Thread and message persistence |
| `activity.log.write` | Activity logging |

## Architecture

```
Browser                          Server
-------                          ------
ChatPage (React)
  |
  |-- usePluginData("threads")    --> Worker: getData("threads")
  |-- usePluginData("messages")   --> Worker: getData("messages")
  |-- usePluginAction("sendMessage") --> Worker: sendMessage action
  |                                      |
  |                                      |--> ctx.agents.sessions.create()
  |                                      |--> ctx.agents.sessions.sendMessage()
  |                                      |      |
  |                                      |      +--> Agent adapter --> CLI process
  |                                      |      |
  |                                      |      +--> onEvent callbacks
  |                                      |
  |                                      |--> ctx.streams.emit() (SSE)
  |
  |-- usePluginStream("chat:threadId") <-- SSE events (text, thinking, tool, done)
```

## Known Limitations

- **No direct LLM access** — requires a pre-configured agent; can't create agents or select models
- **Agent sessions are task-oriented** — no way to distinguish "answer this question" from "execute this task"
- **No design system** — UI is built with inline styles and CSS variable fallbacks
- **No deep linking** — thread state is lost on page refresh
- **No toast/dialog** — errors go to console only
- **Host page chrome** — breadcrumbs and back button can't be hidden

For the full analysis, see [Plugin vs Core: Chat Feature Analysis](docs/plugin-vs-core-chat.md).

## Testing

See the [Testing Guide](docs/plugin-chat-testing-guide.md) for setup instructions, a full test checklist, and troubleshooting steps.

## Related Docs

| Document | Description |
|----------|-------------|
| [Plugin vs Core Analysis](docs/plugin-vs-core-chat.md) | Why chat as a plugin has fundamental limitations |
| [Testing Guide](docs/plugin-chat-testing-guide.md) | Test checklist and setup for testers |
| [Core Integration Spec](docs/chat-core-integration.md) | Recommendation for building chat as a core page |
| [Streaming Implementation](docs/plugin-chat-streaming-implementation.md) | SSE streaming architecture notes |
| [Stream Bus Gap](docs/stream-bus-wiring-gap.md) | Stream bus wiring analysis |
