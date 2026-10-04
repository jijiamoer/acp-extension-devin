# acp-extension-devin

Lody's ACP compatibility adapter for the official Devin CLI.

```text
ACP client → acp-extension-devin → official `devin acp`
```

Devin already speaks ACP, so this is an ACP-to-ACP adapter. It launches the
official runtime named by `DEVIN_PATH`, forwards standard ACP traffic in both
directions, and translates the private `cognition.ai/*` wire into `acp-extension-core` contracts. The adapter does not bundle, build, or patch Devin, and it does not
depend on Lody workspace packages. Devin owns models, tools, sessions,
permissions and MCP connections.

## Run

Requires Node.js 22.14 or newer and pnpm 10.20.

```sh
pnpm install
pnpm build
DEVIN_PATH=/path/to/official/devin node dist/index.js
```

`DEVIN_PATH` is required and is used exactly as given; the adapter never
searches `PATH`. It starts `$DEVIN_PATH acp` with the inherited environment and
injects no configuration of its own. Authenticate and choose models through
Devin on the execution machine.

stdout carries ACP only; diagnostics and Devin's stderr go to stderr. When the
client closes the connection, the adapter ends Devin's stdin, then exits with
the runtime's exit code or re-raises its terminating signal.

## Runtime contract

`runtime-manifest.json` pins the official runtime the adapter is built against
and every private field it relies on: `_meta` keys such as
`cognition.ai/subagent_context`, the `cognition.ai/subagentSupport` client
capability, the `_cognition.ai/compaction` notification method, the `sk::`
sidekick tool-call prefix, and the reserved agent IDs.
Tests assert against these values.

The manifest declares Devin 3000.11.1 as the minimum supported version; from
that version Devin accepts stdio, HTTP and SSE MCP servers in session requests.
The pinned and end-to-end validated version is 3000.11.3.

## Capabilities

The adapter advertises only what it translates. Compaction lifecycle
notifications are translated directly, while subagent events are translated
after bilateral negotiation. Other ACP traffic passes through.

- Standard ACP from Devin, including sessions, prompts, tool calls,
  permission requests, modes and configuration options, passes through as the
  runtime reports it.
- Core `subagentEvents` v1, described below.
- Core `compaction` v1, described below.
- Core `steering` v1, described below.
- MCP servers supplied by the client, forwarded verbatim.

Usage accounting and a dedicated Plan Mode translation are not
implemented, and the adapter does not advertise them.

## Subagent events

The adapter always advertises `subagentEvents` v1 in
`agentCapabilities._meta.lody`. Only when the client also advertises
`clientCapabilities._meta.lody.subagentEvents` (`{ version: 1 }`) does it
request Devin's private subagent stream with `cognition.ai/subagentSupport`
and translate it; otherwise Devin's native output passes through untouched.

Once negotiated, delegated work becomes independent Core runs on
`_lody/subagents/event` instead of appearing in the root transcript:

- A `run_subagent` child becomes a run from Devin's explicit started and
  completed rows. Its text, thoughts, plans and tool steps are attributed to
  that run, and its context usage is reported as run progress. A nested child
  records its parent run.
- A Fusion **Sidekick** handoff becomes a run named `Sidekick` that carries its
  tool steps. Devin reports no lifecycle for sidekicks, so the adapter infers
  when a run starts and ends from the sidekick tool calls and root activity. It
  never invents a description or summary.
- Permission requests raised by a run's tool calls still go to the client
  through the root session, with a run-scoped tool-call ID and
  `_meta.lody.subagentRunId` / `subagentToolCallId` identifying the owner.

Run IDs are owned by the adapter and differ from Devin's agent IDs; an agent ID
reused after its run has ended starts a new run. Each run's snapshot precedes
its content, and content arriving after termination is dropped. Child output
is never re-emitted to the root stream, including events the adapter cannot
attribute. Runs do not support cancellation or output reads.

`session/load` and `session/resume` replay is forwarded unchanged and creates
no runs.

## Compaction

Devin's `_cognition.ai/compaction` notifications become Core context-compaction activities on standard ACP `tool_call` and `tool_call_update` messages. Native `started`, `completed` and `failed` states drive the lifecycle, and native summaries are retained in the activity details.

The native `compact` command is available through the standard ACP prompt path. Its response can arrive before compaction finishes; the native notifications determine completion. Manual compaction, automatic compaction, and cancellation have been verified on Devin 3000.11.3. Manual compaction has also been verified in the Lody UI.

## MCP

`mcpServers` from `session/new` and `session/load` are forwarded to Devin
verbatim. Devin supports stdio, Streamable HTTP and SSE servers in these
requests, so the adapter needs no MCP-specific translation and never writes an
MCP configuration file.

Through the adapter on Devin 3000.11.3:

- stdio, Streamable HTTP and SSE servers each completed real tool calls, and
  configured HTTP/SSE request headers reached the server;
- after `session/load` in a new adapter process, a newly supplied HTTP server
  was available to the loaded session;
- Sidekick and foreground subagents called MCP tools, and those steps were
  attributed to their runs;
- in Code mode, approving the permission request let the MCP call proceed.

In Lody Nightly 0.103.0-nightly.1, with Devin's global configuration isolated,
a session created from the UI called a tool on Lody's built-in HTTP MCP server.

## Steering

`devin acp` steers natively: a `session/prompt` sent while a turn is running
interrupts the current instruction and injects the message into the same turn.
Both the interrupted and the steering request resolve when that turn ends, and
Devin coalesces their responses onto the first user message.

The adapter advertises `steering` v1 (`transport: "request"`,
`upstreamTurn: "same"`, `configPolicy: "active"`) and serves it two ways:

- `_lody/session/steer` is answered `injected` immediately and forwarded as
  an adapter-owned `session/prompt` — Devin's steer transport, so the write
  is the application: `steer_applied` is emitted at once with the request's
  `steerId`, and the forwarded prompt's coalesced response (which arrives
  only at turn end, after the turn's own response) is suppressed entirely.
- `_meta.lody.steer: { id }` on a client `session/prompt` is stripped before
  forwarding, `steer_applied` is emitted on send, and the response passes
  through normally.

Steers to unknown or unadmitted sessions fail with `outcome: "failed"`.
Verified on Devin 3000.11.3 and 3000.10.31: the steering message overrides
the in-flight instruction inside the same turn, and backgrounded tool calls
keep running. Reporting `steer_applied` earlier than the coalesced response
is required — Devin answers the turn's original request first, and a client
racing its turn completion would otherwise drop the application.

## Validation

```sh
pnpm check
pnpm build
```

`pnpm check` runs type checking, the Vitest suite and Prettier. Tests use
synthetic ACP messages and an injected `spawnImpl`; they never start a real
Devin process or contact a model provider. They cover negotiation, run
attribution and lifecycle, permission routing, replay handling, the runtime
launch command, the manifest pin, compaction lifecycle, summaries and
cancellation, and verbatim forwarding of non-empty stdio, HTTP and SSE MCP
configurations in `session/new` and `session/load`, with and without subagent
negotiation.

The end-to-end MCP results above were observed on Devin 3000.11.3. They do not
establish behavior on other runtime versions or real-provider quality.
