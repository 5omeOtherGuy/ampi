// Shell completion for the `ampi` command. `ampi completions <shell>` prints
// a small script for bash, zsh, fish or PowerShell that holds no command list
// of its own: on every Tab it runs the hidden `ampi __complete <shell> --
// <words...>`, which resolves the words against the command tree in
// command-tree.js and prints the candidates. Values ampi looks up (thread
// ids, skill and MCP server names) come from providers, so the resolver
// itself reads nothing; only thread ids and skill names load Pi.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { COLOR_CHOICES, COMMAND_TREE, MODE_CHOICES, SHELL_CHOICES } from "./command-tree.js";
import { definedServers } from "./mcp-config.js";

/**
 * @typedef {import("./command-tree.js").TreeCommand} TreeCommand
 * @typedef {import("./command-tree.js").TreeOption} TreeOption
 * @typedef {import("./command-tree.js").ValueKind} ValueKind
 *
 * @typedef {{ value: string, description?: string }} Candidate
 *
 * @typedef {{ candidates: Candidate[] } | { path: "file" | "directory", prefix: string }} Completion
 *   Candidates for the word under the cursor, or a request for the shell's own
 *   path completion of the word after `prefix` (`--log-file=` in `--log-file=./lo`).
 *
 * @typedef {() => Candidate[] | Promise<Candidate[]>} CandidateProvider
 *
 * @typedef {object} CompletionProviders The values ampi looks up; each may fail, which offers nothing.
 * @property {CandidateProvider} threadIds This directory's sessions, newest first.
 * @property {CandidateProvider} skills The skills Pi loads here.
 * @property {CandidateProvider} mcpServers The MCP servers the user's and this project's mcp.json define.
 *
 * @typedef {object} CompleteHost
 * @property {(text: string) => void} out Writes to stdout.
 * @property {CompletionProviders} providers
 *
 * @typedef {object} CompletionsHost
 * @property {(text: string) => void} out Writes to stdout.
 * @property {import("./log.js").Logger} log For the usage errors.
 */

/** The shells there is a script for, in the order the messages list them. */
export const SHELLS = Object.freeze(SHELL_CHOICES.map((choice) => choice.value));

export const OPTIONS = /** @type {const} */ ({
  help: { type: "boolean", short: "h" },
});

const USAGE_HINT = "Run ampi completions --help for how to load the script.";
const SHELL_LIST = "bash, zsh, fish or pwsh";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * The output protocol of `ampi __complete`, which every script parses: one
 * candidate per line as `<value>\t<description>`, or `<value>` alone when it
 * has no description; or, for a path, the single line `:file` or
 * `:directory`, followed by `\t<prefix>` when the path starts after a prefix
 * of the word (`--log-file=`). No candidate value starts with `:`.
 */
export const PATH_MARKER = Object.freeze({ file: ":file", directory: ":directory" });

/** C0 and C1 control characters, tabs and newlines included: descriptions come from user data. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Values a shell inserts as typed without quoting: anything else (a space, a
 * quote, `$`, `;`) is left out rather than offered, so an MCP server with such
 * a name is not completed. A value does not start with a character a shell
 * reads specially there (`#` a comment, `~` the home directory, `@` and `%`
 * in PowerShell, `=` in zsh), and is not PowerShell's stop-parsing token `--%`.
 */
const SAFE_VALUE = /^(?!--%$)[\w.+,/-][\w.@%+=,/~#:-]*$/u;

/** @param {string} text */
const oneLine = (text) => text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

/** The longest description printed, in characters; a skill's can be a paragraph. */
const DESCRIPTION_MAX = 80;

/** @param {string} text */
const shortDescription = (text) => {
  const line = oneLine(text);
  const characters = [...line];
  return characters.length <= DESCRIPTION_MAX ? line : `${characters.slice(0, DESCRIPTION_MAX - 1).join("").trimEnd()}…`;
};

const NOTHING = /** @returns {Completion} */ () => ({ candidates: [] });

/** @param {string} word */
const isOptionWord = (word) => word.startsWith("-") && word !== "-";

/**
 * The option `word` names in `node`, how it was spelled and whether its value is inline.
 *
 * @param {TreeCommand} node
 * @param {string} word
 * @returns {{ option: TreeOption, short: boolean, inline: boolean } | undefined}
 */
function findOption(node, word) {
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    const name = equals === -1 ? word : word.slice(0, equals);
    const option = node.options.find((candidate) => candidate.name === name);
    return option === undefined ? undefined : { option, short: false, inline: equals !== -1 };
  }
  const exact = node.options.find((candidate) => candidate.short.includes(word));
  if (exact !== undefined) return { option: exact, short: true, inline: false };
  // A one-letter short spelling with its value attached: `-mhigh`.
  const attached = node.options.find((candidate) => candidate.value && candidate.short.includes(word.slice(0, 2)));
  return attached === undefined ? undefined : { option: attached, short: true, inline: true };
}

