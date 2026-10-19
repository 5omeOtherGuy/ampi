// Shell completion for the `ampi` command (packages/ampi-cli/src/completions.js
// and command-tree.js): the resolver against the command tree with
// hand-written providers; the drift guard, which fails when the router, a
// command module or the help names a command or option the tree lacks; the
// four scripts, syntax-checked by each shell that is installed; and spawned
// `ampi __complete` and `ampi completions` runs in a temporary home and agent
// directory, offline, for session ids, MCP server names, what a static
// completion loads and a Pi package that fails outside the completion.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import {
  AMPI_COMMANDS,
  CONFIG_COMMANDS,
  DEV_COMMANDS,
  formatAmpiHelp,
  GLOBAL_OPTIONS,
  OPTIONS as ARGV_OPTIONS,
  PI_COMMANDS,
  PI_OTHER_OPTIONS,
  PI_VALUE_OPTIONS,
  routeAmpiArgv,
} from "../packages/ampi-cli/src/argv.js";
import { COMMAND_TREE } from "../packages/ampi-cli/src/command-tree.js";
import {
  completionScript,
  formatCompletion,
  formatCompletionsHelp,
  OPTIONS as COMPLETIONS_OPTIONS,
  resolveCompletion,
  runCompleteCommand,
  SHELLS,
} from "../packages/ampi-cli/src/completions.js";
import { OPTIONS as CONFIG_OPTIONS } from "../packages/ampi-cli/src/config.js";
import { OPTIONS as DEV_KEYS_OPTIONS } from "../packages/ampi-cli/src/dev-keys.js";
import { OPTIONS as DOCTOR_OPTIONS } from "../packages/ampi-cli/src/doctor.js";
import { AGENT_ALIASES, AGENTS, DETECT_OPTIONS, formatImportHelp, IMPORT_OPTIONS } from "../packages/ampi-cli/src/import/index.js";
import { ADD_VALUE_OPTIONS, formatMcpHelp } from "../packages/ampi-cli/src/mcp.js";
import { OPTIONS as REVIEW_OPTIONS } from "../packages/ampi-cli/src/review.js";
import { ALIASES as SKILL_ALIASES, COMMANDS as SKILL_COMMANDS, OPTIONS as SKILL_OPTIONS, formatSkillHelp } from "../packages/ampi-cli/src/skill.js";
import { ALIASES as THREAD_ALIASES, OPTIONS as THREAD_OPTIONS } from "../packages/ampi-cli/src/threads.js";
import { ALIASES as TOOL_ALIASES, OPTIONS as TOOL_OPTIONS, formatToolsHelp } from "../packages/ampi-cli/src/tools.js";
import { OPTIONS as TOP_OPTIONS } from "../packages/ampi-cli/src/top.js";
import { OPTIONS as UPDATE_OPTIONS } from "../packages/ampi-cli/src/update.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const guard = path.join(import.meta.dirname, "fixtures", "ampi-cli", "offline-guard.mjs");
const recorder = path.join(import.meta.dirname, "fixtures", "ampi-cli", "module-recorder.mjs");
const failingPi = path.join(import.meta.dirname, "fixtures", "ampi-cli", "failing-pi.mjs");

const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "ampi-cli-completions-")));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(temporary, { recursive: true, force: true });
});

/** Providers that answer from fixed lists and record what was asked. */
function providers({ threadIds = [], skills = [], mcpServers = [] } = {}) {
  const asked = [];
  return {
    asked,
    threadIds: () => {
      asked.push("threadIds");
      return threadIds;
    },
    skills: () => {
      asked.push("skills");
      return skills;
    },
    mcpServers: () => {
      asked.push("mcpServers");
      return mcpServers;
    },
  };
}

/**
 * Complete a command line the way a script sends it: the words split at
 * spaces, the last one under the cursor (empty after a trailing space).
 */
async function complete(line, given = providers()) {
  const words = line.split(" ");
  return resolveCompletion(words.slice(0, -1), words[words.length - 1], COMMAND_TREE, given);
}

/** The candidate values of a completion. */
const values = (completion) => {
  assert.ok("candidates" in completion, `expected candidates, got ${JSON.stringify(completion)}`);
  return completion.candidates.map((candidate) => candidate.value);
};

