import { randomUUID } from "node:crypto";

import {
  LODY_EXTENSION_METHODS,
  LODY_SUBAGENT_EVENT_METHOD,
  supportsLodySubagentEvents,
} from "acp-extension-core";

import {
  clientSupportsLodyElicitation,
  foldElicitationResponse,
  rewriteElicitationParams,
  type CustomAnswerField,
} from "./elicitation.js";
import { privateWireContract as contract } from "./manifest.js";
import {
  DevinSubagentEvents,
  type DevinSubagentEventsOptions,
  type SubagentOut,
} from "./subagents.js";

const SUBAGENT_SUPPORT_META = contract.subagentSupportClientCapability;
const SUBAGENT_EVENTS_CAPABILITY = { version: 1 } as const;
const COMPACTION_CAPABILITY = { version: 1 } as const;
const ELICITATION_CAPABILITY = { version: 1 } as const;
const COMPACTION_ACTIVITY_META = {
  lody: { activity: { version: 1, kind: "context_compaction" } },
} as const;
const STEER_METHOD = LODY_EXTENSION_METHODS.sessionSteer;
const STEER_APPLIED_METHOD = LODY_EXTENSION_METHODS.sessionSteerApplied;
// `devin acp` injects a mid-turn session/prompt into the active turn, so the
// adapter serves the dedicated steer request and reports same-turn injection.
const STEER_CAPABILITY = {
  version: 1,
  transport: "request",
  upstreamTurn: "same",
  configPolicy: "active",
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: unknown;
}

export type JsonRpcMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface ProxyOutput {
  toClient: JsonRpcMessage[];
  toRuntime: JsonRpcMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return (
    typeof (message as JsonRpcRequest).method === "string" &&
    (message as JsonRpcRequest).id !== undefined &&
    (message as JsonRpcRequest).id !== null
  );
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return (
    (message as JsonRpcResponse).id !== undefined &&
    (message as JsonRpcResponse).id !== null &&
    (message as JsonRpcRequest).method === undefined
  );
}

interface PendingRequest {
  method: string;
  sessionId?: string;
  manualCompaction?: boolean;
  /** hides the coalesced runtime response of a forwarded steer prompt. */
  suppressPromptResponse?: boolean;
  /**
   * steerId tied to this prompt: set on adapter-forwarded steers (applied
   * already sent; errors surface as a notice) and on meta-tagged prompts that
   * actually steered a running turn (applied sent with the response).
   */
  steerId?: string;
}

interface ActiveCompaction {
  toolCallId: string;
  shown: boolean;
}

function hasCompactionSummary(summary: unknown): summary is string {
  return typeof summary === "string" && summary.trim().length > 0;
}

function isManualCompactionPrompt(params: unknown): boolean {
  if (!isRecord(params) || !Array.isArray(params["prompt"])) return false;
  let text: string | undefined;
  for (const block of params["prompt"]) {
    if (
      !isRecord(block) ||
      block["type"] !== "text" ||
      typeof block["text"] !== "string"
    ) {
      return false;
    }
    const value = block["text"].trim();
    if (!value) continue;
    if (text !== undefined) return false;
    text = value;
  }
  const command = contract.compactionManualCommand;
  return text === command || text?.startsWith(`${command} `) === true;
}

/**
 * Reads `params._meta.lody.steer` off a session/prompt and returns the prompt
 * params with that field stripped. Returns undefined when absent or malformed.
 */
function takeLodySteer(
  params: unknown,
): { steerId: string; params: Record<string, unknown> } | undefined {
  if (!isRecord(params)) return undefined;
  const meta = isRecord(params["_meta"]) ? params["_meta"] : undefined;
  const lody = isRecord(meta?.["lody"]) ? meta["lody"] : undefined;
  const steer = isRecord(lody?.["steer"]) ? lody["steer"] : undefined;
  if (typeof steer?.["id"] !== "string") return undefined;

  const restLody = { ...lody };
  delete restLody["steer"];
  const restMeta = { ...meta };
  if (Object.keys(restLody).length > 0) {
    restMeta["lody"] = restLody;
  } else {
    delete restMeta["lody"];
  }
  const next = { ...params };
  if (Object.keys(restMeta).length > 0) {
    next["_meta"] = restMeta;
  } else {
    delete next["_meta"];
  }
  return { steerId: steer["id"], params: next };
}

