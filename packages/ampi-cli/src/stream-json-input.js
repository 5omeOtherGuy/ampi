// Stream JSON input (`ampi -x --stream-json --stream-json-input`): user
// messages read from stdin, one JSON object per line, sent to Pi's RPC mode as
// prompts while the stream JSON records of every run go to stdout. Pure: the
// line parser returns values, and the driver talks to Pi and stdout only
// through the callbacks it is given.

/** The most images one input line may carry. */
export const MAX_IMAGES_PER_LINE = 10;

/** The image types an input line may declare, each with a test of the decoded bytes. */
const IMAGE_TYPES = /** @type {Record<string, { name: string, matches: (bytes: Buffer) => boolean }>} */ ({
  "image/png": { name: "PNG", matches: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { name: "JPEG", matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  "image/gif": { name: "GIF", matches: (bytes) => ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1")) },
  "image/webp": { name: "WebP", matches: (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" },
});

/** Base64 with optional padding: Node's decoder skips other characters instead of failing. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The dialogs extensions can open through Pi's RPC mode; each waits for an answer. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Ids of the prompts the driver sends, so it can tell their responses apart. */
const PROMPT_ID_PREFIX = "ampi-input-";

/**
 * @typedef {{ type: "image", data: string, mimeType: string }} PiImageContent
 *
 * @typedef {object} StreamJsonInputMessage One user message read from stdin.
 * @property {string} text The text blocks, joined with newlines.
 * @property {PiImageContent[]} images
 * @property {boolean} steer Deliver it to the run in progress before the model's next request.
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The image an image block carries, or the problem with it.
 *
 * @param {Record<string, any>} block
 * @returns {PiImageContent | string}
 */
function imageOf(block) {
  const source = block.source;
  if (!isObject(source) || source.type !== "base64") return 'an image needs "source" with "type": "base64"';
  const declared = IMAGE_TYPES[source.media_type];
  if (declared === undefined) return '"media_type" must be image/png, image/jpeg, image/gif or image/webp';
  if (typeof source.data !== "string" || !BASE64.test(source.data)) return '"data" must be base64';
  if (block.source_path !== undefined && typeof block.source_path !== "string") return '"source_path" must be a string';
  const bytes = Buffer.from(source.data, "base64");
  if (!declared.matches(bytes)) {
    const actual = Object.values(IMAGE_TYPES).find((type) => type.matches(bytes));
    return `the image is declared as ${source.media_type} but its data is ${actual === undefined ? "not a PNG, JPEG, GIF or WebP image" : `a ${actual.name} image`}`;
  }
  return { type: "image", data: source.data, mimeType: source.media_type };
}

/**
 * Read one input line: `{"type": "user", "steer"?: boolean, "message": {"role":
 * "user", "content": string | blocks}}`, where a block is `{"type": "text",
 * "text"}` or `{"type": "image", "source": {"type": "base64", "media_type",
 * "data"}, "source_path"?}`. Other fields are ignored.
 *
 * @param {string} line
 * @param {number} lineNumber Counted from 1, for the error.
 * @returns {StreamJsonInputMessage | { error: string }}
 */
export function parseStreamJsonInputLine(line, lineNumber) {
  /** @param {string} problem */
  const invalid = (problem) => ({ error: `stdin line ${lineNumber}: ${problem}` });
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return invalid("not valid JSON");
  }
  if (!isObject(value)) return invalid("expected a JSON object");
  if (value.type !== "user") return invalid('"type" must be "user"');
  if (value.steer !== undefined && typeof value.steer !== "boolean") return invalid('"steer" must be true or false');
  const message = value.message;
  if (!isObject(message)) return invalid('"message" must be an object');
  if (message.role !== "user") return invalid('"message.role" must be "user"');
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (!Array.isArray(content)) return invalid('"message.content" must be a string or an array of content blocks');

  /** @type {string[]} */
  const texts = [];
  /** @type {PiImageContent[]} */
  const images = [];
  for (const [index, block] of content.entries()) {
    const where = `content block ${index + 1}`;
    if (isObject(block) && block.type === "text") {
      if (typeof block.text !== "string") return invalid(`${where}: "text" must be a string`);
      texts.push(block.text);
    } else if (isObject(block) && block.type === "image") {
      if (images.length === MAX_IMAGES_PER_LINE) return invalid(`more than ${MAX_IMAGES_PER_LINE} images`);
      const image = imageOf(block);
      if (typeof image === "string") return invalid(`${where}: ${image}`);
      images.push(image);
    } else {
      return invalid(`${where}: "type" must be "text" or "image"`);
    }
  }
  const text = texts.join("\n");
  if (text.trim() === "" && images.length === 0) return invalid("the message has no text and no images");
  return { text, images, steer: value.steer === true };
}

/**
 * @typedef {object} StreamJsonInputHost
 * @property {(command: Record<string, unknown>) => void} send Write one command to Pi's RPC input.
 * @property {(records: import("./stream-json.js").StreamJsonRecord[]) => void} write Write records to stdout.
 * @property {(text: string) => void} warn Write a line to stderr.
 * @property {() => void} end End Pi's RPC input, which shuts the session down; called once.
 *
 * @typedef {object} StreamJsonInputDriver
 * @property {(line: string) => void} line One stdin line, without its line break.
 * @property {() => void} end Stdin reached its end.
 * @property {(record: any) => void} receive One record of Pi's RPC output.
 * @property {0 | 1} exitCode 1 once a run failed or a line was invalid.
 * @property {boolean} ended The driver ended Pi's input: every message was handled.
 */

/**
 * Drive Pi's RPC mode from stdin lines. Every message becomes a `prompt`
 * command: Pi starts a run with it when none is in progress, and otherwise
 * queues it into the current run, as a steering message when the line says
 * `"steer": true` and as a follow-up when not. Pi decides which, so a line
 * that arrives just as a run settles still starts the next one. One prompt is
 * in flight at a time, so lines keep their order.
 *
 * Each settled run ends with its result record. Dialogs that extensions open
 * are cancelled at once, because the run has no one to answer them. An invalid
 * line stops reading: once the current run settles, an error result names the
 * line. Pi's input ends when stdin has ended (or a line was invalid), every
 * message was sent and no run is in progress. Pi also starts runs without a
 * prompt, for example when a background task finishes; its events show them,
 * so they get a result too and Pi's input waits for them.
 *
 * @param {import("./stream-json.js").StreamJsonEncoder} encoder
 * @param {StreamJsonInputHost} host
 * @returns {StreamJsonInputDriver}
 */
export function createStreamJsonInputDriver(encoder, host) {
  /** @type {StreamJsonInputMessage[]} */
  const queue = [];
  let lines = 0;
  let prompts = 0;
  /** A prompt was sent and its response has not arrived. */
  let awaitingResponse = false;
  /** A run is in progress: from its prompt's response or its agent_start until its agent_settled. */
  let running = false;
  /** Stdin ended, or an invalid line stopped reading it. */
  let inputDone = false;
  /** @type {string | undefined} */
  let invalidLine;
  /** @type {string | undefined} */
  let runFailure;
  let failed = false;
  let ended = false;

  /** @param {string | undefined} failure */
  const finishRun = (failure) => {
    const { records, exitCode } = encoder.finish(failure);
    if (exitCode !== 0) failed = true;
    host.write(records);
  };

  const advance = () => {
    if (awaitingResponse || ended) return;
    const message = queue.shift();
    if (message !== undefined) {
      awaitingResponse = true;
      host.send({
        id: `${PROMPT_ID_PREFIX}${++prompts}`,
        type: "prompt",
        message: message.text,
        ...(message.images.length > 0 ? { images: message.images } : {}),
        streamingBehavior: message.steer ? "steer" : "followUp",
      });
      return;
    }
    if (!inputDone || running) return;
    if (invalidLine !== undefined) finishRun(invalidLine);
    ended = true;
    host.end();
  };

  return {
    line(text) {
      if (inputDone) return;
      lines++;
      if (text.trim() === "") return;
      const parsed = parseStreamJsonInputLine(text, lines);
      if ("error" in parsed) {
        invalidLine = parsed.error;
        inputDone = true;
      } else {
        queue.push(parsed);
      }
      advance();
    },

    end() {
      inputDone = true;
      advance();
    },

    receive(record) {
      switch (record?.type) {
        case "response":
          if (typeof record.id !== "string" || !record.id.startsWith(PROMPT_ID_PREFIX)) return;
          awaitingResponse = false;
          if (record.success !== true) {
            const error = typeof record.error === "string" ? record.error : "Pi did not accept the message.";
            // A rejected prompt starts no run; a rejected steering message fails the run it was meant for.
            if (running) runFailure ??= error;
            else finishRun(error);
          } else if (record.data?.disposition === "started") {
            running = true;
          }
          advance();
          return;
        case "extension_ui_request":
          if (DIALOG_METHODS.has(record.method)) host.send({ type: "extension_ui_response", id: record.id, cancelled: true });
          return;
        case "extension_error":
          host.warn(`ampi: extension error (${record.extensionPath}, ${record.event}): ${record.error}`);
          return;
      }
      if (record?.type === "agent_start") running = true;
      host.write(encoder.push(record));
      if (record?.type === "agent_settled") {
        running = false;
        finishRun(runFailure);
        runFailure = undefined;
        advance();
      }
    },

    get exitCode() {
      return failed ? 1 : 0;
    },

    get ended() {
      return ended;
    },
  };
}