describe("ampi completion resolver", () => {
  it("completes a top-level prefix to the one command it starts", async () => {
    assert.deepEqual(values(await complete("ampi thr")), ["threads"]);
  });

  it("completes review and top and their options", async () => {
    assert.deepEqual(values(await complete("ampi rev")), ["review"]);
    assert.deepEqual(values(await complete("ampi review -")), [
      "-f",
      "--files",
      "-i",
      "--instructions",
      "-s",
      "--check-scope",
      "-c",
      "--check-filter",
      "--checks-only",
      "--json",
      "--thinking",
      "--title",
      "-l",
      "--label",
      "--no-archive-after-execute",
      "-h",
      "--help",
    ]);
    assert.deepEqual(values(await complete("ampi review --thinking ")), ["low", "high"]);
    assert.deepEqual(await complete("ampi review -f "), { path: "file", prefix: "" });
    assert.deepEqual(await complete("ampi review --check-scope "), { path: "directory", prefix: "" });
    assert.deepEqual(values(await complete("ampi top -")), ["--json", "--stream-jsonl", "-h", "--help"]);
  });

  it("offers the commands for an empty word, without the hidden __complete or any alias", async () => {
    const offered = values(await complete("ampi "));
    for (const name of ["help", "version", "threads", "last", "usage", "review", "tools", "skill", "mcp", "config", "app", "top", "doctor", "update", "dev", "completions"]) {
      assert.ok(offered.includes(name), `${name} is offered`);
    }
    for (const name of ["install", "remove", "uninstall", "list", "auth"]) assert.ok(offered.includes(name), `Pi's ${name} is offered`);
    for (const hidden of ["__complete", "tool", "skills", "up"]) assert.ok(!offered.includes(hidden), `${hidden} is not offered`);
    assert.equal(new Set(offered).size, offered.length);
  });

  it("offers an alias only when no command name matches", async () => {
    assert.deepEqual(values(await complete("ampi threads l")), ["list", "label"]);
    assert.deepEqual(values(await complete("ampi threads f")), ["find"]);
    assert.deepEqual(values(await complete("ampi threads ls")), ["ls"]);
    assert.deepEqual(values(await complete("ampi tool")), ["tools"]);
  });

  it("resolves an alias like its command for the words after it", async () => {
    assert.deepEqual(values(await complete("ampi tool ls --j")), ["--json"]);
    const given = providers({ skills: [{ value: "pdf-tools", description: "Read PDFs" }, { value: "review", description: "Review a change" }] });
    assert.deepEqual(values(await complete("ampi skill rm ", given)), ["pdf-tools", "review"]);
    assert.deepEqual(given.asked, ["skills"]);
    assert.deepEqual(values(await complete("ampi skills info p", given)), ["pdf-tools"]);
  });

  it("asks for skill names only where a skill name goes", async () => {
    const given = providers({ skills: [{ value: "pdf-tools" }] });
    assert.deepEqual(values(await complete("ampi skill add ", given)), []);
    assert.deepEqual(values(await complete("ampi skill list ", given)), []);
    assert.deepEqual(given.asked, []);
  });

  it("completes nested subcommands of threads import", async () => {
    assert.deepEqual(values(await complete("ampi threads import op")), ["opencode"]);
    assert.deepEqual(values(await complete("ampi threads import ")), ["detect", "claude", "codex", "opencode"]);
    assert.deepEqual(values(await complete("ampi threads import claude-code --re")), ["--reimport"]);
    assert.deepEqual(values(await complete("ampi threads import codex --co")), ["--codex-dir"]);
  });

  it("offers only the options of the subcommand given", async () => {
    assert.deepEqual(values(await complete("ampi threads list --a")), ["--all", "--archived"]);
    assert.deepEqual(values(await complete("ampi threads search --")), ["--limit", "--json", "--help"]);
  });

  it("reads options right after threads as list's", async () => {
    assert.deepEqual(values(await complete("ampi threads --a")), ["--all", "--archived"]);
    assert.deepEqual(values(await complete("ampi threads --json --li")), ["--limit"]);
  });

  it("offers short spellings after a lone - and long names after --", async () => {
    assert.deepEqual(values(await complete("ampi threads delete abc -")), ["-y", "--yes", "-h", "--help"]);
    assert.deepEqual(values(await complete("ampi threads delete abc --")), ["--yes", "--help"]);
    assert.deepEqual(values(await complete("ampi -n")), ["-n", "-nbt", "-nt", "-ne", "-ns", "-np", "-nc", "-na"]);
  });

  it("does not offer an option again unless it repeats", async () => {
    assert.deepEqual(values(await complete("ampi threads list --all --a")), ["--archived"]);
    assert.deepEqual(values(await complete("ampi --label x --lab")), ["--label"]);
    assert.deepEqual(values(await complete("ampi mcp add docs --header a=b --he")), ["--header", "--help"]);
  });

  it("completes option values by kind", async () => {
    assert.deepEqual(values(await complete("ampi -m h")), ["high"]);
    assert.deepEqual(values(await complete("ampi -m ")), ["low", "medium", "high", "ultra", "free"]);
    assert.deepEqual(values(await complete("ampi -m j")), []);
    assert.deepEqual(values(await complete("ampi --mode j")), ["json"]);
    assert.deepEqual(values(await complete("ampi --mode=h")), ["--mode=high"]);
    assert.deepEqual(values(await complete("ampi --thinking x")), ["xhigh"]);
    assert.deepEqual(values(await complete("ampi --tui-mode ")), ["fullscreen", "regular"]);
    assert.deepEqual(values(await complete("ampi tools list -m u")), ["ultra"]);
    assert.deepEqual(values(await complete("ampi threads color 019a3c g")), ["green", "gray"]);
    assert.deepEqual(values(await complete("ampi threads color 019a3c n")), ["none"]);
    assert.deepEqual(values(await complete("ampi completions ")), ["bash", "zsh", "fish", "pwsh"]);
  });

  it("takes the next word as an option's value, not as a command", async () => {
    assert.deepEqual(values(await complete("ampi --title threads ")), []);
    assert.deepEqual(values(await complete("ampi --log-level debug thr")), ["threads"]);
    assert.deepEqual(values(await complete("ampi --log-level=debug --no-color thr")), ["threads"]);
    assert.deepEqual(values(await complete("ampi --log-level ")), ["error", "warn", "info", "debug"]);
  });

  it("offers no command after an option that is not global, and nothing after a message", async () => {
    assert.deepEqual(values(await complete("ampi -m high thr")), []);
    assert.deepEqual(values(await complete("ampi fix the ")), []);
    assert.deepEqual(values(await complete("ampi fix --")), []);
    assert.deepEqual(values(await complete("ampi threads rename abc title ")), []);
  });

  it("offers nothing after --, and nothing after one of Pi's own commands", async () => {
    assert.deepEqual(values(await complete("ampi -- ")), []);
    assert.deepEqual(values(await complete("ampi -- thr")), []);
    assert.deepEqual(values(await complete("ampi mcp add files -- np")), []);
    assert.deepEqual(values(await complete("ampi install ")), []);
    assert.deepEqual(values(await complete("ampi install --")), []);
    assert.deepEqual(values(await complete("ampi config ")), ["keymap", "edit"]);
    assert.deepEqual(values(await complete("ampi config --local ")), []);
    assert.deepEqual(values(await complete("ampi dev ")), ["keys"]);
    assert.deepEqual(values(await complete("ampi dev keys --")), ["--raw", "--no-keymap", "--help"]);
    assert.deepEqual(values(await complete("ampi dev fix ")), []);
    assert.deepEqual(values(await complete("ampi update --extensions ")), []);
    assert.deepEqual(values(await complete("ampi mcp --pi-help ")), []);
    assert.deepEqual(values(await complete("ampi tools --json ")), ["list", "show"]);
    assert.deepEqual(values(await complete("ampi skill --json l")), ["list"]);
  });

  it("completes the values of tools' and skill's options before the subcommand", async () => {
    assert.deepEqual(values(await complete("ampi tools -m ")), ["low", "medium", "high", "ultra", "free"]);
    assert.deepEqual(await complete("ampi skill --target "), { path: "directory", prefix: "" });
  });

  it("asks the shell for a path for file and directory values", async () => {
    assert.deepEqual(await complete("ampi --mcp-config "), { path: "file", prefix: "" });
    assert.deepEqual(await complete("ampi --log-file=./lo"), { path: "file", prefix: "--log-file=" });
    assert.deepEqual(await complete("ampi --session-dir "), { path: "directory", prefix: "" });
    assert.deepEqual(await complete("ampi skill add ./x --target "), { path: "directory", prefix: "" });
    assert.deepEqual(await complete("ampi threads import claude --claude-dir "), { path: "directory", prefix: "" });
  });

  it("completes session ids where an id goes, Pi's --session and --fork included", async () => {
    const ids = [
      { value: "019b0000-0000-7000-8000-000000000002", description: "Newer" },
      { value: "019a0000-0000-7000-8000-000000000001", description: "Older" },
    ];
    for (const line of ["ampi threads continue ", "ampi threads c ", "ampi threads usage ", "ampi --session ", "ampi --fork "]) {
      assert.deepEqual(values(await complete(line, providers({ threadIds: ids }))), [ids[0].value, ids[1].value], line);
    }
    assert.deepEqual(values(await complete("ampi threads markdown 019a", providers({ threadIds: ids }))), [ids[1].value]);
    const given = providers({ threadIds: ids });
    assert.deepEqual(values(await complete("ampi --session-id ", given)), []);
    assert.deepEqual(values(await complete("ampi threads continue 019a ", given)), []);
    assert.deepEqual(given.asked, []);
  });

  it("completes MCP server names for the commands that take one", async () => {
    const servers = [{ value: "files" }, { value: "search" }];
    for (const line of ["ampi mcp remove ", "ampi mcp doctor ", "ampi mcp approve ", "ampi mcp oauth login ", "ampi mcp oauth logout ", "ampi mcp oauth status "]) {
      assert.deepEqual(values(await complete(line, providers({ mcpServers: servers }))), ["files", "search"], line);
    }
    const given = providers({ mcpServers: servers });
    assert.deepEqual(values(await complete("ampi mcp add ", given)), []);
    assert.deepEqual(given.asked, []);
  });

  it("offers nothing for a value whose provider fails", async () => {
    const failing = {
      threadIds: () => {
        throw new Error("no Pi");
      },
      skills: async () => {
        throw new Error("unreadable");
      },
      mcpServers: () => [],
    };
    assert.deepEqual(await complete("ampi threads continue ", failing), { candidates: [] });
    assert.deepEqual(await complete("ampi skill info ", failing), { candidates: [] });
  });

  it("never offers what is hidden, though it still resolves", async () => {
    assert.deepEqual(values(await complete("ampi app --")), ["--open", "--help"]);
    assert.ok(!values(await complete("ampi --s")).includes("--settings-file"));
    assert.deepEqual(values(await complete("ampi --settings-file x --tim")), ["--timings"]);
    assert.deepEqual(values(await complete("ampi threads new --")), ["--json", "--help"]);
    assert.deepEqual(values(await complete("ampi threads new --visibility=")), []);
    assert.deepEqual(values(await complete("ampi __")), []);
    assert.deepEqual(values(await complete("ampi mcp ")), ["add", "remove", "list", "doctor", "approve", "oauth"]);
    assert.deepEqual(values(await complete("ampi mcp login ", providers({ mcpServers: [{ value: "docs" }] }))), ["docs"]);
  });
});