/**
 * ACP-to-ACP proxy between Lody (client) and `devin acp` (runtime).
 * For admitted root sessions it translates native compaction lifecycle
 * notifications into Core activities; subagent event translation additionally
 * requires bilateral negotiation. When the client advertises
 * `_meta.lody.elicitation`, private elicitation hints are translated into the
 * Core elicitation contract. Other ACP traffic is forwarded unchanged.
 */
export class DevinAcpProxy {
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly sessions = new Map<string, DevinSubagentEvents>();
  private readonly admitted = new Set<string>();
  /** sessions inside a session/load replay window: updates pass through. */
  private readonly replaying = new Set<string>();
  /** sessions whose next compaction started event belongs to a manual /compact prompt. */
  private readonly manualCompactionArmed = new Set<string>();
  /** admitted sessions with a live native compaction. */
  private readonly activeCompactions = new Map<string, ActiveCompaction>();
  private negotiated = false;
  /** client advertised _meta.lody.elicitation — translate private elicitation hints. */
  private lodyElicitation = false;
  /** elicitation/create request id -> injected custom-answer companion fields. */
  private readonly elicitationCustomFields = new Map<
    JsonRpcId,
    Map<string, CustomAnswerField>
  >();
  private readonly subagentOpts: DevinSubagentEventsOptions;
  private readonly newId: () => string;

  constructor(opts: DevinSubagentEventsOptions = {}) {
    this.subagentOpts = opts;
    this.newId = opts.newId ?? randomUUID;
  }

  handleClient(message: unknown): ProxyOutput {
    let msg = message as JsonRpcMessage;
    if (!isRecord(msg)) return { toClient: [], toRuntime: [msg] };

    if (isRequest(msg)) {
      if (msg.method === STEER_METHOD) {
        return this.handleSteerRequest(msg);
      }

      // `_meta.lody.steer` tags a prompt as a steer: strip it before the
      // runtime sees it and mark the pending request for steer_applied.
      const steer =
        msg.method === "session/prompt" ? takeLodySteer(msg.params) : undefined;
      if (steer) {
        msg = {
          jsonrpc: "2.0",
          id: msg.id,
          method: msg.method,
          params: steer.params,
        };
      }

      const sessionId =
        isRecord(msg.params) && typeof msg.params["sessionId"] === "string"
          ? msg.params["sessionId"]
          : undefined;
      const manualCompaction =
        msg.method === "session/prompt" &&
        sessionId !== undefined &&
        isManualCompactionPrompt(msg.params);
      this.pending.set(msg.id, {
        method: msg.method,
        sessionId,
        manualCompaction,
        // A tagged prompt is a steer only while another client turn runs;
        // on its own it is just a prompt and earns no steer_applied.
        steerId:
          steer && sessionId && this.hasActiveClientPrompt(sessionId)
            ? steer.steerId
            : undefined,
      });

      if (msg.method === "initialize") {
        const caps = isRecord(msg.params)
          ? msg.params["clientCapabilities"]
          : undefined;
        this.negotiated = supportsLodySubagentEvents(caps);
        this.lodyElicitation = clientSupportsLodyElicitation(caps);
        if (this.negotiated && isRecord(msg.params)) {
          // ask the runtime for its private subagent stream
          msg = {
            ...msg,
            params: {
              ...msg.params,
              clientCapabilities: {
                ...(isRecord(caps) ? caps : {}),
                _meta: {
                  ...(isRecord(caps) && isRecord(caps["_meta"])
                    ? caps["_meta"]
                    : {}),
                  [SUBAGENT_SUPPORT_META]: true,
                },
              },
            },
          };
        }
      }

      if (msg.method === "session/prompt" && sessionId) {
        if (manualCompaction) {
          this.manualCompactionArmed.add(sessionId);
        } else {
          this.manualCompactionArmed.delete(sessionId);
        }
      }

      if (
        (msg.method === "session/load" || msg.method === "session/resume") &&
        sessionId
      ) {
        this.replaying.add(sessionId);
        this.manualCompactionArmed.delete(sessionId);
      }
    }
    // Client responses to runtime reverse requests carry an id but no method;
    // they are forwarded verbatim and must not touch the pending map.
    if (isResponse(msg)) {
      const customFields = this.elicitationCustomFields.get(msg.id);
      if (customFields) {
        this.elicitationCustomFields.delete(msg.id);
        const result = foldElicitationResponse(msg.result, customFields);
        if (result !== undefined) msg = { ...msg, result };
      }
    }
    return { toClient: [], toRuntime: [msg] };
  }