/**
 * The subcommand `word` names, through its name or an alias, hidden ones included.
 *
 * @param {TreeCommand} node
 * @param {string} word
 * @returns {TreeCommand | undefined}
 */
const findCommand = (node, word) => node.commands.find((child) => child.name === word || child.aliases.includes(word));

/**
 * The subcommands that complete `prefix`. An alias is offered only when no
 * name matches, so `ampi threads l` offers list and label, and `ampi threads
 * f` offers find.
 *
 * @param {TreeCommand} node
 * @param {string} prefix
 * @returns {Candidate[]}
 */
function commandCandidates(node, prefix) {
  const visible = node.commands.filter((child) => child.hidden !== true);
  const names = visible.filter((child) => child.name.startsWith(prefix)).map((child) => ({ value: child.name, description: child.description }));
  if (names.length > 0 || prefix === "") return names;
  return visible.flatMap((child) => child.aliases.filter((alias) => alias.startsWith(prefix)).map((alias) => ({ value: alias, description: child.description })));
}

/**
 * The options that complete `prefix`: after a lone `-` every spelling, after
 * `--` the long names, after `-` and a letter the short spellings. Hidden
 * options, and options already given that do not repeat, are left out.
 *
 * @param {TreeCommand} node
 * @param {string} prefix
 * @param {Set<TreeOption>} used
 * @returns {Candidate[]}
 */
function optionCandidates(node, prefix, used) {
  const offered = node.options.filter((option) => option.hidden !== true && (option.repeat || !used.has(option)));
  /** @type {Candidate[]} */
  const candidates = [];
  for (const option of offered) {
    const spellings = prefix === "-" ? [...option.short, option.name] : prefix.startsWith("--") ? [option.name] : option.short;
    for (const spelling of spellings) {
      if (spelling.startsWith(prefix)) candidates.push({ value: spelling, description: option.description });
    }
  }
  return candidates;
}

/**
 * @param {CandidateProvider} provider
 * @returns {Promise<Candidate[]>}
 */
async function ask(provider) {
  try {
    return await provider();
  } catch {
    return [];
  }
}

/**
 * The values of `kind` that complete `prefix`.
 *
 * @param {ValueKind | undefined} kind
 * @param {string} prefix
 * @param {CompletionProviders} providers
 * @returns {Promise<Completion>}
 */
async function valueCompletion(kind, prefix, providers) {
  if (kind === undefined) return NOTHING();
  if (kind === "file" || kind === "directory") return { path: kind, prefix: "" };
  /** @type {readonly Candidate[]} */
  let all;
  if (typeof kind === "object") all = kind.choices;
  else if (kind === "mode") all = MODE_CHOICES;
  else if (kind === "color") all = COLOR_CHOICES;
  else if (kind === "shell") all = SHELL_CHOICES;
  else if (kind === "thread-id") all = await ask(providers.threadIds);
  else if (kind === "skill") all = await ask(providers.skills);
  else all = await ask(providers.mcpServers);
  return { candidates: all.filter((candidate) => candidate.value.startsWith(prefix)) };
}

/**
 * The value of an option as the word under the cursor, the option's own
 * spelling (`--mode=`) included when the value is inline.
 *
 * @param {{ option: TreeOption, short: boolean }} found
 * @param {string} spelled What precedes the value in the word: `--mode=`, or nothing.
 * @param {string} prefix The value typed so far.
 * @param {CompletionProviders} providers
 * @returns {Promise<Completion>}
 */
async function optionValueCompletion({ option, short }, spelled, prefix, providers) {
  const completion = await valueCompletion(short && option.shortKind !== undefined ? option.shortKind : option.kind, prefix, providers);
  if ("path" in completion) return { path: completion.path, prefix: spelled };
  return { candidates: completion.candidates.map((candidate) => ({ ...candidate, value: spelled + candidate.value })) };
}