describe("ampi __complete output", () => {
  it("prints one candidate per line, a tab before a description, and the path marker alone", () => {
    assert.equal(formatCompletion({ candidates: [{ value: "high", description: "Deeper" }, { value: "--json" }] }), "high\tDeeper\n--json\n");
    assert.equal(formatCompletion({ path: "file", prefix: "" }), ":file\n");
    assert.equal(formatCompletion({ path: "directory", prefix: "--session-dir=" }), ":directory\t--session-dir=\n");
  });

  it("keeps descriptions to one line without control characters and drops values a shell could misread", () => {
    const text = formatCompletion({
      candidates: [
        { value: "a1", description: "two\nlines\tand \u001b[31mred\u001b[0m" },
        { value: "a1", description: "again" },
        { value: "has space" },
        { value: "semi;colon" },
        { value: ":file" },
        { value: "#hash" },
        { value: "@splat" },
        { value: "~tilde" },
        { value: "=equals" },
        { value: "%percent" },
        { value: "--%" },
        { value: "ok.name:1" },
        { value: "b2", description: `${"x".repeat(200)}` },
      ],
    });
    assert.equal(text, `a1\ttwo lines and [31mred [0m\nok.name:1\nb2\t${"x".repeat(79)}…\n`);
  });

  it("answers a malformed request with nothing and exit 0", async () => {
    for (const argv of [[], ["bash"], ["tcsh", "--", "ampi", ""], ["bash", "ampi", ""], ["bash", "--", "ampi"]]) {
      let out = "";
      const code = await runCompleteCommand(argv, { out: (text) => (out += text), providers: providers() });
      assert.equal(code, 0, argv.join(" "));
      assert.equal(out, "", argv.join(" "));
    }
  });
});