  handleRuntime(message: unknown): ProxyOutput {
    const msg = message as JsonRpcMessage;
    if (!isRecord(msg)) return { toClient: [msg], toRuntime: [] };

    if (isResponse(msg)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      return this.handleRuntimeResponse(msg, pending);
    }

    if (isRequest(msg)) {
      return this.handleRuntimeRequest(msg);
    }

    // notifications
    if (msg.method === "session/update" && isRecord(msg.params)) {
      return this.handleSessionUpdate(msg);
    }
    if (msg.method === contract.compactionNotificationMethod) {
      return this.handleCompactionNotification(msg);
    }
    return { toClient: [msg], toRuntime: [] };
  }

  private handleRuntimeResponse(
    msg: JsonRpcResponse,
    pending: PendingRequest | undefined,
  ): ProxyOutput {
    const toClient: JsonRpcMessage[] = [];

    if (pending?.method === "initialize" && isRecord(msg.result)) {
      const agentCaps = isRecord(msg.result["agentCapabilities"])
        ? msg.result["agentCapabilities"]
        : {};
      const meta = isRecord(agentCaps["_meta"]) ? agentCaps["_meta"] : {};
      const lody = isRecord(meta["lody"]) ? meta["lody"] : {};
      const result = {
        ...msg.result,
        agentCapabilities: {
          ...agentCaps,
          _meta: {
            ...meta,
            lody: {
              ...lody,
              subagentEvents: SUBAGENT_EVENTS_CAPABILITY,
              compaction: COMPACTION_CAPABILITY,
              elicitation: ELICITATION_CAPABILITY,
              steering: STEER_CAPABILITY,
            },
          },
        },
      };
      toClient.push({ ...msg, result });
      return { toClient, toRuntime: [] };
    }

    if (
      pending?.manualCompaction &&
      pending.sessionId &&
      msg.error !== undefined
    ) {
      this.manualCompactionArmed.delete(pending.sessionId);
    }

    if (
      pending?.method === "session/new" ||
      pending?.method === "session/fork"
    ) {
      if (isRecord(msg.result) && typeof msg.result["sessionId"] === "string") {
        this.admit(msg.result["sessionId"]);
      }
    } else if (
      (pending?.method === "session/load" ||
        pending?.method === "session/resume") &&
      pending.sessionId
    ) {
      this.replaying.delete(pending.sessionId);
      if (msg.result !== undefined && msg.error === undefined) {
        this.admit(pending.sessionId);
      }
    } else if (pending?.method === "session/prompt" && pending.sessionId) {
      const session = this.sessions.get(pending.sessionId);
      if (session) {
        const isError = msg.error !== undefined;
        const stopReason =
          isRecord(msg.result) && typeof msg.result["stopReason"] === "string"
            ? msg.result["stopReason"]
            : undefined;
        for (const o of session.handlePromptDone(stopReason, isError)) {
          toClient.push(...this.render(session, o));
        }
      }
      if (pending.suppressPromptResponse) {
        if (pending.steerId && msg.error !== undefined) {
          toClient.push(
            this.steerFailureNotice(pending.sessionId, pending.steerId, msg),
          );
        }
        return { toClient, toRuntime: [] };
      }
      // Meta-tagged steers report application with their own response: it
      // cannot arrive before the sender's completion, and a rejected prompt
      // must never be reported applied.
      if (pending.steerId && msg.error === undefined) {
        toClient.push({
          jsonrpc: "2.0",
          method: STEER_APPLIED_METHOD,
          params: { sessionId: pending.sessionId, steerId: pending.steerId },
        });
      }
    }

    toClient.push(msg);
    return { toClient, toRuntime: [] };
  }

