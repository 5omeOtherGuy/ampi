// What execute mode prints when it runs Pi's JSON mode: stream JSON records
// (`--stream-json`), one summary line (`--stats`) or the result of one tool
// (`--output-tool`). Each output reads Pi's events through the stream JSON
// encoder, which keeps the run's result, turns and usage. Pure: the caller
// writes what they return.

/**
 * @typedef {object} RunOutputEnd
 * @property {string} stdout Text for stdout after the run; may be empty.
 * @property {string} stderr Text for stderr after the run; may be empty.
 * @property {number} exitCode
 *
 * @typedef {object} RunOutput
 * @property {(event: any) => string} push Text for stdout for one Pi JSON event, written right away; may be empty.
 * @property {(failure?: string) => RunOutputEnd} finish What ends the run; `failure` reports a run that
 *   failed outside the model's answer.
 */

/**
 * The result record that ends a run: `finish` of the encoder always returns it last.
 *
 * @param {import("./stream-json.js").StreamJsonEncoder} encoder
 * @param {string | undefined} failure
 */
const finishRun = (encoder, failure) => {
  const { records, exitCode } = encoder.finish(failure);
  return { result: /** @type {import("./stream-json.js").StreamJsonRecord} */ (records.at(-1)), exitCode };
};

/** @param {import("./stream-json.js").StreamJsonRecord[]} records */
const jsonLines = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

/**
 * Every stream JSON record, written as soon as Pi reports what it describes.
 *
 * @param {import("./stream-json.js").StreamJsonEncoder} encoder
 * @returns {RunOutput}
 */
export function createStreamJsonOutput(encoder) {
  return {
    push: (event) => jsonLines(encoder.push(event)),
    finish(failure) {
      const { records, exitCode } = encoder.finish(failure);
      return { stdout: jsonLines(records), stderr: "", exitCode };
    },
  };
}

/**
 * One JSON line when the run ends: the fields of the stream JSON result record,
 * plus `total_cost_usd`, the sum of the cost Pi computed for each model
 * response. Pi reports 0 for a model without a known price, so a run in which
 * no response has a cost above 0 has no `total_cost_usd` rather than a cost of 0.
 *
 * @param {import("./stream-json.js").StreamJsonEncoder} encoder
 * @returns {RunOutput}
 */
export function createStatsOutput(encoder) {
  /** @type {number | undefined} */
  let cost;
  return {
    push(event) {
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const total = event.message.usage?.cost?.total;
        if (typeof total === "number" && total > 0) cost = (cost ?? 0) + total;
      }
      encoder.push(event);
      return "";
    },
    finish(failure) {
      const { result, exitCode } = finishRun(encoder, failure);
      return { stdout: jsonLines([cost === undefined ? result : { ...result, total_cost_usd: cost }]), stderr: "", exitCode };
    },
  };
}

/**
 * The text of the last finished call to the tool named `toolName`: its text
 * blocks joined by newlines, ending with a newline. Images are left out, with
 * a note on stderr. Exit code 1 when that call failed (its text is still
 * printed), when no call to the tool finished (nothing is printed), or when
 * the run failed (the error goes to stderr).
 *
 * @param {string} toolName
 * @param {import("./stream-json.js").StreamJsonEncoder} encoder
 * @returns {RunOutput}
 */
export function createToolOutput(toolName, encoder) {
  /** @type {any} Pi's `tool_execution_end` event of the last call. */
  let last;
  return {
    push(event) {
      if (event.type === "tool_execution_end" && event.toolName === toolName) last = event;
      encoder.push(event);
      return "";
    },
    finish(failure) {
      const { result } = finishRun(encoder, failure);
      let stderr = result.is_error ? `ampi: ${result.error}\n` : "";
      if (last === undefined) {
        stderr += `ampi: no call to the tool ${toolName} finished, so there is no output to print.\n`;
        return { stdout: "", stderr, exitCode: 1 };
      }
      /** @type {any[]} */
      const content = Array.isArray(last.result?.content) ? last.result.content : [];
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const images = content.filter((block) => block.type === "image").length;
      if (images > 0) stderr += `ampi: left out ${images === 1 ? "an image" : `${images} images`} of the ${toolName} result; only its text is printed.\n`;
      return {
        stdout: text === "" || text.endsWith("\n") ? text : `${text}\n`,
        stderr,
        exitCode: result.is_error || last.isError === true ? 1 : 0,
      };
    },
  };
}
