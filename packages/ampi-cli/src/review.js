// `ampi review`: run the reviewer pipeline once on a diff, print its report
// (or the JSON document), record the review as a thread and exit with a
// status a script can act on. Pi runs in print mode as a child process with
// the message `/ampi-review-run`, which ampi-workers registers
// (src/extensions/ampi-workers/builtin-workers/review-run.ts): the command
// reads the request file and writes the outcome file this module passes it,
// so no model turn of the session is needed. The child is the ampi command
// itself, so it loads ampi as execute mode decides, and so do the reviewer
// children it starts (they run the same executable again).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createPiSessionWriter, piAgentDir } from "./pi-compat.js";
import { threadIndexPath, updateThreadRecord, validateThreadLabels } from "./thread-index.js";

/**
 * @typedef {object} ReviewPiRun What a Pi run left behind.
 * @property {number | null} status Its exit status; null when it was stopped by a signal or did not start.
 * @property {string} stderr Everything it wrote to stderr.
 * @property {Error} [error] Why it could not start.
 *
 * @typedef {(args: string[], options: { cwd: string, env: NodeJS.ProcessEnv, forward: (text: string) => void }) => Promise<ReviewPiRun>} ReviewPiRunner
 *   Runs Pi with ampi loaded (the ampi command with `args`), with stdin closed. Whatever it writes to
 *   stdout or stderr is passed to `forward` as it comes.
 *
 * @typedef {object} ReviewHost
 * @property {any} pi The `@earendil-works/pi-coding-agent` module, for the session and the thread index.
 * @property {string} cwd The directory to review in.
 * @property {NodeJS.ProcessEnv} env
 * @property {ReviewPiRunner} runPi
 * @property {() => string} makeTempDir Creates a new private temporary directory and returns its path.
 * @property {() => number} now Milliseconds since the epoch, for the thread's message and archive date.
 * @property {() => Promise<{ root: string, version?: string } | undefined>} locateAmpi The ampi package
 *   Pi loads, else the CLI's own.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {(text: string) => void} err Writes Pi's own output to stderr.
 * @property {import("./log.js").Logger} log For the command's diagnostics.
 *
 * @typedef {object} ReviewRequest The request file `/ampi-review-run` reads (version 1).
 * @property {1} version
 * @property {{ diff_description: string, files?: string[], instructions?: string, checks_only?: boolean,
 *   check_filter?: string[], check_scope?: string }} params The reviewer's parameters.
 * @property {"low" | "high"} thinking The reviewer children's thinking level.
 *
 * @typedef {object} ReviewDocument The JSON document `--json` prints.
 * @property {string} diff
 * @property {string} summary
 * @property {object[]} findings
 * @property {object[]} checks
 * @property {string} report
 *
 * @typedef {{ ok: true, result: ReviewDocument, mainReviewFailure?: string } | { ok: false, error: string }} ReviewOutcome
 *   The output file `/ampi-review-run` writes.
 */

const USAGE_HINT = "Run ampi review --help for the options.";

/** The description the reviewer gets when none is given; the reviewer reads it as the uncommitted changes. */
export const REVIEW_DEFAULT_DESCRIPTION = "uncommitted changes";

/** The extension message type the review is recorded under in its thread. */
export const REVIEW_ENTRY_TYPE = "ampi-review";

const THINKING_LEVELS = ["low", "high"];

/** The flag ampi-workers registers for the request file; an ampi without it is too old for review. */
const REQUEST_FLAG = "ampi-review-request";
/** The file that holds `/ampi-review-run` in an ampi that has it. */
const REVIEW_RUN_ENTRY = path.join("src", "extensions", "ampi-workers", "builtin-workers", "review-run.ts");

const OPTIONS = /** @type {const} */ ({
  files: { type: "string", short: "f", multiple: true },
  instructions: { type: "string", short: "i" },
  "check-scope": { type: "string", short: "s" },
  "check-filter": { type: "string", short: "c", multiple: true },
  "checks-only": { type: "boolean" },
  json: { type: "boolean" },
  thinking: { type: "string" },
  "no-archive-after-execute": { type: "boolean" },
  title: { type: "string" },
  label: { type: "string", short: "l", multiple: true },
  help: { type: "boolean", short: "h" },
});

/**
 * The text `ampi review --help` prints.
 *
 * @returns {string}
 */
