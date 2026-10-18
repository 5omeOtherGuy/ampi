import type { MmrPermissionAction, MmrPermissionRule } from "./permissions.js";

/**
 * ampi's default permission rules. They come after the project's and the
 * user's own rules, so any of those wins over them.
 *
 * The defaults only look at shell commands. Each simple command of a line is
 * checked on its own (the line is split at `;`, `&&`, `||`, `|`, `&` and
 * newlines), and the line runs without asking only when every part is
 * allowed. A part is allowed when it starts with a command that only reads
 * or inspects, or runs a project's tests, linters, type checks or builds.
 * Everything else asks, including any other package script, wrappers such as
 * `env`, `xargs`, `time`, `nice` or `timeout`, and leading `VAR=value`
 * assignments, which the allow patterns never match.
 *
 * Patterns are `/regex/flags` strings. The engine matches them against the
 * part's original text and against its literal words (quotes and escapes
 * removed), so `find . '-delete'` asks like `find . -delete`, and it asks
 * instead of allowing a part that writes output into a file or whose words a
 * variable or brace expansion could change. The `s` flag lets `.` cross a
 * newline inside quotes. Other tools get no default rule: a call no rule
 * matches is allowed.
 */

interface ShellRuleGroup {
  readonly action: Extract<MmrPermissionAction, "allow" | "ask">;
  readonly patterns: readonly string[];
}

const SHELL_RULE_GROUPS: readonly ShellRuleGroup[] = [
  {
    // Exceptions, checked before the allow patterns below.
    action: "ask",
    patterns: [
      // find actions that run programs, delete, or write files.
      "/^find\\s(.*\\s)?-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)(\\s|$)/s",
      // git options that write a file or open files in another program.
      "/^git\\s(.*\\s)?(--output(=|\\s|$)|-O|--open-files-in-pager)/s",
      // sort and tree writing their output to a file; sort running a compressor.
      "/^sort\\s(.*\\s)?(-[a-zA-Z]*o|--output|--compress-program)/s",
      "/^tree\\s(.*\\s)?-o/s",
      // rg running a preprocessor program on every file.
      "/^rg\\s(.*\\s)?--pre(=|\\s|$)/s",
      // file compiling a magic database, date setting the clock.
      "/^file\\s(.*\\s)?(-[a-zA-Z]*C|--compile)/s",
      "/^date\\s(.*\\s)?(-s|--set)(=|\\s|$)/s",
      // Linters and formatters told to change the files they check.
      "/^(biome|eslint|prettier|cargo\\s+clippy)\\s(.*\\s)?--(write|fix|apply|apply-unsafe|unsafe)(=|\\s|$)/s",
      "/^prettier\\s(.*\\s)?-w(\\s|$)/s",
      // eslint writing its report to a file.
      "/^eslint\\s(.*\\s)?(-o|--output-file)(=|\\s|$)/s",
    ],
  },
  {
    action: "allow",
    patterns: [
      // Commands that read or inspect.
      "/^(cd|ls|pwd|echo|cat|head|tail|wc|file|stat|which|date|uname|whoami|tree|du|df|sort|cut|rg|grep)(\\s|$)/s",
      // uniq with at most one file: a second one would be written.
      "/^uniq(\\s+-\\S+)*(\\s+[^-\\s]\\S*)?(\\s+-\\S+)*$/s",
      "/^find(\\s|$)/s",
      // git that reads: history, diffs, the index, and listing branches and remotes.
      "/^git\\s+(status|diff|log|show|rev-parse|ls-files|grep|blame)(\\s|$)/s",
      "/^git\\s+branch(\\s+(-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current|--color|--no-color))*$/s",
      "/^git\\s+remote(\\s+(-v|--verbose))?$/s",
      // jj that reads.
      "/^jj\\s+(status|diff|log|show|root)(\\s|$)/s",
      "/^jj\\s+file\\s+list(\\s|$)/s",
      // Package scripts that test, lint, check, type-check or build.
      "/^(npm|pnpm|yarn|bun)\\s+test(\\s|$)/s",
      "/^(npm|pnpm|yarn|bun)\\s+run\\s+(test|lint|check|typecheck|build)\\S*(\\s|$)/s",
      // Test runners, linters, type checkers and build tools.
      "/^node\\s+--test(\\s|$)/s",
      "/^(tsc|eslint|pytest)(\\s|$)/s",
      "/^biome\\s+(check|lint)(\\s|$)/s",
      "/^prettier\\s(.*\\s)?(--check|-c)(\\s|$)/s",
      "/^go\\s+(test|vet|build)(\\s|$)/s",
      "/^cargo\\s+(test|build|check|clippy)(\\s|$)/s",
      "/^cargo\\s+fmt\\s(.*\\s)?--check(\\s|$)/s",
      "/^make\\s+(-n|--dry-run|--just-print|--recon)(\\s|$)/s",
      "/^mvn\\s+(test|verify)(\\s|$)/s",
      "/^gradle\\s+test(\\s|$)/s",
      "/^dotnet\\s+(test|build)(\\s|$)/s",
    ],
  },
];

/** The shell tools the defaults cover, each with its own copy of the rules. */
const SHELL_TOOLS = ["bash", "shell_command"] as const;

function freezeRule(rule: MmrPermissionRule): MmrPermissionRule {
  if (rule.matches) Object.freeze(rule.matches);
  return Object.freeze(rule);
}

export const MMR_PERMISSIONS_DEFAULT_RULES: readonly MmrPermissionRule[] = Object.freeze([
  ...SHELL_TOOLS.flatMap((tool) =>
    SHELL_RULE_GROUPS.flatMap((group) =>
      group.patterns.map((pattern) => freezeRule({ tool, matches: { command: pattern }, action: group.action })),
    ),
  ),
  // Every other shell command asks. PowerShell commands are never split, so
  // each one asks unless a project or user rule decides it.
  ...["bash", "shell_command", "powershell"].map((tool) => freezeRule({ tool, action: "ask" })),
]);