/** The subcommands a help's Usage lines name after `ampi <command>`. */
function usageSubcommands(help, command) {
  const block = help.slice(help.indexOf("Usage:"), help.indexOf("\n\n", help.indexOf("Usage:")));
  const words = new Set();
  const pattern = new RegExp(`ampi ${command} ([a-z][a-z|-]*)(?: ([a-z][a-z|]*))?`, "g");
  for (const match of block.matchAll(pattern)) {
    for (const word of match[1].split("|")) words.add(word);
    if (match[2] !== undefined) for (const word of match[2].split("|")) words.add(`${match[1]} ${word}`);
  }
  return [...words];
}

/**
 * Everything the router, the command modules and the help name that the tree
 * lacks or describes differently, one line each; empty when they agree.
 */
function findTreeDrift(tree) {
  const problems = [];
  /** @param {string[]} names */
  const nodeAt = (names) => {
    let node = tree;
    for (const name of names) {
      node = node?.commands.find((child) => child.name === name);
      if (node === undefined) {
        problems.push(`ampi ${names.join(" ")}: the command is missing`);
        return undefined;
      }
    }
    return node;
  };
  const label = (names) => ["ampi", ...names].join(" ");
  /** Compare a parseArgs options table with the options of the node at `names`. */
  const compareTable = (names, table, { repeat = true } = {}) => {
    const node = nodeAt(names);
    if (node === undefined) return;
    for (const [name, spec] of Object.entries(table)) {
      const option = node.options.find((candidate) => candidate.name === `--${name}`);
      if (option === undefined) {
        problems.push(`${label(names)}: --${name} is missing`);
        continue;
      }
      const takesValue = spec.type === "string" || spec.value === true;
      if (option.value !== takesValue) problems.push(`${label(names)}: --${name} ${takesValue ? "takes" : "takes no"} value`);
      const shorts = [spec.short, ...(Array.isArray(spec.shorts) ? spec.shorts : [])].filter(Boolean).map((short) => `-${short}`);
      for (const short of shorts) if (!option.short.includes(short)) problems.push(`${label(names)}: ${short} of --${name} is missing`);
      if (repeat && (spec.multiple === true) !== option.repeat) problems.push(`${label(names)}: --${name} ${spec.multiple ? "repeats" : "does not repeat"}`);
    }
  };
  const compareCommands = (names, wanted) => {
    const node = nodeAt(names);
    for (const name of wanted) {
      if (node !== undefined && !node.commands.some((child) => child.name === name)) problems.push(`${label([...names, name])}: the command is missing`);
    }
  };
  const compareAliases = (names, aliases) => {
    const node = nodeAt(names);
    for (const [alias, target] of Object.entries(aliases)) {
      const child = node?.commands.find((candidate) => candidate.name === target);
      if (child === undefined) problems.push(`${label([...names, target])}: the command is missing (alias ${alias})`);
      else if (!child.aliases.includes(alias)) problems.push(`${label([...names, target])}: the alias ${alias} is missing`);
    }
  };

  // The router.
  for (const [name, aliases] of Object.entries(AMPI_COMMANDS)) {
    const node = tree.commands.find((child) => child.name === name);
    if (node === undefined) problems.push(`ampi ${name}: the command is missing`);
    else for (const alias of aliases) if (!node.aliases.includes(alias)) problems.push(`ampi ${name}: the alias ${alias} is missing`);
  }
  compareCommands([], [...PI_COMMANDS]);
  compareCommands(["config"], [...CONFIG_COMMANDS]);
  compareCommands(["dev"], [...DEV_COMMANDS]);
  compareTable([], ARGV_OPTIONS);
  compareTable([], PI_VALUE_OPTIONS, { repeat: false });
  compareTable([], Object.fromEntries(Object.entries(PI_OTHER_OPTIONS).map(([name, spec]) => [name, { value: spec.value === true, shorts: spec.short ?? [] }])), { repeat: false });
  for (const option of tree.options) {
    const name = option.name.slice(2);
    if (option.global !== GLOBAL_OPTIONS.has(name)) problems.push(`ampi: --${name} ${GLOBAL_OPTIONS.has(name) ? "is" : "is not"} global`);
  }
  // `ampi --help`: the command words of its command sections and the spellings of its Options section.
  const help = formatAmpiHelp();
  const section = (title) => {
    const start = help.indexOf(`\n${title}\n`);
    if (start === -1) return "";
    const end = help.indexOf("\n\n", help.indexOf("\n\n", start) + 2);
    return help.slice(start, end === -1 ? undefined : end);
  };
  for (const title of ["Commands:", "Developer commands:"]) {
    for (const match of section(title).matchAll(/^ {2}([a-z][\w-]*(?:, [a-z][\w-]*)*)(?: ([a-z][a-z|-]*))?/gm)) {
      const [first, ...aliases] = match[1].split(", ");
      const node = nodeAt([first]);
      if (node === undefined) continue;
      for (const alias of aliases) if (!node.aliases.includes(alias)) problems.push(`ampi ${first}: the alias ${alias} from the help is missing`);
      for (const word of match[2]?.split("|") ?? []) {
        if (!node.commands.some((child) => child.name === word)) problems.push(`ampi ${first} ${word}: the command from the help is missing`);
      }
    }
  }
  const optionsSection = help.slice(help.indexOf("\nOptions:\n"), help.indexOf("\n\n  Every other option"));
  for (const match of optionsSection.matchAll(/^ {2}(-[^\n]*)$/gm)) {
    for (const spelling of match[1].replace(/ [<[].*$/, "").split(", ")) {
      if (spelling === "--") continue;
      if (!tree.options.some((option) => option.name === spelling || option.short.includes(spelling))) problems.push(`ampi: ${spelling} from the help is missing`);
    }
  }
  // The command modules.
  compareAliases(["threads"], THREAD_ALIASES);
  compareCommands(["threads"], Object.keys(THREAD_OPTIONS));
  for (const [name, table] of Object.entries(THREAD_OPTIONS)) compareTable(["threads", name], table);
  compareTable(["usage"], THREAD_OPTIONS.usage);
  nodeAt(["last"]);
  compareCommands(["threads", "import"], ["detect", ...Object.keys(AGENTS)]);
  compareAliases(["threads", "import"], AGENT_ALIASES);
  compareTable(["threads", "import", "detect"], DETECT_OPTIONS);
  for (const [name, agent] of Object.entries(AGENTS)) compareTable(["threads", "import", name], { ...IMPORT_OPTIONS, [agent.dirOption]: { type: "string" } });
  compareCommands(["threads", "import"], usageSubcommands(formatImportHelp(), "threads import"));
  compareAliases(["tools"], TOOL_ALIASES);
  compareCommands(["tools"], usageSubcommands(formatToolsHelp(), "tools"));
  compareTable(["tools"], TOOL_OPTIONS);
  for (const name of usageSubcommands(formatToolsHelp(), "tools")) compareTable(["tools", name], TOOL_OPTIONS);
  compareAliases(["skill"], SKILL_ALIASES);
  compareTable(["skill"], SKILL_OPTIONS);
  compareCommands(["skill"], [...Object.keys(SKILL_COMMANDS), ...usageSubcommands(formatSkillHelp(), "skill")]);
  for (const [name, spec] of Object.entries(SKILL_COMMANDS)) {
    compareTable(["skill", name], Object.fromEntries([...spec.options, "help"].map((option) => [option, SKILL_OPTIONS[option]])));
  }
  for (const words of usageSubcommands(formatMcpHelp(), "mcp")) compareCommands(["mcp", ...words.split(" ").slice(0, -1)], words.split(" ").slice(-1));
  compareTable(["mcp", "add"], Object.fromEntries([...ADD_VALUE_OPTIONS].map((name) => [name, { type: "string" }])), { repeat: false });
  compareCommands(["config"], Object.keys(CONFIG_OPTIONS));
  for (const [name, table] of Object.entries(CONFIG_OPTIONS)) compareTable(["config", name], table);
  compareTable(["doctor"], DOCTOR_OPTIONS);
  compareTable(["review"], REVIEW_OPTIONS);
  compareTable(["top"], TOP_OPTIONS);
  compareTable(["update"], UPDATE_OPTIONS);
  compareTable(["dev", "keys"], DEV_KEYS_OPTIONS);
  compareTable(["completions"], COMPLETIONS_OPTIONS);
  // The other way round: a command the tree offers exists.
  for (const node of tree.commands) {
    if (node.hidden === true) continue;
    const routes = [[node.name], ...node.commands.map((child) => [node.name, child.name])].map((argv) => routeAmpiArgv(argv).command);
    if (!routes.some((command) => command !== "pi")) problems.push(`ampi ${node.name}: offered, but starts Pi with a message`);
  }
  return problems;
}

describe("ampi command tree", () => {
  it("covers every command and option of the router, the command modules and the help", () => {
    assert.deepEqual(findTreeDrift(COMMAND_TREE), []);
  });

  it("names the entry a tree without one option lacks, or a tree with one option changed", () => {
    const copy = structuredClone(COMMAND_TREE);
    const list = copy.commands.find((node) => node.name === "threads").commands.find((node) => node.name === "list");
    list.options = list.options.filter((option) => option.name !== "--archived");
    const doctor = copy.commands.find((node) => node.name === "doctor");
    doctor.options = doctor.options.map((option) => (option.name === "--json" ? { ...option, value: true } : option));
    copy.options = copy.options.filter((option) => option.name !== "--no-builtin-tools");
    assert.deepEqual(findTreeDrift(copy), ["ampi: --no-builtin-tools is missing", "ampi threads list: --archived is missing", "ampi doctor: --json takes no value"]);
  });

  it("finds a command the tree offers that does not exist", () => {
    const copy = structuredClone(COMMAND_TREE);
    copy.commands.push({ name: "frobnicate", aliases: [], description: "", args: [], commands: [], options: [] });
    assert.deepEqual(findTreeDrift(copy), ["ampi frobnicate: offered, but starts Pi with a message"]);
  });

  it("hides exactly the internal and refused commands and options", () => {
    const hidden = [];
    const walk = (node, names) => {
      for (const option of node.options) if (option.hidden === true) hidden.push([...names, option.name].join(" "));
      for (const child of node.commands) {
        if (child.hidden === true) hidden.push([...names, child.name].join(" "));
        walk(child, [...names, child.name]);
      }
    };
    walk(COMMAND_TREE, []);
    assert.deepEqual(
      hidden.sort(),
      ["__complete", "mcp login", "mcp logout", "mcp remote", "app --worker", "--settings-file", "threads new --visibility"].sort(),
    );
  });

  it("is plain JSON", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(COMMAND_TREE)), COMMAND_TREE);
  });
});

