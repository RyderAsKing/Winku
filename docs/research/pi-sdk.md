# pi SDK research for Winku

Gathered 2026-11-11 from the `main` branch of https://github.com/badlogic/pi-mono, under `packages/coding-agent/`. The docs live at `packages/coding-agent/docs/*.md`, and raw copies can be fetched from
`https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/<name>.md`.
`main` changes over time, so check these details against the version pinned in `engine/package.json`.

The spec this supports is [../SPEC.md](../SPEC.md).

## Packages (all MIT)

| Package | Use for us |
|---|---|
| `@earendil-works/pi-coding-agent` | **The one we embed.** It provides `createAgentSession`, sessions, tools, compaction and extensions. |
| `@earendil-works/pi-agent-core` | The agent loop and state underneath it. |
| `@earendil-works/pi-ai` | Unified provider API, used for `getModel` (`@earendil-works/pi-ai/compat`). |
| `@earendil-works/pi-tui`, `chord`, `pi-durable`, `pi-telemetry` | Not needed. |

- The npm scope is `@earendil-works`. Older posts and blogs use `@mariozechner/*`.
- Runtime: "Node.js 22.19 or newer", and the SDK says it "embeds Pi in a Node.js or Bun process".

## Embedding: the SDK beats RPC for us

- **SDK** (`docs/sdk.md`): runs inside our own process and gives full API access. **We use this.** `winku-engine` is a Bun binary that wraps the SDK and talks to the Rust shell over our own JSON-lines protocol.
- **RPC** (`docs/rpc.md`): runs the stock `pi` program as a long-lived child process driven by JSON lines on stdin/stdout. We don't use it, because it means shipping the stock CLI and its config discovery.

### Full-control setup (from `examples/sdk/12-full-control.ts`)

This setup turns off all of pi's discovery and is the template for keeping the app isolated from any pi install.

```ts
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession, createExtensionRuntime, ModelRuntime,
  type ResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create({
  authPath: "<winku-data>/engine/auth.json",     // never written if we only use runtime keys
  modelsPath: "<winku-data>/engine/models.json", // our custom-endpoint definitions
});
await modelRuntime.setRuntimeApiKey("<provider>", keyFromCredentialManager); // key stays in memory

const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  retry: { enabled: true, maxRetries: 2 },
});

const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),          // no AGENTS.md/CLAUDE.md pickup
  getSystemPrompt: () => buildSystemPrompt(),           // our frozen-per-session prompt
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const { session } = await createAgentSession({
  cwd: "<winku-data>",            // cwd drives discovery, so never use the user's home
  agentDir: "<winku-data>/engine",
  model: getModel("<provider>", "<model-id>"),
  thinkingLevel: "medium",
  modelRuntime, resourceLoader, settingsManager,
  sessionManager: /* file-backed manager under <winku-data>/engine/sessions */,
  tools: [/* see the Windows section */],
});
```

- **Events:** `session.subscribe(e => …)` streams them. Text deltas arrive as `message_update` events with `assistantMessageEvent.type === "text_delta"`. `message_end` carries the final message. `agent_end` does **not** mean idle, because retries, compaction or queued messages can follow; use `agent_settled` for that.
- **Sending messages:**
  - `prompt()` resolves when the run finishes.
  - While a reply is streaming you must choose `steer()` (the message goes in after the current turn) or `followUp()` (it goes in after the whole run). A plain `prompt()` mid-stream is rejected.
  - `abort()` stops the run and waits for idle. This is our `Esc`.
- **Session lifecycle:** `session.dispose()` on shutdown. `AgentSessionRuntime` has `newSession()`, `switchSession()`, `fork()` and `importFromJsonl()`. These give us Clear (new session) and History > Restore (switch session). Event subscriptions have to be re-attached after the session is swapped.
- **Read-only state:** `session.messages`, `session.model`, `session.thinkingLevel`, `session.systemPrompt` and `session.getActiveToolNames()`.

## Keeping the app isolated from any pi install

| Concern | Control |
|---|---|
| User config folder (`~/.pi/agent`) | `agentDir` option, or the `PI_CODING_AGENT_DIR` environment variable |
| Session storage | our own `SessionManager` path, or `PI_CODING_AGENT_SESSION_DIR` |
| Project `.pi/` folders and context files (`AGENTS.md`/`CLAUDE.md` in the working directory **and every parent**) | custom `ResourceLoader` plus a `cwd` that we own |
| Extensions, skills, prompt templates, themes, MCP | custom `ResourceLoader`. SDK sessions don't load codemode, tool_search or MCP by default. |
| Network activity (model catalog refresh, etc.) | `PI_OFFLINE=1` |
| pi.dev version check | `PI_SKIP_VERSION_CHECK=1` |
| Telemetry and provider attribution headers | `PI_TELEMETRY=0` |
| Long prompt-cache retention where the provider supports it | `PI_CACHE_RETENTION=long` (optional) |

