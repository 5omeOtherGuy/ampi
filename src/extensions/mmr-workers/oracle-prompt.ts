import path from "node:path";
import { Type, type Static } from "typebox";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
import type { OracleAttachmentRecord } from "./oracle-result.js";

/**
 * Pure parameter and prompt shaping for the oracle/advisor tools: the
 * oracle parameters schema, advisor-params coercion/normalization, the
 * path-containment predicate and image-extension set used to classify
 * attachments, and the worker user-prompt builder. No filesystem reads or
 * worker state live here (attachment resolution stays in `oracle.ts`).
 * `oracle.ts` re-exports the public surface, so the entry file remains the
 * stable import path.
 *
 * This module is a leaf at runtime: the `import type` reference to
 * `./oracle-result.js` is erased and creates no runtime cycle.
 */

/** TypeBox parameters schema for the oracle/advisor tool family. */
export const ORACLE_PARAMETERS_SCHEMA = Type.Object(
  {
    task: Type.String({
      description:
        "The task or question you want the oracle to help with. Be specific about what kind of guidance, review, or planning you need.",
    }),
    context: Type.Optional(
      Type.String({
        description:
          "Optional context about the current situation, what you've tried, or background information that would help the oracle provide better guidance.",
      }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Optional list of specific file paths (text files, images) that the oracle should examine as part of its analysis. These files will be attached to the oracle input.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Back-compat alias for {@link ORACLE_PARAMETERS_SCHEMA}. */
export const oracleParameters = ORACLE_PARAMETERS_SCHEMA;

/** Validated oracle/advisor tool parameters. */
export type OracleParams = Static<typeof ORACLE_PARAMETERS_SCHEMA>;

/** File extensions attached as image records instead of inlined text. */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".svg",
]);

/** Validate and normalize raw advisor params (trims files[], drops empties). */
export function coerceAdvisorParams(toolName: string, raw: unknown): OracleParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${toolName} expects an object with a \`task\` field.`);
  }
  const validated = checkMmrToolParams(toolName, ORACLE_PARAMETERS_SCHEMA, raw);
  if (validated.task.trim().length === 0) {
    throw new Error(`${toolName}.task is required and must be a non-empty string.`);
  }
  // Preserve existing files[] normalization: trim each entry and drop
  // empty strings. TypeBox validates element types but does not
  // normalize, so this step stays in coerce.
  let files: string[] | undefined;
  if (validated.files !== undefined) {
    const cleaned: string[] = [];
    for (const entry of validated.files) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      cleaned.push(trimmed);
    }
    files = cleaned;
  }
  const result: OracleParams = { task: validated.task };
  if (validated.context !== undefined) result.context = validated.context;
  if (files !== undefined) result.files = files;
  return result;
}

/** Attachment record plus its bounded text, threaded from resolution to prompt build. */
export interface InternalAttachment {
  record: OracleAttachmentRecord;
  /** Text already truncated to the per-file byte cap, if `kind === "text"`. */
  text?: string;
}

/** Pure path-containment check: is the target inside the working directory? */
export function pathInsideCwd(absoluteTarget: string, absoluteCwd: string): boolean {
  const relative = path.relative(absoluteCwd, absoluteTarget);
  if (relative === "") return true;
  if (relative.startsWith("..")) return false;
  if (path.isAbsolute(relative)) return false;
  return true;
}

/** Build the worker user prompt from the task, context, and resolved attachments. */
export function buildOracleUserPrompt(
  params: OracleParams,
  attachments: readonly InternalAttachment[],
): string {
  const parts: string[] = [`Task: ${params.task.trim()}`];
  if (params.context && params.context.trim().length > 0) {
    parts.push("", "Context:", params.context.trim());
  }
  if (attachments.length > 0) {
    parts.push("", "Attached files:");
    for (const att of attachments) {
      const record = att.record;
      if (record.kind === "text") {
        const header = record.truncated
          ? `### File: ${record.path} (truncated to first ${record.bytes} bytes of ${record.originalBytes})`
          : `### File: ${record.path}`;
        parts.push("", header, "```", att.text ?? "", "```");
      } else if (record.kind === "image") {
        parts.push(
          "",
          `### Image: ${record.path}`,
          "(Binary image — open with the `read` tool if you need to view it.)",
        );
      } else {
        parts.push("", `### File: ${record.path} (${record.reason})`);
      }
    }
  }
  return parts.join("\n");
}