/** Whether `command` runs, for the shell syntax checks. */
const installed = (command) => spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0;

const SYNTAX_CHECKS = {
  bash: (file) => ["bash", ["-n", file]],
  zsh: (file) => ["zsh", ["-n", file]],
  fish: (file) => ["fish", ["--no-execute", file]],
  pwsh: (file) => [
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput((Get-Content -Raw -LiteralPath '${file}'), [ref]$null, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { $_.ToString() }; exit 1 }`,
    ],
  ],
};

describe("ampi completion scripts", () => {
  const scripts = mkdtempSync(path.join(temporary, "scripts-"));
  for (const shell of ["bash", "zsh", "fish", "pwsh"]) {
    const command = shell;
    it(`${shell}: asks ampi __complete ${shell} and registers the ampi command`, () => {
      const text = completionScript(shell);
      assert.ok(text.includes(`ampi __complete ${shell} --`), text);
      assert.match(text, /(?:complete -F \S+ ampi|compdef _ampi ampi|complete -c ampi|-CommandName ampi)/);
    });

    it(`${shell}: passes the shell's syntax check`, (t) => {
      if (!installed(command)) {
        t.skip(`${command} is not installed`);
        return;
      }
      const file = path.join(scripts, `ampi.${shell}`);
      writeFileSync(file, completionScript(shell));
      const [program, args] = SYNTAX_CHECKS[shell](file);
      const result = spawnSync(program, args, { encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    });
  }
});