/**
 * Resolve the word under the cursor against the command tree. The words are
 * read the way the router and the command modules read them: aliases name
 * their command, an option that takes a value takes the next word (or its
 * `=value`), the global options may come before a command at the top level,
 * an option right after `threads` belongs to `threads list`, and `--` or a
 * message (a word that is not a command where a command could come) ends
 * what is completed, as does one of Pi's own commands. Pure: dynamic values
 * come from `providers`.
 *
 * @param {readonly string[]} words The words before the one under the cursor, starting with `ampi`.
 * @param {string} current The word under the cursor, up to the cursor; empty after a space.
 * @param {TreeCommand} [tree]
 * @param {CompletionProviders} [providers]
 * @returns {Promise<Completion>}
 */
export async function resolveCompletion(words, current, tree = COMMAND_TREE, providers = NO_PROVIDERS) {
  let node = tree;
  /** Whether a subcommand of `node` may come next. */
  let commandsOpen = true;
  /** How many of `node`'s positional arguments are given. */
  let given = 0;
  /** @type {Set<TreeOption>} */
  let used = new Set();
  /** @type {{ option: TreeOption, short: boolean } | undefined} An option waiting for its value. */
  let pending;
  /** @param {TreeCommand} next */
  const enter = (next) => {
    node = next;
    commandsOpen = true;
    given = 0;
    used = new Set();
  };
  /** `ampi threads --json` lists: an option before any subcommand belongs to the implicit one. */
  const enterImplicit = () => {
    const implicit = node.implicit === undefined || !commandsOpen || given > 0 ? undefined : findCommand(node, node.implicit);
    if (implicit !== undefined) enter(implicit);
  };

  for (const word of words.slice(1)) {
    if (pending !== undefined) {
      pending = undefined;
      continue;
    }
    if (word === "--") return NOTHING();
    if (isOptionWord(word)) {
      enterImplicit();
      const found = findOption(node, word);
      // At the top level only the global options may come before a command; below it, only where the command says so.
      if (node === tree ? found?.option.global !== true : node.optionsBeforeCommand !== true) commandsOpen = false;
      if (found === undefined) continue;
      used.add(found.option);
      if (found.option.value && !found.inline) pending = found;
      continue;
    }
    const next = commandsOpen && given === 0 ? findCommand(node, word) : undefined;
    if (next !== undefined) {
      if (next.pi === true) return NOTHING();
      enter(next);
      continue;
    }
    const argument = node.args[given];
    // A message, an unknown subcommand, or one argument too many.
    if (node.message === true || argument === undefined) return NOTHING();
    commandsOpen = false;
    if (argument.variadic !== true) given++;
  }

  if (pending !== undefined) return optionValueCompletion(pending, "", current, providers);
  if (current.startsWith("--") && current.includes("=")) {
    enterImplicit();
    const found = findOption(node, current);
    if (found === undefined || !found.option.value || found.option.hidden === true) return NOTHING();
    const spelled = current.slice(0, current.indexOf("=") + 1);
    return optionValueCompletion(found, spelled, current.slice(spelled.length), providers);
  }
  if (current.startsWith("-")) {
    enterImplicit();
    return { candidates: optionCandidates(node, current, used) };
  }
  if (commandsOpen && given === 0 && node.commands.length > 0) return { candidates: commandCandidates(node, current) };
  if (node.message === true) return NOTHING();
  const argument = node.args[given];
  return argument === undefined ? NOTHING() : valueCompletion(argument.kind, current, providers);
}

/** @type {CompletionProviders} */
const NO_PROVIDERS = { threadIds: () => [], skills: () => [], mcpServers: () => [] };

/**
 * A completion in the output protocol (PATH_MARKER). Values a shell could
 * misread are left out, descriptions become one line without control
 * characters, and a value already printed is not printed again.
 *
 * @param {Completion} completion
 * @returns {string}
 */
export function formatCompletion(completion) {
  if ("path" in completion) {
    const prefix = oneLine(completion.prefix);
    return `${PATH_MARKER[completion.path]}${prefix === "" ? "" : `\t${prefix}`}\n`;
  }
  /** @type {Set<string>} */
  const seen = new Set();
  let text = "";
  for (const { value, description } of completion.candidates) {
    if (!SAFE_VALUE.test(value) || seen.has(value)) continue;
    seen.add(value);
    const line = shortDescription(description ?? "");
    text += line === "" ? `${value}\n` : `${value}\t${line}\n`;
  }
  return text;
}

