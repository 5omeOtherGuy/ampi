// `ampi permissions list|test|edit|add`: the rules of ampi-permissions
// (`ampi.permissions` in Pi's settings files) as one-line text, what a
// session here decides for a tool call, and changing the rules from the
// command line. The rule engine is ampi's TypeScript, loaded through Pi
// (see src/permissions-cli.ts in the ampi package).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { isPiProjectTrusted, loadThroughPi, piSettingsPath } from "./pi-compat.js";

/**
 * @typedef {object} PermissionsHost
 * @property {any} pi The `@earendil-works/pi-coding-agent` module.
 * @property {string} cwd
 * @property {() => Promise<{ root: string, version?: string } | undefined>} locateAmpi The ampi package whose
 *   rule engine the command uses: the one Pi loads from its settings, else the CLI's own.
 * @property {(text: string) => void} out Writes to stdout.
 * @property {import("./log.js").Logger} log For the command's diagnostics.
 * @property {boolean} stdinIsTTY Whether `edit` opens the editor (a terminal) or reads the rules from stdin.
 * @property {() => Promise<string>} readStdin All of stdin.
 * @property {(file: string) => Promise<string | undefined>} editFile Open a file in Pi's external editor;
 *   returns what went wrong, or undefined when the editor exited with status 0.
 * @property {string} [tempDir] Where `edit` puts the file it opens; the system's temp directory unless given.
 *
 * @typedef {{ tool: string, matches?: Record<string, unknown>, action: "allow" | "reject" | "ask" | "delegate",
 *   context?: string, to?: string, message?: string }} PermissionRule
 *
 * @typedef {{ action: string, rule?: PermissionRule, source?: string, command?: string, reason?: string,
 *   parts?: RuleDecision[] }} RuleDecision
 *
 * @typedef {{ category: { key: string, description: string }, path: string }} GuardedFile
 *
 * @typedef {{ action: string, source: string, rules?: RuleDecision, guarded: GuardedFile[] }} CallDecision
 *
 * @typedef {{ present: false } | { present: true, value: unknown }} StoredSetting
 *
 * @typedef {{ enabled: boolean, allowAll: boolean, failClosed?: string, projectRules: PermissionRule[],
 *   userRules: PermissionRule[], guardedFilesAllowlist: string[], warnings: string[] }} PermissionsSettings
 *
 * @typedef {object} PermissionsCli What src/permissions-cli.ts hands over (`MMR_PERMISSIONS_CLI` there).
 * @property {(rule: PermissionRule) => string} formatRule
 * @property {(rule: PermissionRule) => string | undefined} ruleTextProblem
 * @property {(text: string) => { rules: PermissionRule[], problems: string[] }} parseRulesText
 * @property {(args: readonly string[], flags: Record<string, string>) => { rule?: PermissionRule, problems: string[], flags: ReadonlySet<string> }} parseRuleArgs
 * @property {(args: readonly string[], flags: Record<string, string>) => { toolName?: string, input: Record<string, unknown>,
 *   context?: "thread" | "subagent", problems: string[], flags: ReadonlySet<string> }} parseCallArgs
 * @property {(value: unknown) => string[]} validateRule
 * @property {readonly PermissionRule[]} defaultRules
 * @property {(options: { userFile: string, projectFile?: string }) => PermissionsSettings} loadSettings
 * @property {(projectFile: string) => PermissionsSettings} loadWorkspaceSettings
 * @property {(call: { toolName: string, input: unknown }, settings: PermissionsSettings,
 *   options: { context?: string, guardedFiles?: { cwd?: string, agentDir?: string } }) => CallDecision} decide
 * @property {(file: string, options?: { noFollow?: boolean }) => StoredSetting} readSetting
 * @property {(file: string, update: (current: StoredSetting) => readonly unknown[] | undefined) => void} writeSetting
 */

/** The file in the ampi package whose extension factory hands over the rule engine, and the event it uses. */
const PERMISSIONS_ENTRY = path.join("src", "permissions-cli.ts");
const PERMISSIONS_EVENT = "ampi:permissions-cli";

/** The subcommands, and the other names they answer to. */
export const PERMISSIONS_COMMANDS = /** @type {const} */ (["list", "test", "edit", "add"]);
export const PERMISSIONS_ALIASES = /** @type {const} */ ({ ls: "list" });

