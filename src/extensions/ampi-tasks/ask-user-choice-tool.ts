/**
 * `ask_user_choice`: the model asks the user to pick one of a few options.
 *
 * With a UI (the terminal, or a client of Pi's RPC mode) the call opens
 * Pi's select dialog with the options, plus a last row for typing a different
 * answer when `allow_other` is set. The call's abort signal closes the dialog,
 * so an interrupt never leaves it open. Without a UI (print and JSON mode,
 * subagent children) nobody can answer, so the call fails at once and the
 * model decides on its own.
 *
 * Closing the dialog without a choice is not an error: the result tells the
 * model the user did not choose, so it asks in plain text or goes on with an
 * assumption it states.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerAmpiOwnedTool } from "../ampi-core/owned-tools.js";

export const ASK_USER_CHOICE_TOOL_NAME = "ask_user_choice";

const QUESTION_MAX = 200;
const OPTION_MAX = 80;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 8;

/** The last row when `allow_other` is set; it opens a text input. */
export const ASK_USER_CHOICE_OTHER_ROW = "Type a different answer…";

export const ASK_USER_CHOICE_PARAMS = Type.Object(
  {
    question: Type.String({
      minLength: 1,
      maxLength: QUESTION_MAX,
      description: "The question, on one line (at most 200 characters). It is the dialog's title.",
    }),
    options: Type.Array(
      Type.String({ minLength: 1, maxLength: OPTION_MAX, description: "One answer, at most 80 characters." }),
      {
        minItems: OPTIONS_MIN,
        maxItems: OPTIONS_MAX,
        description: "Between 2 and 8 distinct answers, in the order the user should see them.",
      },
    ),
    allow_other: Type.Optional(
      Type.Boolean({
        default: false,
        description: "Add a last row that lets the user type an answer that is not in the list. Default false.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const ASK_USER_CHOICE_DESCRIPTION = `Ask the user to pick one answer from a short list.

Call this only when the next step depends on a decision that belongs to the
user and you can name the possible answers in advance (for example which of
two approaches to take, or which file to change). Do not use it for questions
you can settle by reading the code or running a command, for open-ended
questions, or to ask for permission to continue work that was already
requested.

The user sees the question and the options as a list and picks one. Set
\`allow_other\` when none of the options may fit; the user can then type
their own answer. The result gives the chosen option word for word.

If the user closes the list without choosing, ask in plain text or continue
with an assumption that you state. In sessions without an interactive user
the tool fails at once: decide yourself and say what you decided.`;

export const ASK_USER_CHOICE_PROMPT_SNIPPET = "Ask the user to pick one of a few known answers";

export const ASK_USER_CHOICE_PROMPT_GUIDELINES = [
  "Use ask_user_choice only when a decision needs the user and the possible answers are known in advance; settle everything else yourself.",
] as const;

export interface AskUserChoiceDetails {
  question: string;
  options: string[];
  /** The chosen option verbatim, or the typed answer when `other` is set. */
  choice?: string;
  /** Zero-based index of the chosen option. */
  index?: number;
  /** The user typed an answer of their own. */
  other?: boolean;
  /** The user closed the dialog without answering. */
  dismissed?: boolean;
  /** The call was aborted while the dialog was open. */
  cancelled?: boolean;
  /** Nobody could be asked: the session has no UI. */
  noUI?: boolean;
}

export interface AskUserChoiceErrorDetails {
  error: string;
}

interface AskUserChoiceInput {
  question: string;
  options: string[];
  allowOther: boolean;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set(["question", "options", "allow_other"]);

/**
 * Validate the call's arguments. Pi checks the TypeBox schema first; this also
 * covers what the schema cannot say (one line, unique after trimming) and
 * hosts that skip schema validation. Returns the problem as a message.
 */
/** Line breaks and every other C0 or DEL control character: the dialog prints the text as is, so none may reach the terminal. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function validateAskUserChoiceParams(params: unknown): AskUserChoiceInput | string {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return "params must be an object";
  for (const key of Object.keys(params)) {
    if (!ALLOWED_KEYS.has(key)) return `unknown parameter "${key}" (allowed: question, options, allow_other)`;
  }
  const { question, options, allow_other: allowOther = false } = params as Record<string, unknown>;
  if (typeof question !== "string" || question.trim() === "") return "question must be a non-empty string";
  const questionLength = [...question].length;
  if (questionLength > QUESTION_MAX) return `question must be at most ${QUESTION_MAX} characters (got ${questionLength})`;
  if (CONTROL_CHARACTERS.test(question)) return "question must be a single line without control characters";
  if (!Array.isArray(options) || options.length < OPTIONS_MIN || options.length > OPTIONS_MAX) {
    const got = Array.isArray(options) ? ` (got ${options.length})` : "";
    return `options must be an array of ${OPTIONS_MIN} to ${OPTIONS_MAX} strings${got}`;
  }
  if (typeof allowOther !== "boolean") return "allow_other must be a boolean";
  const seen = new Map<string, number>();
  for (const [index, option] of options.entries()) {
    if (typeof option !== "string" || option.trim() === "") return `options[${index}] must be a non-empty string`;
    const optionLength = [...option].length;
    if (optionLength > OPTION_MAX) return `options[${index}] must be at most ${OPTION_MAX} characters (got ${optionLength})`;
    if (CONTROL_CHARACTERS.test(option)) return `options[${index}] must be a single line without control characters`;
    const key = option.trim();
    const first = seen.get(key);
    if (first !== undefined) return `options[${index}] repeats options[${first}] ("${key}")`;
    if (allowOther && key === ASK_USER_CHOICE_OTHER_ROW) return `options[${index}] is the label of the typed-answer row; word it differently`;
    seen.set(key, index);
  }
  return { question, options: options as string[], allowOther };
}

type AskUserChoiceResult = {
  content: { type: "text"; text: string }[];
  details: AskUserChoiceDetails | AskUserChoiceErrorDetails;
  isError?: boolean;
};

function result(text: string, details: AskUserChoiceDetails | AskUserChoiceErrorDetails, isError = false): AskUserChoiceResult {
  return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) };
}

export function createAskUserChoiceTool(): ToolDefinition<typeof ASK_USER_CHOICE_PARAMS> {
  return {
    name: ASK_USER_CHOICE_TOOL_NAME,
    label: ASK_USER_CHOICE_TOOL_NAME,
    description: ASK_USER_CHOICE_DESCRIPTION,
    promptSnippet: ASK_USER_CHOICE_PROMPT_SNIPPET,
    promptGuidelines: [...ASK_USER_CHOICE_PROMPT_GUIDELINES],
    parameters: ASK_USER_CHOICE_PARAMS,
    // One dialog at a time: a second question in the same turn waits for the first.
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = validateAskUserChoiceParams(params);
      if (typeof input === "string") {
        return result(`ask_user_choice rejected: ${input}`, { error: input }, true);
      }
      const { question, options, allowOther } = input;
      const base: AskUserChoiceDetails = { question, options };
      if (!ctx.hasUI) {
        return result(
          "No one can answer: this session has no interactive user. Decide yourself and say which answer you chose and why.",
          { ...base, noUI: true },
          true,
        );
      }
      const cancelled = () => result("The question was cancelled.", { ...base, cancelled: true }, true);
      const dismissed = () =>
        result(
          "The user closed the question without choosing. Ask in plain text, or continue with an assumption and say what you assumed.",
          { ...base, dismissed: true },
        );
      if (signal?.aborted) return cancelled();

      const rows = allowOther ? [...options, ASK_USER_CHOICE_OTHER_ROW] : options;
      const picked = await ctx.ui.select(question, rows, { signal });
      if (signal?.aborted) return cancelled();
      if (picked === undefined) return dismissed();

      if (allowOther && picked === ASK_USER_CHOICE_OTHER_ROW) {
        const typed = await ctx.ui.input(question, "Your answer", { signal });
        if (signal?.aborted) return cancelled();
        if (typed === undefined || typed.trim() === "") return dismissed();
        return result(`The user answered in their own words: ${typed}`, { ...base, choice: typed, other: true });
      }
      const index = options.indexOf(picked);
      if (index < 0) return dismissed();
      return result(`The user chose: ${picked}`, { ...base, choice: picked, index });
    },
  } satisfies ToolDefinition<typeof ASK_USER_CHOICE_PARAMS>;
}

/** Mark `ask_user_choice` as ampi-owned (free mode drops it) and register it. */
export function registerAskUserChoiceTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  registerAmpiOwnedTool(ASK_USER_CHOICE_TOOL_NAME);
  pi.registerTool(createAskUserChoiceTool());
}