The CLI equivalents, for reference only: `--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-mcp --no-approve --offline --session-dir <dir> --system-prompt <text|path>`.

## Models and providers (`docs/models.md`, `docs/providers.md`, `docs/models-configuration.md`)

- pi ships a model catalog covering providers, model IDs, capabilities, context limits and pricing. The bundled copy works offline. With `PI_OFFLINE`, it is never updated from pi.dev.
- The fields we read: `input: ["text","image"]` (decides vision), `contextWindow` (drives the meter), `maxTokens`, `reasoning` (whether thinking levels apply), `promptCache: { short, long }`.
- Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, limited to what each model supports.
- **Custom OpenAI-compatible endpoints** go in `models.json`:

  ```json
  { "providers": { "custom": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b", "input": ["text"], "contextWindow": 32768 }]
  } } }
  ```

  - `apiKey` and header values accept a `$ENV`/`${ENV}` reference, a literal, or a `!command`.
  - `modelOverrides` changes metadata for a built-in model without replacing the provider's model list.
  - Image resizing is set with `inputLimits.images.resize` (`maxWidth`/`maxHeight`/`maxBytes`/`jpegQuality`). Defaults are 2000×2000 px, 4.5 MiB, quality 80. For `look_at_screen` we want smaller, e.g. 1568 px and 512 KB.
- **Live model lists:** call the endpoint's `/v1/models` ourselves and register the result, either with `pi.registerProvider(...)` from an inline extension or by writing `models.json`. Implement `refreshModels` for lists that change while the app is running.
- **Credential precedence:** runtime key (`setRuntimeApiKey` / `--api-key`), then `auth.json`, then `models.json` `apiKey`, then environment variables. **We only use runtime keys, read from Windows Credential Manager, so pi never writes `auth.json`.**
- OpenRouter with a key lists only the models that key can use, via `/models/user`. That is probably disabled under `PI_OFFLINE`, so do our own `/models` fetch.

## Tools and the "ask before running" gate (`docs/extensions.md`)

- Register custom tools in an inline extension with `pi.registerTool({ name, label, description, parameters: Type.Object({...}), execute(toolCallId, params, signal, onUpdate, ctx) })`. Parameters use TypeBox.
- The gate: `pi.on("tool_call", async (event, ctx) => …)` returns `{ block: true, reason?, terminate? }` to deny a call.
- Other useful hooks: `session_start`/`session_shutdown` (with a `reason`), `turn_end`, `cache_warming_decision`, `systemPromptOptions`.
- The SDK options `tools`, `noTools`, `excludeTools` and `customTools` control which tools are active.

### Windows shell (`docs/windows.md`)

- pi's built-in `bash` tool needs **Git Bash** on native Windows. Many users won't have it.
- There is an optional built-in **`powershell` tool** that uses `pwsh.exe`, falls back to Windows PowerShell, and exists only on native Windows.
- **Plan:** on Windows, use `["read", "powershell", "edit", "write"]` plus our own tools, and add `bash` only when Git Bash is found.

## Compaction (`docs/compaction.md`)

- Compaction starts when `contextTokens > contextWindow - reserveTokens` (defaults: `reserveTokens` 16384, `keepRecentTokens` 20000). During a multi-step run the check happens after tool results are added. Overflow recovery compacts and retries.
- The default summary format is coding-oriented. **Replace it** through `session_before_compact` (reason `manual`, `threshold` or `overflow`; the handler can cancel or supply the summary). `session_compact` and `session_compact_failed` follow. Our handler also drops screenshots, points the `MEMORY.md` snapshot at the latest version, and drives the eyes' yawn.
- Summarisation requests don't write to the prompt cache.
- A persistent session is a JSONL entry tree (`docs/session-format.md`, `docs/sessions.md`). `SessionManager` is the source of truth; build a restored session from the manager rather than assigning `session.agent.state.messages`.

## Open questions for the spike

1. Does `bun build --compile` of an SDK host run on Windows? Binary size and idle RSS?
2. Can the file-backed `SessionManager` be pointed at a custom directory from the SDK? (`examples/sdk/11-sessions.ts`, `session-manager.ts`)
3. Is `refreshModels` or a written `models.json` the cleaner way to add a custom endpoint's live model list?
4. Does `PI_OFFLINE` affect anything we do want?
5. Is the `powershell` tool's output good enough, or do we need a custom `run_command` tool?

## Reading the research page

The user's research page is a JS canvas inside an iframe, so a plain fetch returns nothing useful. Fetch `/__cursor/frame?v=<id>` with `Referer` and `Sec-Fetch-Dest: iframe` headers, then decode `window.__sharedCanvasPayload.appJsB64` (base64 + gzip) and take the JSON string `"userModule"`. Render it with dark `colorScheme`; light mode breaks the design.