export function formatReviewHelp() {
  return `ampi review: review a diff once with ampi's reviewer, from the shell

Usage: ampi review [options] [description...]

The words of the description say which changes to review, as you would ask for them, for
example "the changes on this branch" or "the last commit". Without one, the uncommitted
changes are reviewed. The reviewer works out the diff itself (nothing is read from stdin), and
every review check under .agents/checks/ whose directory holds a changed file runs as its own
reviewer.

Options:

  -f, --files <file>            Focus the review on this file; repeat for several
  -i, --instructions <text>     More instructions for the reviewer, such as what to focus on
  -s, --check-scope <dir>       Run only the checks defined in this directory (relative to the
                                working directory) or below it
  -c, --check-filter <name>     Run only this check; repeat for several. An unknown name fails
                                the review with the list of checks
  --checks-only                 Run only the checks, without the main review
  --json                        Print the JSON document instead of the report
  --thinking low|high           The reviewer's thinking level for this review (default low,
                                below the reviewer's usual medium); it replaces the level in
                                ampiCore.subagentModelPreferences.reviewer
  --title <title>               Name the review's thread
  -l, --label <label>           Add a label to the thread; repeat for several
  --no-archive-after-execute    Keep the thread out of the archive (it is archived by default)
  -h, --help                    Print this help and exit

Output: the report on stdout: the main review, then a "## Checks" section with one heading
per check and its report. With --json, one JSON document instead, with the keys diff, summary,
findings (file, startLine, endLine, severity, type, text and the check it came from), checks
(name, path, scope, status, findings, error) and report; the CLI README describes it. A check's
status is no-issues (no finding was counted, not a pass), findings or failed. Nothing else goes
to stdout. Each review is recorded as a thread that ampi threads lists and prints.

The reviewer needs a model route: ampiCore.subagentModelPreferences.reviewer in the settings
(/ampi-config sets it), else a model for the reviewer's default route. Only the reviewer's
own runs call a model.

Exit status: 0 when the review ran, with or without findings; 1 when it failed (every run
failed, an unknown check name, --checks-only without a check that applies, or Pi stopped
first); 2 on a usage error.

Examples:

  $ ampi review
  $ ampi review the changes on this branch since main -f src/parser.ts
  $ ampi review --json | jq -r '.findings[] | "\\(.file):\\(.startLine) \\(.severity // "-") \\(.text)"'
  $ ampi review --checks-only -c naming -l ci
`;
}

/**
 * Read `ampi review`'s command line into the request and the thread options.
 *
 * @param {readonly string[]} argv
 * @returns {{ help: true } | { error: string } | { request: ReviewRequest, json: boolean, title?: string, labels: string[], archive: boolean }}
 */
