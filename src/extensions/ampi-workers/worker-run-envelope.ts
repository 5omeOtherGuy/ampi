/**
 * Build/read helpers for the canonical worker-run details envelope
 * (`{kind:"worker-run", version:1}`, declared in
 * `ampi-core/worker-contract.ts`).
 *
 * Dual-write window: producers spread the envelope fields onto their legacy
 * details objects (the envelope's top-level keys — `kind`, `version`, `run`,
 * `snapshot`, `render` — do not collide with any legacy details field), and
 * the renderer's `buildWorkerRunView` dual-reads: envelope preferred, legacy
 * shape sniffing as fallback. The legacy shapes are deleted one release
 * after dual-write began.
 */
import { isRecord } from "../ampi-core/internal/json.js";
import {
  MMR_WORKER_RUN_ENVELOPE_KIND,
  MMR_WORKER_RUN_ENVELOPE_VERSION,
  type MmrWorkerRunEnvelopeV1,
} from "../ampi-core/worker-contract.js";

/** Inputs for {@link buildWorkerRunEnvelope}; mirrors the envelope, flattened. */
export interface BuildWorkerRunEnvelopeArgs {
  profileName: string;
  toolName: string;
  agent: string;
  runMode: MmrWorkerRunEnvelopeV1["run"]["runMode"];
  status: string;
  workerTools: readonly string[];
  sessionKey?: string;
  taskId?: string;
  groupId?: string;
  terminalOutcome?: MmrWorkerRunEnvelopeV1["run"]["terminalOutcome"];
  resolvedModel?: string;
  contextWindow?: number;
  description?: string;
  promptPreview?: string;
  snapshot?: MmrWorkerRunEnvelopeV1["snapshot"];
  render?: MmrWorkerRunEnvelopeV1["render"];
}

export function buildWorkerRunEnvelope(args: BuildWorkerRunEnvelopeArgs): MmrWorkerRunEnvelopeV1 {
  return {
    kind: MMR_WORKER_RUN_ENVELOPE_KIND,
    version: MMR_WORKER_RUN_ENVELOPE_VERSION,
    run: {
      profileName: args.profileName,
      toolName: args.toolName,
      agent: args.agent,
      runMode: args.runMode,
      status: args.status,
      workerTools: args.workerTools,
      ...(args.sessionKey !== undefined ? { sessionKey: args.sessionKey } : {}),
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      ...(args.groupId !== undefined ? { groupId: args.groupId } : {}),
      ...(args.terminalOutcome !== undefined ? { terminalOutcome: args.terminalOutcome } : {}),
      ...(args.resolvedModel !== undefined ? { resolvedModel: args.resolvedModel } : {}),
      ...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.promptPreview !== undefined ? { promptPreview: args.promptPreview } : {}),
    },
    snapshot: args.snapshot ?? {},
    render: args.render ?? {},
  };
}

/**
 * Read the envelope off a frozen details payload. Returns `undefined` for
 * legacy payloads (no envelope), unknown versions, or malformed shapes —
 * callers fall back to legacy details sniffing.
 */
export function readWorkerRunEnvelope(details: unknown): MmrWorkerRunEnvelopeV1 | undefined {
  if (!isRecord(details)) return undefined;
  if (details.kind !== MMR_WORKER_RUN_ENVELOPE_KIND) return undefined;
  if (details.version !== MMR_WORKER_RUN_ENVELOPE_VERSION) return undefined;
  const run = details.run;
  if (!isRecord(run)) return undefined;
  if (typeof run.profileName !== "string" || typeof run.toolName !== "string" || typeof run.agent !== "string") {
    return undefined;
  }
  if (run.runMode !== "blocking" && run.runMode !== "background" && run.runMode !== "internal") return undefined;
  if (typeof run.status !== "string") return undefined;
  return {
    kind: MMR_WORKER_RUN_ENVELOPE_KIND,
    version: MMR_WORKER_RUN_ENVELOPE_VERSION,
    run: run as MmrWorkerRunEnvelopeV1["run"],
    snapshot: isRecord(details.snapshot) ? (details.snapshot as MmrWorkerRunEnvelopeV1["snapshot"]) : {},
    render: isRecord(details.render) ? (details.render as MmrWorkerRunEnvelopeV1["render"]) : {},
  };
}

/**
 * Dual-write: spread the envelope onto a legacy details object. The envelope
 * keys never collide with legacy details fields, so legacy consumers keep
 * reading their fields verbatim while envelope-aware consumers prefer the
 * canonical shape.
 */
export function attachWorkerRunEnvelope<T>(legacyDetails: T, envelope: MmrWorkerRunEnvelopeV1): T {
  if (typeof legacyDetails !== "object" || legacyDetails === null) return legacyDetails;
  return { ...legacyDetails, ...envelope };
}