/**
 * Run `ampi __complete <shell> -- <words...>`: print the candidates for the
 * last word. Always exits 0 and never writes to stderr: a malformed request
 * or a failing provider prints nothing.
 *
 * @param {readonly string[]} argv The command line after `__complete`.
 * @param {CompleteHost} host
 * @returns {Promise<number>}
 */
export async function runCompleteCommand(argv, host) {
  const [shell, separator, ...words] = argv;
  if (!SHELLS.includes(shell ?? "") || separator !== "--" || words.length < 2) return 0;
  try {
    host.out(formatCompletion(await resolveCompletion(words.slice(0, -1), words[words.length - 1], COMMAND_TREE, host.providers)));
  } catch {
    // Nothing to offer.
  }
  return 0;
}

/**
 * Pi's configuration directory without loading Pi: `PI_CODING_AGENT_DIR`
 * with a leading `~` expanded, else `~/.pi/agent`, as Pi's `getAgentDir()`.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function agentDirOf(env) {
  const home = env.HOME || homedir();
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) return path.join(home, ".pi", "agent");
  if (dir === "~") return home;
  return dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir;
}

/**
 * The providers `ampi __complete` uses in `cwd`. Thread ids and skill names
 * import Pi when they are asked for; MCP server names read the user's
 * `mcp.json` and this project's `.pi/mcp.json` without loading Pi or
 * connecting anything (a project file is read whether or not Pi trusts the
 * project, so `mcp approve` can complete its servers).
 *
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {CompletionProviders}
 */