/** Spawn the command in `cwd` with a temporary home and agent directory, offline. */
function runBin(args, { cwd = temporary, home, agentDir, env = {}, preload = [] } = {}) {
  return spawnSync(process.execPath, [...preload.flatMap((file) => ["--import", file]), bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ...env },
  });
}

/** A fresh home and agent directory, and a project directory. */
function sandbox(name) {
  const root = path.join(temporary, name);
  const dirs = { home: path.join(root, "home"), agentDir: path.join(root, "agent"), project: path.join(root, "project") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
}

describe("ampi completions", () => {
  it("prints the script for each shell and exits 0", () => {
    const { home, agentDir } = sandbox("scripts");
    for (const shell of SHELLS) {
      const result = runBin(["completions", shell], { home, agentDir });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, completionScript(shell));
      assert.equal(result.stderr, "");
    }
  });

  it("exits 2 with the four shells listed for an unknown shell or none", () => {
    const { home, agentDir } = sandbox("usage");
    for (const args of [["completions", "tcsh"], ["completions"], ["completions", "powershell"]]) {
      const result = runBin(args, { home, agentDir });
      assert.equal(result.status, 2, args.join(" "));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^ampi: completions .*bash, zsh, fish or pwsh\.\n/);
    }
  });

  it("prints its help, with each shell's installation, and exits 0", () => {
    const { home, agentDir } = sandbox("help");
    const result = runBin(["completions", "--help"], { home, agentDir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, formatCompletionsHelp());
    for (const line of [
      "source <(ampi completions bash)",
      "ampi completions zsh > ~/.zsh/completions/_ampi",
      "ampi completions fish > ~/.config/fish/completions/ampi.fish",
      "ampi completions pwsh | Out-String | Invoke-Expression",
    ]) {
      assert.ok(result.stdout.includes(line), line);
    }
  });
});