  /**
   * `_lody/session/steer`: only while the session has a client-owned prompt
   * in flight — an idle session would otherwise turn the forwarded write into
   * an invisible new turn whose response nobody owns. Accepted steers answer
   * `injected` and emit steer_applied at once: the forwarded prompt's coalesced
   * response arrives only at turn end, after the turn's own response, which
   * would race the client's completion (verified live: Lody drops late
   * applications). A rejected forward surfaces as a session notice so the
   * application claim never stands alone.
   */
  private handleSteerRequest(msg: JsonRpcRequest): ProxyOutput {
    const fail = (): ProxyOutput => ({
      toClient: [{ jsonrpc: "2.0", id: msg.id, result: { outcome: "failed" } }],
      toRuntime: [],
    });

    const params = isRecord(msg.params) ? msg.params : {};
    const sessionId =
      typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
    const steerId =
      typeof params["steerId"] === "string" ? params["steerId"] : undefined;
    const prompt = params["prompt"];
    if (
      sessionId === undefined ||
      steerId === undefined ||
      !Array.isArray(prompt) ||
      !this.admitted.has(sessionId) ||
      !this.hasActiveClientPrompt(sessionId)
    ) {
      return fail();
    }

    const fwdId = this.newId();
    this.pending.set(fwdId, {
      method: "session/prompt",
      sessionId,
      suppressPromptResponse: true,
      steerId,
    });
    return {
      toClient: [
        { jsonrpc: "2.0", id: msg.id, result: { outcome: "injected" } },
        {
          jsonrpc: "2.0",
          method: STEER_APPLIED_METHOD,
          params: { sessionId, steerId },
        },
      ],
      toRuntime: [
        {
          jsonrpc: "2.0",
          id: fwdId,
          method: "session/prompt",
          params: { sessionId, prompt },
        },
      ],
    };
  }

  /**
   * A client-owned `session/prompt` is in flight for this session — the only
   * state in which a steer can ride a live turn. Adapter-forwarded prompts
   * (suppressed responses) do not count.
   */
  private hasActiveClientPrompt(sessionId: string): boolean {
    for (const p of this.pending.values()) {
      if (
        p.method === "session/prompt" &&
        p.sessionId === sessionId &&
        !p.suppressPromptResponse
      ) {
        return true;
      }
    }
    return false;
  }