export function parseReviewArgs(argv) {
  /** @type {any} */
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const thinking = values.thinking ?? "low";
  if (!THINKING_LEVELS.includes(thinking)) return { error: `--thinking takes low or high, not "${thinking}".` };
  if (values.title !== undefined && values.title.trim() === "") return { error: "--title needs a value." };
  /** @type {string[]} */
  let labels;
  try {
    labels = validateThreadLabels(values.label ?? []);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const description = positionals.join(" ").trim();
  /** @type {ReviewRequest["params"]} */
  const params = { diff_description: description === "" ? REVIEW_DEFAULT_DESCRIPTION : description };
  if (values.files !== undefined) params.files = values.files;
  if (values.instructions !== undefined) params.instructions = values.instructions;
  if (values["checks-only"]) params.checks_only = true;
  if (values["check-filter"] !== undefined) params.check_filter = values["check-filter"];
  if (values["check-scope"] !== undefined) params.check_scope = values["check-scope"];
  return {
    request: { version: 1, params, thinking: /** @type {"low" | "high"} */ (thinking) },
    json: values.json === true,
    ...(values.title !== undefined ? { title: values.title } : {}),
    labels,
    archive: values["no-archive-after-execute"] !== true,
  };
}

/**
 * The thread's user message: what was asked for, one line per option given.
 *
 * @param {ReviewRequest} request
 * @returns {string}
 */
export function formatReviewRequest({ params, thinking }) {
  const lines = [`ampi review: ${params.diff_description}`];
  if (params.files !== undefined) lines.push(`Files: ${params.files.join(", ")}`);
  if (params.instructions !== undefined) lines.push(`Instructions: ${params.instructions}`);
  if (params.check_scope !== undefined) lines.push(`Check scope: ${params.check_scope}`);
  if (params.check_filter !== undefined) lines.push(`Checks: ${params.check_filter.join(", ")}`);
  if (params.checks_only) lines.push("Checks only, without the main review");
  lines.push(`Thinking: ${thinking}`);
  return lines.join("\n");
}

/** @param {unknown} value @returns {value is ReviewOutcome} */
const isOutcome = (value) =>
  typeof value === "object" &&
  value !== null &&
  ((/** @type {any} */ (value).ok === true && typeof (/** @type {any} */ (value).result?.report) === "string") ||
    (/** @type {any} */ (value).ok === false && typeof (/** @type {any} */ (value).error) === "string"));

/** Pi's message for an extension flag no loaded extension registered, naming the request flag. */
const UNKNOWN_REQUEST_FLAG = new RegExp(`Unknown options?: [^\\n]*--${REQUEST_FLAG}\\b`);

/**
 * Run `ampi review`.
 *
 * @param {readonly string[]} argv The command line after `review`.
 * @param {ReviewHost} host
 * @returns {Promise<number>} The exit code.
 */
export async function runReviewCommand(argv, host) {
  const parsed = parseReviewArgs(argv);
  if ("help" in parsed) {
    host.out(formatReviewHelp());
    return 0;
  }
  if ("error" in parsed) {
    host.log.error(`review: ${parsed.error}\n${USAGE_HINT}`);
    return 2;
  }
  const dir = host.makeTempDir();
  /** @type {ReviewPiRun} */
  let run;
  /** @type {unknown} */
  let outcome;
  try {
    const requestFile = path.join(dir, "request.json");
    const outputFile = path.join(dir, "output.json");
    writeFileSync(requestFile, `${JSON.stringify(parsed.request)}\n`, { mode: 0o600 });
    const args = ["--no-session", "-p", `--${REQUEST_FLAG}=${requestFile}`, `--ampi-review-output=${outputFile}`, "/ampi-review-run"];
    run = await host.runPi(args, { cwd: host.cwd, env: host.env, forward: host.err });
    if (existsSync(outputFile)) {
      try {
        outcome = JSON.parse(readFileSync(outputFile, "utf8"));
      } catch (error) {
        outcome = { ok: false, error: `the review's output could not be read: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (run.error !== undefined) {
    host.log.error(`review failed: could not start Pi: ${run.error.message}`);
    return 1;
  }
  if (outcome === undefined) {
    if (UNKNOWN_REQUEST_FLAG.test(run.stderr.replace(/\x1b\[[0-9;]*m/g, ""))) {
      host.log.error(await tooOldMessage(host));
      return 1;
    }
    const how = run.status === null ? "was stopped" : `exited with status ${run.status}`;
    const see = run.stderr.trim() === "" ? "" : "; see Pi's message above";
    host.log.error(`review failed: Pi ${how} before the review ran${see}.`);
    return 1;
  }
  if (!isOutcome(outcome)) {
    host.log.error("review failed: the review's output is not in the format this ampi command reads; update ampi and ampi-cli together.");
    return 1;
  }
  if (!outcome.ok) {
    host.log.error(`review failed: ${outcome.error}`);
    return 1;
  }
  const document = outcome.result;
  host.out(parsed.json ? `${JSON.stringify(document, null, 2)}\n` : document.report);
  if (outcome.mainReviewFailure !== undefined) host.log.warn(`the main review failed (${outcome.mainReviewFailure}); the report holds the checks' results.`);
  try {
    recordThread(host, parsed, document);
  } catch (error) {
    host.log.warn(`the review was not recorded as a thread: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

/**
 * Why Pi did not know the request flag: the ampi it loads predates review,
 * or it leaves ampi-workers out.
 *
 * @param {ReviewHost} host
 * @returns {Promise<string>}
 */
async function tooOldMessage(host) {
  const ampi = await host.locateAmpi();
  if (ampi !== undefined && existsSync(path.join(ampi.root, REVIEW_RUN_ENTRY))) {
    return "review failed: review needs ampi-workers, which the ampi that Pi loads does not run; check the ampi entry in Pi's settings.";
  }
  const which = ampi?.version === undefined ? "the ampi package" : `ampi ${ampi.version}`;
  return `${which} is too old for review; update @skippermissions/ampi (or ampi-cli).`;
}

/**
 * Write the review as a new session of the working directory: the request
 * as the user's message, the name (`--title`, else `Review: <diff>`), then
 * the report as an `ampi-review` extension message with the document as its
 * details. Then the title source, labels and archive date go to ampi's
 * thread index, as execute mode stores them.
 *
 * @param {ReviewHost} host
 * @param {{ request: ReviewRequest, title?: string, labels: string[], archive: boolean }} options
 * @param {ReviewDocument} document
 */
function recordThread(host, { request, title, labels, archive }, document) {
  const writer = createPiSessionWriter(host.pi, { cwd: host.cwd, env: host.env });
  writer.appendMessage({ role: "user", content: formatReviewRequest(request), timestamp: host.now() });
  // Without --title the thread is named after the diff: Pi would otherwise name it by the whole request.
  writer.appendSessionInfo(title ?? `Review: ${request.params.diff_description}`);
  writer.appendCustomMessageEntry(REVIEW_ENTRY_TYPE, document.report, true, document);
  /** @type {import("./thread-index.js").ThreadRecord} */
  const patch = {};
  if (labels.length > 0) patch.labels = labels;
  if (title !== undefined) patch.titleSource = "user";
  if (archive) patch.archived = new Date(host.now()).toISOString();
  if (Object.keys(patch).length > 0) updateThreadRecord(threadIndexPath(piAgentDir(host.pi)), writer.getSessionId(), patch);
}