describe("ampi __complete, spawned", () => {
  it("lists this directory's sessions newest first, with their titles", () => {
    const { home, agentDir, project } = sandbox("sessions");
    const other = path.join(temporary, "sessions", "elsewhere");
    mkdirSync(other, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const message = (role, text, iso) =>
      role === "user"
        ? { role, content: text, timestamp: Date.parse(iso) }
        : {
            role,
            content: [{ type: "text", text }],
            api: "faux",
            provider: "faux",
            model: "faux-1",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.parse(iso),
          };
    const write = (cwd, id, iso, text, name) => {
      mock.timers.setTime(Date.parse(iso));
      const manager = pi.SessionManager.create(cwd, undefined, { id });
      manager.appendMessage(message("user", text, iso));
      manager.appendMessage(message("assistant", "Done.", iso));
      if (name) manager.appendSessionInfo(name);
    };
    mock.timers.enable({ apis: ["Date"], now: 0 });
    try {
      // The older session first, so the order printed is the listing's, not the files'.
      write(project, "019a0000-aaaa-7000-8000-000000000001", "2026-10-17T09:00:00.000Z", "Rename the parser", "Parser \u001b[1mrename\u001b[0m");
      write(project, "019a0000-aaaa-7000-8000-000000000002", "2026-10-18T09:00:00.000Z", "Fix the build\nscripts", undefined);
      write(other, "019a0000-bbbb-7000-8000-000000000003", "2026-10-18T10:00:00.000Z", "Elsewhere", undefined);
    } finally {
      mock.timers.reset();
    }
    const result = runBin(["__complete", "bash", "--", "ampi", "threads", "continue", ""], { cwd: project, home, agentDir });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "019a0000-aaaa-7000-8000-000000000002\tFix the build scripts\n019a0000-aaaa-7000-8000-000000000001\tParser [1mrename[0m\n");
  });

  it("lists the MCP servers of the user's and the project's mcp.json without connecting any", () => {
    const { home, agentDir, project } = sandbox("mcp");
    writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { files: { command: "true" }, search: { url: "http://127.0.0.1:9/mcp" } } }));
    mkdirSync(path.join(project, ".pi"));
    // `search` only overrides the user's server; `tools` is the project's own.
    writeFileSync(path.join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { search: { enabled: false }, tools: { command: "true" } } }));
    const log = path.join(temporary, "mcp", "guard.log");
    writeFileSync(log, "");
    for (const words of [["mcp", "doctor", ""], ["mcp", "oauth", "status", ""]]) {
      const result = runBin(["__complete", "zsh", "--", "ampi", ...words], { cwd: project, home, agentDir, env: { AMPI_TEST_GUARD_LOG: log }, preload: [guard] });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, "files\tMCP server in mcp.json\nsearch\tMCP server in mcp.json\ntools\tMCP server in this project's .pi/mcp.json\n");
    }
    assert.equal(readFileSync(log, "utf8"), "");
  });

  it("loads no Pi package for a static completion", () => {
    const { home, agentDir } = sandbox("static");
    const log = path.join(temporary, "static", "modules.log");
    for (const words of [["thr"], ["threads", "list", "--a"], ["-m", ""], ["--mcp-config", ""], ["threads", "import", ""]]) {
      writeFileSync(log, "");
      const result = runBin(["__complete", "fish", "--", "ampi", ...words], { home, agentDir, env: { AMPI_TEST_MODULE_LOG: log }, preload: [recorder] });
      assert.equal(result.status, 0, words.join(" "));
      assert.notEqual(result.stdout, "", words.join(" "));
      const modules = readFileSync(log, "utf8").split("\n").filter(Boolean);
      assert.ok(modules.some((url) => url.endsWith("/command-tree.js")), "the recorder sees the command's modules");
      assert.deepEqual(
        modules.filter((url) => url.includes("@earendil-works/")),
        [],
        words.join(" "),
      );
    }
  });

  it("exits 0 with nothing on stderr when Pi rejects a promise or throws outside the completion", () => {
    const { home, agentDir, project } = sandbox("failing-pi");
    for (const failure of ["reject", "throw"]) {
      const result = runBin(["__complete", "bash", "--", "ampi", "skill", "info", ""], {
        cwd: project,
        home,
        agentDir,
        env: { AMPI_TEST_PI_FAILURE: failure },
        preload: [failingPi],
      });
      assert.equal(result.status, 0, failure);
      assert.equal(result.stderr, "", failure);
      assert.equal(result.stdout, "", failure);
    }
  });

  it("exits 0 with nothing on stderr even when the logging settings are invalid", () => {
    const { home, agentDir } = sandbox("quiet");
    const result = runBin(["__complete", "bash", "--", "ampi", "thr"], { home, agentDir, env: { AMPI_LOG_LEVEL: "loud" } });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "threads\tCreate, list, open, print, change, delete or import sessions\n");
  });
});