export function createCompletionProviders({ cwd, env }) {
  return {
    threadIds: async () => {
      const [pi, { listPiSessions }, { threadTitle }] = await Promise.all([import(PI_PACKAGE_NAME), import("./pi-compat.js"), import("./threads.js")]);
      const sessions = await listPiSessions(pi, { cwd, env, scope: "workspace" });
      return [...sessions]
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .map((session) => ({ value: session.id, description: threadTitle(session) }));
    },
    skills: async () => {
      const [pi, { readSessionSkills }] = await Promise.all([import(PI_PACKAGE_NAME), import("./skill.js")]);
      const { skills } = await readSessionSkills(pi, cwd);
      return [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((skill) => ({ value: skill.name, description: skill.description }));
    },
    mcpServers: () => {
      const files = [
        { file: path.join(agentDirOf(env), "mcp.json"), project: false, description: "MCP server in mcp.json" },
        { file: path.join(cwd, ".pi", "mcp.json"), project: true, description: "MCP server in this project's .pi/mcp.json" },
      ];
      return files.flatMap(({ file, project, description }) => (existsSync(file) ? definedServers(file, project).map((value) => ({ value, description })) : []));
    },
  };
}

/**
 * The text `ampi completions --help` prints.
 *
 * @returns {string}
 */
export function formatCompletionsHelp() {
  return `ampi completions: print a script that completes the ampi command in your shell

Usage: ampi completions bash|zsh|fish|pwsh

The script completes ampi's commands, subcommands and options, Pi's own options and command
names, and the values ampi knows: modes, thread colours, the ids of this directory's sessions,
the skills Pi loads here and the MCP servers in mcp.json. Files and directories get the
shell's own path completion. On every Tab the script asks ampi itself (ampi __complete), so it
never needs regenerating when ampi gains a command, and it runs the ampi on PATH, so it keeps
working after ampi update.

Loading it:

  bash    Add this line to ~/.bashrc:
              source <(ampi completions bash)
  zsh     Save it as _ampi in a directory on $fpath, which ~/.zshrc must set before it runs
          compinit:
              ampi completions zsh > ~/.zsh/completions/_ampi
          with fpath=(~/.zsh/completions $fpath) above compinit in ~/.zshrc. Or add this line
          to ~/.zshrc, after compinit:
              source <(ampi completions zsh)
  fish    Save it where fish looks for completions:
              ampi completions fish > ~/.config/fish/completions/ampi.fish
  pwsh    Add this line to $PROFILE:
              ampi completions pwsh | Out-String | Invoke-Expression

Completing a session id or a skill name starts Pi to list them, which takes a moment; every
other completion reads only ampi's own files.

Exit status: 0 on success, 2 on a usage error such as an unknown shell.
`;
}

/**
 * A shell script written as a template literal: the text exactly as written,
 * except that `$\{` stands for a dollar sign and an opening brace, which a
 * template literal would read as a substitution.
 *
 * @param {TemplateStringsArray} strings
 */
const script = (strings) => strings.raw.join("").replaceAll("$\\{", "$" + "{");

const BASH_SCRIPT = script`# ampi completion for bash, from "ampi completions bash".
# Load it from ~/.bashrc with: source <(ampi completions bash)
# Each Tab asks "ampi __complete" for the candidates, so the script never goes stale.
_ampi_complete() {
  local cur=$\{COMP_WORDS[COMP_CWORD]} word line strip i
  local -a words=()
  # Bash splits --name=value at "="; join the pieces again, as ampi reads the word.
  for ((i = 0; i <= COMP_CWORD; i++)); do
    word=$\{COMP_WORDS[i]}
    if ((i > 0)) && [[ $word == "=" || $\{COMP_WORDS[i-1]} == "=" ]]; then
      words[$\{#words[@]}-1]+=$word
    else
      words+=("$word")
    fi
  done
  # What stays in front of the text bash replaces, such as "--mode=".
  if [[ $cur == "=" ]]; then
    strip=$\{words[$\{#words[@]}-1]}
  else
    strip=$\{words[$\{#words[@]}-1]%"$cur"}
  fi
  COMPREPLY=()
  # Keep ampi's order (session ids newest first); bash before 4.4 sorts anyway.
  compopt -o nosort 2>/dev/null
  while IFS= read -r line; do
    case $line in
    :file | :file$'\t'*) compopt -o default; COMPREPLY=(); return ;;
    :directory | :directory$'\t'*) compopt -o dirnames; COMPREPLY=(); return ;;
    "") ;;
    *) COMPREPLY+=("$\{line%%$'\t'*}") ;;
    esac
  done < <(ampi __complete bash -- "$\{words[@]}" 2>/dev/null)
  if [[ -n $strip ]]; then
    COMPREPLY=("$\{COMPREPLY[@]#"$strip"}")
  fi
}
complete -F _ampi_complete ampi
`;

const ZSH_SCRIPT = script`#compdef ampi
# ampi completion for zsh, from "ampi completions zsh".
# Save it as _ampi in a directory on $fpath before compinit runs, or source it after compinit.
# Each Tab asks "ampi __complete" for the candidates, so the script never goes stale.
_ampi() {
  local -a lines entries
  local line value marker prefix
  lines=("$\{(@f)$(ampi __complete zsh -- "$\{(@Q)words[1,CURRENT-1]}" "$\{(Q)PREFIX}" 2>/dev/null)}")
  marker=$\{lines[1]%%$'\t'*}
  if [[ $marker == :file || $marker == :directory ]]; then
    prefix=$\{lines[1]#$marker}
    prefix=$\{prefix#$'\t'}
    [[ -n $prefix ]] && compset -P "$\{(b)prefix}"
    if [[ $marker == :file ]]; then
      _files
    else
      _files -/
    fi
    return
  fi
  for line in $lines; do
    [[ -z $line ]] && continue
    value=$\{line%%$'\t'*}
    if [[ $line == *$'\t'* ]]; then
      entries+=("$\{value//:/\\:}:$\{line#*$'\t'}")
    else
      entries+=("$\{value//:/\\:}")
    fi
  done
  (( $\{#entries} )) && _describe -V -t ampi ampi entries
}
if [[ $\{zsh_eval_context[-1]} == loadautofunc ]]; then
  _ampi "$@"
else
  compdef _ampi ampi
fi
`;

const FISH_SCRIPT = script`# ampi completion for fish, from "ampi completions fish".
# Save it as ~/.config/fish/completions/ampi.fish, or load it with: ampi completions fish | source
# Each Tab asks "ampi __complete" for the candidates, so the script never goes stale.
function __ampi_complete
    set -l token (commandline -ct)
    set -l lines (ampi __complete fish -- (commandline -opc) $token 2>/dev/null)
    set -l marker (string split -m 1 \t -- "$lines[1]")
    switch "$marker[1]"
        case :file :directory
            set -l prefix "$marker[2]"
            set -l rest (string sub -s (math (string length -- "$prefix") + 1) -- "$token")
            if test "$marker[1]" = :file
                printf '%s\n' "$prefix"(__fish_complete_path "$rest")
            else
                printf '%s\n' "$prefix"(__fish_complete_directories "$rest")
            end
        case '*'
            printf '%s\n' $lines
    end
end
complete -c ampi -f -k -a '(__ampi_complete)'
`;

const PWSH_SCRIPT = script`# ampi completion for PowerShell, from "ampi completions pwsh".
# Load it from $PROFILE with: ampi completions pwsh | Out-String | Invoke-Expression
# Each Tab asks "ampi __complete" for the candidates, so the script never goes stale.
Register-ArgumentCompleter -Native -CommandName ampi -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $words = [System.Collections.Generic.List[string]]::new()
    $current = ''
    foreach ($element in $commandAst.CommandElements) {
        if ($element.Extent.StartOffset -gt $cursorPosition) { break }
        if ($element.Extent.EndOffset -ge $cursorPosition -and $words.Count -gt 0) { $current = $wordToComplete; break }
        if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $words.Add($element.Value)
        } else {
            $words.Add($element.Extent.Text)
        }
    }
    $words.Add($current)
    # An empty argument is lost on the way to a batch file (npm's ampi.cmd) and under legacy
    # argument passing; there it is written as a quoted empty string instead.
    $ampi = Get-Command ampi -CommandType Application -ErrorAction Ignore | Select-Object -First 1
    $passing = Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction Ignore
    $batch = $null -ne $ampi -and $ampi.Path -match '\.(cmd|bat)$'
    if ($null -ne $ampi -and ($null -eq $passing -or $passing -eq 'Legacy' -or ($batch -and $passing -ne 'Standard'))) {
        for ($i = 0; $i -lt $words.Count; $i++) { if ($words[$i] -eq '') { $words[$i] = '""' } }
    }
    $lines = @(& ampi __complete pwsh -- @words 2>$null)
    $first = if ($lines.Count -gt 0) { [string]$lines[0] } else { '' }
    if ($first -match '^:(file|directory)(?:\t(.*))?$') {
        $kind = $Matches[1]
        $prefix = [string]$Matches[2]
        $rest = if ($current.StartsWith($prefix)) { $current.Substring($prefix.Length) } else { $current }
        foreach ($result in [System.Management.Automation.CompletionCompleters]::CompleteFilename($rest)) {
            if ($kind -eq 'directory' -and $result.ResultType -ne 'ProviderContainer') { continue }
            [System.Management.Automation.CompletionResult]::new($prefix + $result.CompletionText, $result.ListItemText, $result.ResultType, $result.ToolTip)
        }
        return
    }
    $offered = 0
    foreach ($line in $lines) {
        if ([string]::IsNullOrEmpty($line)) { continue }
        $value, $description = ([string]$line).Split([char]9, 2)
        if ([string]::IsNullOrEmpty($description)) { $description = $value }
        $type = if ($value.StartsWith('-')) { 'ParameterName' } else { 'ParameterValue' }
        [System.Management.Automation.CompletionResult]::new($value, $value, $type, $description)
        $offered++
    }
    # With no result at all PowerShell offers file names, as after a message. The word itself as the
    # only result changes nothing (an empty word becomes a space) and stops that.
    if ($offered -eq 0) {
        $same = if ($current -eq '') { ' ' } else { $current }
        [System.Management.Automation.CompletionResult]::new($same, $same, 'Text', $same)
    }
}
`;

/** @type {Record<string, string>} */
const SCRIPTS = { bash: BASH_SCRIPT, zsh: ZSH_SCRIPT, fish: FISH_SCRIPT, pwsh: PWSH_SCRIPT };

/**
 * The completion script for `shell`.
 *
 * @param {string} shell One of SHELLS.
 * @returns {string}
 */
export function completionScript(shell) {
  const text = SCRIPTS[shell];
  if (text === undefined) throw new Error(`no completion script for ${shell}`);
  return text;
}

/**
 * Run `ampi completions <shell>`.
 *
 * @param {readonly string[]} argv The command line after `completions`.
 * @param {CompletionsHost} host
 * @returns {number} The exit code.
 */
export function runCompletionsCommand(argv, host) {
  /** @param {string} message */
  const usage = (message) => {
    host.log.error(`${message}\n${USAGE_HINT}`);
    return 2;
  };
  /** @type {{ values: { help?: boolean }, positionals: string[] }} */
  let parsed;
  try {
    parsed = /** @type {any} */ (parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (error) {
    return usage(`completions: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.values.help) {
    host.out(formatCompletionsHelp());
    return 0;
  }
  const [shell, ...extra] = parsed.positionals;
  if (shell === undefined) return usage(`completions needs a shell: ${SHELL_LIST}.`);
  if (!SHELLS.includes(shell)) return usage(`completions has no script for "${oneLine(shell)}"; the shells are ${SHELL_LIST}.`);
  if (extra.length > 0) return usage(`completions takes one shell, not ${extra.length + 1}.`);
  host.out(completionScript(shell));
  return 0;
}
