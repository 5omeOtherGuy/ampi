// What every agent's converter for `ampi threads import` shares: the shapes
// they produce and the Pi usage of an imported assistant message.

/**
 * @typedef {object} SourceSession A conversation of another agent and when it last changed.
 * @property {string} id The agent's id for it.
 * @property {string} file The file it is read from.
 * @property {Date} modified
 * @property {boolean} [subagent] A helper agent's conversation, which `--all` leaves out.
 *
 * @typedef {object} Conversion A conversation converted into Pi messages.
 * @property {string | undefined} cwd The working directory it ran in.
 * @property {string | undefined} title The title the agent recorded.
 * @property {number | undefined} started The first message's time, in milliseconds.
 * @property {{ role: string }[]} messages Pi user, assistant and tool result messages, in order.
 */

/** The `api` of imported assistant messages. */
export const IMPORT_API = "imported";

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value A token count, or 0 when it is not one. */
export const tokenCount = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Pi's usage from token counts. Pi's usage always holds a cost; it is left
 * at zero here, which ampi's reports read as unknown, because the providers
 * of imported messages have no price.
 *
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} [counts]
 */
export function importedUsage({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * A user message's content: a string when it is only text, else the blocks.
 *
 * @param {object[]} parts Pi text and image blocks.
 */
export function userContent(parts) {
  const textOnly = parts.every((/** @type {any} */ part) => part.type === "text");
  return textOnly ? parts.map((/** @type {any} */ part) => part.text).join("\n\n") : parts;
}