/**
 * Each subcommand's own options. `list` and `edit` read theirs strictly;
 * `test` and `add` take any `--<field>` besides, and their `--context`, `--to`
 * and `--message` are read with the rule's words (see FLAGS).
 */
export const OPTIONS = /** @type {const} */ ({
  list: { json: { type: "boolean" }, builtin: { type: "boolean" }, workspace: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  test: {
    context: { type: "string" },
    workspace: { type: "boolean" },
    json: { type: "boolean" },
    quiet: { type: "boolean", short: "q" },
    help: { type: "boolean", short: "h" },
  },
  edit: { workspace: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  add: {
    context: { type: "string" },
    to: { type: "string" },
    message: { type: "string" },
    workspace: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

/**
 * The flags of a subcommand's options table, by spelling: each word that is
 * one of these, where an option value cannot stand, is the option it names.
 *
 * @param {Readonly<Record<string, { type: string, short?: string }>>} table
 * @returns {Record<string, string>}
 */
const flagsOf = (table) =>
  Object.fromEntries(
    Object.entries(table)
      .filter(([, spec]) => spec.type === "boolean")
      .flatMap(([name, spec]) => [[`--${name}`, name], ...(spec.short === undefined ? [] : [[`-${spec.short}`, name]])]),
  );

/** The flags of `test` and `add`, for the rule engine's word reader. */
const FLAGS = Object.freeze({ test: flagsOf(OPTIONS.test), add: flagsOf(OPTIONS.add) });

/** Exit codes of `test`: the decision, a usage error, or no decision at all. */
const TEST_EXIT = /** @type {const} */ ({ allow: 0, reject: 1, ask: 3, delegate: 3, usage: 2, undecided: 4 });

const TEXT_FORM = `The text form has one rule per line:

  <action> <tool> [--<field> <pattern>]... [--context thread|subagent] [--to <program>] [--message <text>]

  <action> is allow, reject, ask or delegate, and <tool> a glob over the tool name. Each
  --<field> <pattern> matches one input field: a glob (* any run of characters, ? one
  character), a /regex/flags, or a bare true, false, null or number, which match that value.
  --a.b names a nested field, and repeating a field matches any of its patterns. --context
  limits the rule to the main session (thread) or to subagents, --to is a delegate rule's
  program and its arguments, --message a reject rule's reason.

  Words split as in a shell: spaces separate them, single quotes keep everything literal, a
  backslash keeps the next character, and in double quotes \\n, \\t, \\r, \\\\ and \\" are escapes.
  Quoted, true or 42 is a string. Nothing else is special: no variables, globbing or
  operators. --field=value works too. A line starting with # is a comment.

  context, to and message are the rule's own options: an input field with one of those names
  can only be matched in the JSON settings (ampi config edit).`;

/**
 * The text `ampi permissions --help` prints.
 *
 * @returns {string}
 */
export function formatPermissionsHelp() {
  return `ampi permissions: list, test, edit and add the rules of ampi-permissions

Usage: ampi permissions list [--json] [--builtin | --workspace]
       ampi permissions test <tool> [--<field> <value>]... [--context thread|subagent] [--workspace]
                             [--json] [-q]
       ampi permissions edit [--workspace]
       ampi permissions add <action> <tool> [--<field> <pattern>]... [--context thread|subagent]
                            [--to <program>] [--message <text>] [--workspace]

Commands:

  list, ls                      Print the rules, one per line in the text form
  test                          Say what a session in this directory decides about a tool call,
                                without running anything
  edit                          Edit the rules as text in your editor, or from stdin
  add                           Put one new rule first, ahead of the older ones

The rules are ampi.permissions in Pi's user settings file (settings.json in Pi's configuration
directory), or with --workspace in this project's .pi/settings.json. ampi permissions <command>
--help has more on each command.

${TEXT_FORM}

Examples:

  $ ampi permissions list
  $ ampi permissions add ask bash --command 'git push*'
  $ ampi permissions test bash --command 'git push origin main'
  $ ampi permissions edit
`;
}

/** @returns {string} */
function formatListHelp() {
  return `ampi permissions list: print the rules of ampi-permissions

Usage: ampi permissions list [--json] [--builtin | --workspace]
       ampi permissions ls ...

Prints ampi.permissions from Pi's user settings file, one rule per line in the text form
(ampi permissions --help describes it), in the order sessions try them. A rule the text form
cannot write exactly is printed as a # comment holding its JSON. Invalid entries are skipped with
a warning. No rules print nothing.

Options:

  --workspace                   This project's .pi/settings.json instead. Sessions read it only
                                when Pi trusts the project, and only its reject and ask rules
  --builtin                     ampi's default rules, which come after every settings file's
  --json                        The JSON list as it is stored
  -h, --help                    Print this help

Exit status: 0 on success, 1 when the settings cannot be read, 2 on a usage error.

Examples:

  $ ampi permissions list
  $ ampi permissions list --builtin | grep git
  $ ampi permissions list --workspace --json
`;
}

/** @returns {string} */
function formatTestHelp() {
  return `ampi permissions test: say what a session here decides about a tool call

Usage: ampi permissions test <tool> [--<field> <value>]... [--context thread|subagent] [--workspace]
                             [--json] [-q]

Builds the call's input from the --<field> options (--a.b nests, a repeated field makes a list, a
bare true, false, null or number is that value) and decides it as a session in this directory
would, in this order:

  1. ampi.dangerouslyAllowAll: true in the user settings allows every call; with no setting that
     turns ampi-permissions on, every call runs too.
  2. A reject rule blocks the call.
  3. A change to a guarded file (path of edit and write, the paths in apply_patch's patchText,
     painter's output_path) asks, unless ampi.guardedFiles.allowlist covers it.
  4. The first matching rule decides: this project's reject and ask rules (read only when Pi
     trusts the project), then the user's rules, then ampi's defaults. No match allows.

The user's settings are Pi's settings.json in its configuration directory, the project's are
.pi/settings.json. A shell line (bash, shell_command) is judged per simple command, and each part
is printed under the line's decision. A delegate rule's program is not run: the decision reads
delegate to <program>. A subagent (--context subagent) refuses a call that would ask.

Options:

  --context thread|subagent     Decide for the main session (the default) or a subagent
  --workspace                   Decide with this project's rules and ampi's defaults only, as if
                                Pi trusted the project; the user's settings are left out
  --json                        Print one JSON object: decision, source (project, user, default,
                                guarded, allow-all, off or none) and, when they apply, rule,
                                category, files, command, reason, parts and subagentRefuses
  -q, --quiet                   Print nothing; the exit status says it
  -h, --help                    Print this help

--context, --to, --message, --workspace, --json, --quiet and --help are this command's own, so an
input field with one of those names cannot be given here.

Exit status: 0 allow, 1 reject, 3 ask or delegate, 2 on a usage error, 4 when the ampi package
cannot decide (it is too old, or its rules do not load).

Examples:

  $ ampi permissions test bash --command 'git push origin main'
  $ ampi permissions test write --path .env
  $ ampi permissions test bash --command 'ls && rm -rf build' --json
  $ ampi permissions test bash --command 'npm test' -q && echo runs without asking
`;
}

/** @returns {string} */
function formatEditHelp() {
  return `ampi permissions edit: edit the rules of ampi-permissions as text

Usage: ampi permissions edit [--workspace]
       ampi permissions edit [--workspace] < rules.txt

Opens the rules of Pi's user settings file in the text form (ampi permissions --help describes
it) in Pi's external editor: Pi's externalEditor setting, else $VISUAL, else $EDITOR, else nano
(notepad on Windows). When the editor exits, ampi.permissions is written back, keeping every other
key of the file, but only when every line is valid. When stdin is not a terminal, the rules are
read from stdin and no editor opens.

- A line with a problem prints line N: <problem>, the settings stay as they were, and the file you
  edited is kept; its path is printed, so you can fix it and run ampi permissions edit < <file>.
- Text without rules (only comments and blank lines) removes ampi.permissions. That turns
  ampi-permissions off unless ampi.dangerouslyAllowAll: false, ampi.guardedFiles.allowlist or the
  other settings file keeps it on; ampi.permissions: [] keeps it on with ampi's defaults only, so
  write that with ampi config edit.
- Empty stdin (not even a comment) is refused and writes nothing; send "# no rules" to remove
  every rule from a script.
- When the rules hold something the text form cannot write exactly (an input field named context,
  to or message, a list of objects, a list inside a list), or the list holds an invalid entry,
  edit does not start: change the JSON with ampi config edit.
- Running sessions keep the rules they read; new sessions read the change.

Options:

  --workspace                   This project's .pi/settings.json instead. Sessions ignore its allow
                                and delegate rules; edit writes them with a warning
  -h, --help                    Print this help

Exit status: 0 on success or when nothing changed, 1 when stdin is empty, a line has a problem,
the editor fails or the file cannot be written, 2 on a usage error.

Examples:

  $ ampi permissions edit
  $ ampi permissions list > rules.txt && $EDITOR rules.txt && ampi permissions edit < rules.txt
`;
}

/** @returns {string} */
function formatAddHelp() {
  return `ampi permissions add: put one new rule first

Usage: ampi permissions add <action> <tool> [--<field> <pattern>]... [--context thread|subagent]
                            [--to <program>] [--message <text>] [--workspace]

Builds a rule from the words, in the text form ampi permissions --help describes, and inserts it at
the front of ampi.permissions in Pi's user settings file, so it wins over the older rules. Every
existing entry stays as it is. Prints the rule as added. Your shell removes one level of quotes,
so quote a pattern with * or spaces, and quote a true, false, null or number twice ('"42"') to
match it as a string.

Options:

  --workspace                   This project's .pi/settings.json instead. Sessions use only its
                                reject and ask rules, and only when Pi trusts the project
  -h, --help                    Print this help

--workspace and --help are this command's own, so an input field with one of those names cannot be
given here.

Exit status: 0 on success, 1 when the settings cannot be written, 2 when the rule is invalid.

Examples:

  $ ampi permissions add ask bash --command 'git push*'
  $ ampi permissions add reject bash --command 'rm -rf *' --message 'Use the clean script.'
  $ ampi permissions add delegate bash --command 'git *' --to 'node ~/bin/approve.mjs'
  $ ampi permissions add allow 'mcp__*' --context subagent
`;
}

const HELP = /** @type {const} */ ({ list: formatListHelp, test: formatTestHelp, edit: formatEditHelp, add: formatAddHelp });

/**
 * Run `ampi permissions`.
 *
 * @param {readonly string[]} argv The command line after `permissions`.
 * @param {PermissionsHost} host
 * @returns {Promise<number>} The exit code.
 */
export async function runPermissionsCommand(argv, host) {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    host.out(formatPermissionsHelp());
    return 0;
  }
  const command = PERMISSIONS_ALIASES[/** @type {keyof typeof PERMISSIONS_ALIASES} */ (first)] ?? first;
  if (!PERMISSIONS_COMMANDS.includes(/** @type {any} */ (command))) {
    host.log.error(`permissions: unknown command ${first}.\nRun ampi permissions --help for the commands.`);
    return 2;
  }
  const name = /** @type {typeof PERMISSIONS_COMMANDS[number]} */ (command);
  if (rest.includes("--help") || rest.includes("-h")) {
    host.out(HELP[name]());
    return 0;
  }
  switch (name) {
    case "list":
      return list(rest, host);
    case "test":
      return test(rest, host);
    case "edit":
      return edit(rest, host);
    case "add":
      return add(rest, host);
  }
}

/**
 * @param {string} command
 * @param {string} message
 * @param {PermissionsHost} host
 * @returns {number}
 */
function usageError(command, message, host) {
  host.log.error(`permissions ${command}: ${message}\nRun ampi permissions ${command} --help for the options.`);
  return 2;
}

/**
 * @param {"list" | "edit"} command
 * @param {readonly string[]} args
 * @param {PermissionsHost} host
 * @returns {Record<string, boolean | undefined> | number} The options, or the exit code of a usage error.
 */
function readOptions(command, args, host) {
  try {
    const { values } = parseArgs({ args: [...args], options: OPTIONS[command], allowPositionals: false, strict: true });
    return /** @type {Record<string, boolean | undefined>} */ (values);
  } catch (error) {
    return usageError(command, error instanceof Error ? error.message : String(error), host);
  }
}

/**
 * Load the rule engine from the ampi package, or say why it cannot be.
 *
 * @param {string} command
 * @param {PermissionsHost} host
 * @returns {Promise<PermissionsCli | undefined>}
 */
async function loadCli(command, host) {
  const ampi = await host.locateAmpi();
  const entry = ampi === undefined ? undefined : path.join(ampi.root, PERMISSIONS_ENTRY);
  if (entry === undefined || !existsSync(entry)) {
    const which = ampi?.version === undefined ? "the ampi package" : `ampi ${ampi.version}`;
    host.log.error(`${which} is too old for permissions ${command}; update @skippermissions/ampi (or ampi-cli).`);
    return undefined;
  }
  try {
    const received = /** @type {Partial<PermissionsCli> | undefined} */ (await loadThroughPi(host.pi, entry, PERMISSIONS_EVENT));
    if (typeof received?.parseRulesText === "function") return /** @type {PermissionsCli} */ (received);
    host.log.error("could not load ampi's permission rules: the ampi package did not provide them.");
  } catch (error) {
    host.log.error(`could not load ampi's permission rules: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

/**
 * @param {PermissionsHost} host
 * @param {boolean} workspace
 */
function settingsFile(host, workspace) {
  return piSettingsPath(host.pi, host.cwd, workspace ? "project" : "user");
}

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/** @param {PermissionRule} rule */
const projectIgnores = (rule) => rule.action === "allow" || rule.action === "delegate";

/**
 * @param {PermissionsHost} host
 * @param {string} file
 */
function warnUntrusted(host, file) {
  if (!isPiProjectTrusted(host.pi, host.cwd)) {
    host.log.warn(`Pi does not trust this project, so sessions do not read the rules in ${file}; trust it when Pi asks at the start of a session.`);
  }
}

/**
 * @param {readonly string[]} args
 * @param {PermissionsHost} host
 * @returns {Promise<number>}
 */
async function list(args, host) {
  const options = readOptions("list", args, host);
  if (typeof options === "number") return options;
  if (options.builtin && options.workspace) return usageError("list", "--builtin and --workspace cannot be combined.", host);
  const cli = await loadCli("list", host);
  if (cli === undefined) return 1;
  if (options.builtin) {
    host.out(options.json ? `${JSON.stringify(cli.defaultRules, null, 2)}\n` : cli.defaultRules.map((rule) => `${cli.formatRule(rule)}\n`).join(""));
    return 0;
  }
  const workspace = options.workspace === true;
  const file = settingsFile(host, workspace);
  /** @type {StoredSetting} */
  let stored;
  try {
    stored = cli.readSetting(file);
  } catch (error) {
    host.log.error(`could not read the rules: ${messageOf(error)}`);
    return 1;
  }
  if (!stored.present) {
    host.log.info(`no rules: ${file} has no ampi.permissions.`);
    return 0;
  }
  if (!Array.isArray(stored.value)) {
    host.log.error(`ampi.permissions in ${file} is not a list of rules, so sessions ask before every tool call; fix it with ampi config edit${workspace ? " --workspace" : ""}.`);
    return 1;
  }
  if (workspace) warnUntrusted(host, file);
  if (stored.value.length === 0) host.log.info(`no rules: ampi.permissions in ${file} is empty, so sessions use ampi's defaults (ampi permissions list --builtin).`);
  if (options.json) {
    if (stored.value.length > 0) host.out(`${JSON.stringify(stored.value, null, 2)}\n`);
    return 0;
  }
  /** @type {string[]} */
  const lines = [];
  for (const [index, entry] of stored.value.entries()) {
    const problems = cli.validateRule(entry);
    if (problems.length > 0) {
      host.log.warn(`skipping ampi.permissions[${index}] in ${file}: ${problems.join("; ")}.`);
      continue;
    }
    const rule = /** @type {PermissionRule} */ (entry);
    if (workspace && projectIgnores(rule)) host.log.warn(`sessions ignore this project's ${rule.action} rule ${cli.formatRule(rule)}: project settings only add reject and ask rules.`);
    const unwritable = cli.ruleTextProblem(rule);
    if (unwritable === undefined) {
      lines.push(cli.formatRule(rule));
    } else {
      host.log.info(`ampi.permissions[${index}] has no exact text form (${unwritable}), so it is printed as a comment holding its JSON.`);
      lines.push(`# ${JSON.stringify(rule)}`);
    }
  }
  host.out(lines.map((line) => `${line}\n`).join(""));
  return 0;
}

/**
 * @param {PermissionsCli} cli
 * @param {PermissionRule | undefined} rule
 * @param {string | undefined} source
 */
function describeRule(cli, rule, source) {
  return rule === undefined ? undefined : `${source ?? "a"} rule ${cli.formatRule(rule)}`;
}

/**
 * The decision word of a text line: `delegate to <program>` for a delegated one.
 *
 * @param {RuleDecision} decision
 */
function decisionWord(decision) {
  return decision.action === "delegate" && decision.rule?.to !== undefined ? `delegate to ${decision.rule.to}` : decision.action;
}

/**
 * @param {PermissionsCli} cli
 * @param {RuleDecision} decision
 * @returns {string}
 */
function formatPart(cli, decision) {
  const why = describeRule(cli, decision.rule, decision.source) ?? decision.reason ?? "no rule matched";
  return `  ${decisionWord(decision)}: ${decision.command ?? ""} (${why})`;
}

/**
 * The text `test` prints for a decision.
 *
 * @param {PermissionsCli} cli
 * @param {CallDecision} decided
 * @param {string} userFile
 * @returns {string[]}
 */
function formatDecision(cli, decided, userFile) {
  const { rules } = decided;
  switch (decided.source) {
    case "off":
      return ["allow: ampi-permissions is off here, so every tool call runs"];
    case "allow-all":
      return [`allow: ampi.dangerouslyAllowAll is true in ${userFile}, so every tool call runs`];
    case "guarded": {
      const lines = decided.guarded.map((file) => `ask: guarded file ${file.path} (${file.category.description})`);
      if (rules?.action === "delegate") lines.push(`  after a yes: ${decisionWord(rules)} (${describeRule(cli, rules.rule, rules.source)})`);
      return lines;
    }
  }
  if (rules === undefined) return [`${decided.action}: no rule matched`];
  const why = describeRule(cli, rules.rule, rules.source) ?? rules.reason ?? (rules.parts !== undefined ? "every part is allowed" : "no rule matched");
  const part = rules.command !== undefined && rules.parts === undefined ? ` (for ${rules.command})` : "";
  return [`${decisionWord(rules)}: ${why}${part}`, ...(rules.parts ?? []).map((decision) => formatPart(cli, decision))];
}

/**
 * The JSON `test --json` prints for a part or a line.
 *
 * @param {RuleDecision} decision
 */
function reportOf(decision) {
  return {
    decision: decision.action,
    source: decision.source ?? "none",
    ...(decision.rule !== undefined ? { rule: decision.rule } : {}),
    ...(decision.command !== undefined ? { command: decision.command } : {}),
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
  };
}

/**
 * @param {readonly string[]} args
 * @param {PermissionsHost} host
 * @returns {Promise<number>}
 */
async function test(args, host) {
  const cli = await loadCli("test", host);
  if (cli === undefined) return TEST_EXIT.undecided;
  const parsed = cli.parseCallArgs(args, FLAGS.test);
  if (parsed.problems.length > 0 || parsed.toolName === undefined) {
    usageError("test", parsed.problems.join("\n"), host);
    return TEST_EXIT.usage;
  }
  const workspace = parsed.flags.has("workspace");
  const userFile = settingsFile(host, false);
  const projectFile = settingsFile(host, true);
  const trusted = isPiProjectTrusted(host.pi, host.cwd);
  if (workspace && !trusted) host.log.info(`Pi does not trust this project, so sessions do not read ${projectFile}; this test reads it anyway.`);
  const settings = workspace ? cli.loadWorkspaceSettings(projectFile) : cli.loadSettings({ userFile, ...(trusted ? { projectFile } : {}) });
  for (const warning of settings.warnings) host.log.warn(warning);
  const context = parsed.context ?? "thread";
  const decided = cli.decide({ toolName: parsed.toolName, input: parsed.input }, settings, {
    context,
    guardedFiles: { cwd: host.cwd, agentDir: host.pi.getAgentDir() },
  });
  const subagentRefuses = context === "subagent" && decided.action === "ask";
  if (decided.source === "off") {
    host.log.info("no setting turns ampi-permissions on: ampi.permissions (ampi permissions add or edit), ampi.dangerouslyAllowAll: false or ampi.guardedFiles.allowlist does.");
  }
  if (subagentRefuses) host.log.info("a subagent cannot ask, so it refuses this call instead.");
  if (!parsed.flags.has("quiet")) {
    if (parsed.flags.has("json")) {
      const { rules } = decided;
      const [first] = decided.guarded;
      const report = {
        decision: decided.action,
        source: decided.source,
        ...(first !== undefined
          ? { category: first.category, files: decided.guarded.map((file) => ({ path: file.path, category: file.category })) }
          : rules !== undefined
            ? {
                ...reportOf(rules),
                decision: decided.action,
                source: decided.source,
                ...(rules.parts !== undefined ? { parts: rules.parts.map(reportOf) } : {}),
              }
            : {}),
        ...(subagentRefuses ? { subagentRefuses: true } : {}),
      };
      host.out(`${JSON.stringify(report)}\n`);
    } else {
      host.out(formatDecision(cli, decided, userFile).map((line) => `${line}\n`).join(""));
    }
  }
  return TEST_EXIT[/** @type {keyof typeof TEST_EXIT} */ (decided.action)];
}

/**
 * @param {readonly string[]} args
 * @param {PermissionsHost} host
 * @returns {Promise<number>}
 */
async function add(args, host) {
  const cli = await loadCli("add", host);
  if (cli === undefined) return 1;
  const parsed = cli.parseRuleArgs(args, FLAGS.add);
  if (parsed.rule === undefined) return usageError("add", parsed.problems.join("\n"), host);
  const rule = parsed.rule;
  const workspace = parsed.flags.has("workspace");
  const file = settingsFile(host, workspace);
  try {
    cli.writeSetting(file, (current) => {
      if (current.present && !Array.isArray(current.value)) throw new Error("its ampi.permissions is not a list of rules; fix it with ampi config edit");
      return [rule, ...(current.present ? /** @type {unknown[]} */ (current.value) : [])];
    });
  } catch (error) {
    host.log.error(`could not add the rule to ${file}: ${messageOf(error)}`);
    return 1;
  }
  host.out(`${cli.formatRule(rule)}\n`);
  host.log.info(`added the rule first in ${file}; new sessions use it.`);
  if (workspace && projectIgnores(rule)) host.log.warn(`sessions ignore a project's ${rule.action} rules: project settings only add reject and ask rules.`);
  if (workspace) warnUntrusted(host, file);
  return 0;
}

/**
 * The comment lines at the top of the file `edit` opens.
 *
 * @param {string} file
 */
function editHeader(file) {
  return [
    `# ampi.permissions in ${file}, one rule per line:`,
    "#   <action> <tool> [--<field> <pattern>]... [--context thread|subagent] [--to <program>] [--message <text>]",
    "# for example: ask bash --command 'git push*'. Lines starting with # are ignored. Saving",
    "# without rules removes ampi.permissions. ampi permissions --help describes every option.",
    "",
  ].join("\n");
}

/**
 * @param {readonly string[]} args
 * @param {PermissionsHost} host
 * @returns {Promise<number>}
 */
async function edit(args, host) {
  const options = readOptions("edit", args, host);
  if (typeof options === "number") return options;
  const cli = await loadCli("edit", host);
  if (cli === undefined) return 1;
  const workspace = options.workspace === true;
  const flag = workspace ? " --workspace" : "";
  const file = settingsFile(host, workspace);
  /** @type {StoredSetting} */
  let stored;
  try {
    // As the write will read it: a symbolic link is refused before the editor opens.
    stored = cli.readSetting(file, { noFollow: true });
  } catch (error) {
    host.log.error(`could not read the rules: ${messageOf(error)}`);
    return 1;
  }
  const refuse = (/** @type {string} */ why) => {
    host.log.error(`edit cannot show ampi.permissions in ${file} as text without changing it: ${why}. Change the JSON with ampi config edit${flag}.`);
    return 1;
  };
  /** @type {PermissionRule[]} */
  const current = [];
  if (stored.present) {
    if (!Array.isArray(stored.value)) return refuse("it is not a list of rules");
    for (const [index, entry] of stored.value.entries()) {
      const problems = cli.validateRule(entry);
      if (problems.length > 0) return refuse(`ampi.permissions[${index}] is invalid (${problems.join("; ")})`);
      const unwritable = cli.ruleTextProblem(/** @type {PermissionRule} */ (entry));
      if (unwritable !== undefined) return refuse(`ampi.permissions[${index}] has no exact text form (${unwritable})`);
      current.push(/** @type {PermissionRule} */ (entry));
    }
  }
  const text = current.map((rule) => `${cli.formatRule(rule)}\n`).join("");

  /** @type {string | undefined} The file the editor opened, kept after a problem. */
  let tempFile;
  const removeTemp = () => {
    if (tempFile !== undefined) rmSync(path.dirname(tempFile), { recursive: true, force: true });
  };
  /** @type {string} */
  let edited;
  if (host.stdinIsTTY) {
    const offered = `${editHeader(file)}${text}`;
    tempFile = path.join(mkdtempSync(path.join(host.tempDir ?? os.tmpdir(), "ampi-permissions-")), "permissions.txt");
    writeFileSync(tempFile, offered, { mode: 0o600, flag: "wx" });
    const problem = await host.editFile(tempFile);
    if (problem !== undefined) {
      removeTemp();
      host.log.error(`${problem} Nothing was written to ${file}.`);
      return 1;
    }
    edited = readFileSync(tempFile, "utf8");
    if (edited === offered) {
      removeTemp();
      host.log.info(`no change; nothing was written to ${file}.`);
      return 0;
    }
  } else {
    edited = await host.readStdin();
    // An empty pipe is far more often a mistake (a redirect from a missing or empty file) than a wish to remove every rule.
    if (edited.trim() === "") {
      host.log.error(
        `stdin is empty, so nothing was written to ${file}. To remove every rule, send a comment line such as "# no rules"; ` +
          `to edit the rules in your editor, run ampi permissions edit${flag} from a terminal.`,
      );
      return 1;
    }
  }

  const parsed = cli.parseRulesText(edited);
  if (parsed.problems.length > 0) {
    for (const problem of parsed.problems) host.log.error(problem);
    const kept = tempFile === undefined ? "" : ` Your text is kept in ${tempFile}; fix it and run ampi permissions edit${flag} < ${tempFile}.`;
    host.log.error(`nothing was written to ${file}.${kept}`);
    return 1;
  }
  const { rules } = parsed;
  const unchanged = rules.length === 0 ? !stored.present : stored.present && isDeepStrictEqual(rules, stored.value);
  if (unchanged) {
    removeTemp();
    host.log.info(`no change; nothing was written to ${file}.`);
    return 0;
  }
  try {
    cli.writeSetting(file, (now) => {
      if (!isDeepStrictEqual(now, stored)) throw new Error("its ampi.permissions changed while you were editing; run the command again");
      return rules.length > 0 ? rules : undefined;
    });
  } catch (error) {
    const kept = tempFile === undefined ? "" : ` Your text is kept in ${tempFile}.`;
    host.log.error(`could not write ${file}: ${messageOf(error)}.${kept}`);
    return 1;
  }
  removeTemp();
  if (rules.length > 0) {
    host.log.info(`wrote ${rules.length} rule${rules.length === 1 ? "" : "s"} to ampi.permissions in ${file}; new sessions use them.`);
  } else {
    host.log.info(`removed ampi.permissions from ${file}.`);
    const trusted = isPiProjectTrusted(host.pi, host.cwd);
    const settings = cli.loadSettings({ userFile: settingsFile(host, false), ...(trusted ? { projectFile: settingsFile(host, true) } : {}) });
    if (!settings.enabled) host.log.warn("no setting turns ampi-permissions on any more, so new sessions here run every tool call without asking.");
  }
  if (workspace) {
    for (const rule of rules.filter(projectIgnores)) {
      host.log.warn(`sessions ignore this project's ${rule.action} rule ${cli.formatRule(rule)}: project settings only add reject and ask rules.`);
    }
    if (rules.length > 0) warnUntrusted(host, file);
  }
  return 0;
}