  /** `_meta.lody.notice` surfacing a forwarded steer Devin rejected. */
  private steerFailureNotice(
    sessionId: string,
    steerId: string,
    msg: JsonRpcResponse,
  ): JsonRpcMessage {
    const detail = isRecord(msg.error)
      ? typeof msg.error["message"] === "string"
        ? msg.error["message"]
        : `error ${msg.error["code"]}`
      : "unknown error";
    return {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          _meta: {
            lody: {
              notice: {
                level: "error",
                message: `Steer ${steerId} failed: ${detail}`,
                source: "devin",
              },
            },
          },
        },
      },
    };
  }

  private handleRuntimeRequest(msg: JsonRpcRequest): ProxyOutput {
    if (
      msg.method === "elicitation/create" &&
      isRecord(msg.params) &&
      this.lodyElicitation
    ) {
      const rewritten = rewriteElicitationParams(msg.params);
      if (rewritten) {
        if (rewritten.customFields.size > 0) {
          this.elicitationCustomFields.set(msg.id, rewritten.customFields);
        }
        return {
          toClient: [{ ...msg, params: rewritten.params }],
          toRuntime: [],
        };
      }
    }
    if (msg.method === "session/request_permission" && isRecord(msg.params)) {
      const sessionId =
        typeof msg.params["sessionId"] === "string"
          ? msg.params["sessionId"]
          : undefined;
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (
        session &&
        sessionId &&
        this.admitted.has(sessionId) &&
        !this.replaying.has(sessionId)
      ) {
        const rewritten = session.rewritePermissionParams(msg.params);
        if (rewritten) {
          const toClient: JsonRpcMessage[] = [];
          for (const o of rewritten.events) {
            toClient.push(...this.render(session, o));
          }
          toClient.push({ ...msg, params: rewritten.params });
          return { toClient, toRuntime: [] };
        }
      }
    }
    return { toClient: [msg], toRuntime: [] };
  }

  private handleSessionUpdate(msg: JsonRpcNotification): ProxyOutput {
    const params = msg.params as Record<string, unknown>;
    const sessionId =
      typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
    const update = params["update"];
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (
      !this.negotiated ||
      !sessionId ||
      !session ||
      !this.admitted.has(sessionId) ||
      this.replaying.has(sessionId) ||
      !isRecord(update)
    ) {
      return { toClient: [msg], toRuntime: [] };
    }
    const toClient: JsonRpcMessage[] = [];
    for (const o of session.handleSessionUpdate(update)) {
      toClient.push(...this.render(session, o));
    }
    return { toClient, toRuntime: [] };
  }

  /**
   * Devin's private `_cognition.ai/compaction` lifecycle, rendered as a Core
   * context-compaction activity on a synthetic tool call. The native lifecycle
   * owns completion independently of the `/compact` prompt response. Only
   * admitted sessions outside a replay window produce activity; replay and
   * malformed or unknown-status rows pass through untouched.
   */
  private handleCompactionNotification(msg: JsonRpcNotification): ProxyOutput {
    const params = msg.params;
    const sessionId =
      isRecord(params) &&
      typeof params[contract.compactionSessionIdField] === "string" &&
      params[contract.compactionSessionIdField]
        ? (params[contract.compactionSessionIdField] as string)
        : undefined;
    const status = isRecord(params)
      ? params[contract.compactionStatusField]
      : undefined;
    const known =
      status === contract.compactionStartedStatus ||
      status === contract.compactionCompletedStatus ||
      status === contract.compactionFailedStatus;
    if (
      !sessionId ||
      !known ||
      !this.admitted.has(sessionId) ||
      this.replaying.has(sessionId)
    ) {
      return { toClient: [msg], toRuntime: [] };
    }

    if (status === contract.compactionStartedStatus) {
      if (this.activeCompactions.has(sessionId)) {
        return { toClient: [], toRuntime: [] };
      }
      const toolCallId = `devin-compaction-${this.newId()}`;
      const shown = this.manualCompactionArmed.delete(sessionId);
      this.activeCompactions.set(sessionId, { toolCallId, shown });
      if (!shown) return { toClient: [], toRuntime: [] };
      return {
        toClient: [this.compactionStart(sessionId, toolCallId)],
        toRuntime: [],
      };
    }

    const active = this.activeCompactions.get(sessionId);
    this.activeCompactions.delete(sessionId);
    if (!active) {
      return { toClient: [], toRuntime: [] };
    }
    const manuallyArmed = this.manualCompactionArmed.delete(sessionId);
    const summary = (params as Record<string, unknown>)[
      contract.compactionSummaryField
    ];
    const terminal = this.compactionTerminal(
      sessionId,
      active.toolCallId,
      status,
      summary,
    );
    if (active.shown) {
      return { toClient: [terminal], toRuntime: [] };
    }
    if (
      !manuallyArmed &&
      status === contract.compactionCompletedStatus &&
      !hasCompactionSummary(summary)
    ) {
      return { toClient: [], toRuntime: [] };
    }
    return {
      toClient: [this.compactionStart(sessionId, active.toolCallId), terminal],
      toRuntime: [],
    };
  }

  private compactionStart(
    sessionId: string,
    toolCallId: string,
  ): JsonRpcNotification {
    return {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Compact context",
          kind: "other",
          status: "in_progress",
          _meta: { ...COMPACTION_ACTIVITY_META },
        },
      },
    };
  }

  private compactionTerminal(
    sessionId: string,
    toolCallId: string,
    status: string,
    summary: unknown,
  ): JsonRpcNotification {
    const update: Record<string, unknown> = {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
      _meta: { ...COMPACTION_ACTIVITY_META },
    };
    if (
      status === contract.compactionCompletedStatus &&
      hasCompactionSummary(summary)
    ) {
      update["content"] = [
        { type: "content", content: { type: "text", text: summary } },
      ];
    }
    return {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    };
  }

  private render(
    session: DevinSubagentEvents,
    out: SubagentOut,
  ): JsonRpcMessage[] {
    if (out.kind === "event") {
      return [
        {
          jsonrpc: "2.0",
          method: LODY_SUBAGENT_EVENT_METHOD,
          params: out.event as unknown as Record<string, unknown>,
        },
      ];
    }
    return [
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: session.sessionId, update: out.update },
      },
    ];
  }

  private admit(sessionId: string) {
    if (!this.admitted.has(sessionId)) {
      this.admitted.add(sessionId);
      this.sessions.set(
        sessionId,
        new DevinSubagentEvents(sessionId, this.subagentOpts),
      );
    }
  }

  /** Method of the still-pending client request, for translation dispatch. */
  pendingClientMethod(id: JsonRpcId): string | undefined {
    return this.pending.get(id)?.method;
  }
}
