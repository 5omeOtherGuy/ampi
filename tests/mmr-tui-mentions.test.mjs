// Mentions in ampi-tui's prompt: the autocomplete rows for `@`, `@:` and `@@`,
// the commits `@:` reads from git, the git-ignored paths
// ampi.fuzzy.alwaysIncludePaths adds to `@`, the Mention Thread picker that
// `@@` and `thread.mention` open, and the hint read_session gives the model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

// The scratch repository and the code under test must not read the
// developer's git configuration, nor a repository named by inherited GIT_*
// variables. Each test file runs in its own process.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) delete process.env[name];
}
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = devNull;

let mentions;
let registry;
before(async () => {
  mentions = await importSource("extensions/ampi-tui/editor/mentions.ts");
  registry = await importSource("extensions/ampi-core/command-registry.ts");
});

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const signal = new AbortController().signal;
const dim = (text) => `<dim>${text}</dim>`;

/** Pi's file provider for a project with `src/main.ts`, `src/` and `README.md`. */
function piFiles() {
  const calls = [];
  const rows = [
    { value: "@src/main.ts", label: "main.ts", description: "src/main.ts" },
    { value: "@src/", label: "src/", description: "src" },
    { value: "@README.md", label: "README.md", description: "README.md" },
  ];
  return {
    calls,
    rows,
    async getSuggestions(lines, line, col) {
      calls.push(lines[line].slice(0, col));
      const token = /@\S*$/.exec(lines[line].slice(0, col))?.[0];
      if (token === undefined) return null;
      const query = token.slice(1).toLowerCase();
      const items = rows.filter((row) => row.value.toLowerCase().includes(query));
      return items.length > 0 ? { items, prefix: token } : null;
    },
    applyCompletion(lines, line, col, item, prefix) {
      calls.push(`apply ${item.value}`);
      const text = lines[line];
      const next = [...lines];
      next[line] = `${text.slice(0, col - prefix.length)}${item.value} ${text.slice(col)}`;
      return { lines: next, cursorLine: line, cursorCol: col - prefix.length + item.value.length + 1 };
    },
  };
}

const COMMITS = [
  { sha: "b517caf", subject: "Add the parser", time: new Date(NOW - 5 * MINUTE) },
  { sha: "a1c0d3e", subject: "init demo", time: new Date(NOW - 3 * DAY) },
];

function provider({ commits = COMMITS, base = piFiles(), now = () => NOW } = {}) {
  const typed = [];
  let reads = 0;
  const options = {
    listCommits: async () => {
      reads += 1;
      return commits;
    },
    now,
    dim,
    typeKey: (char) => typed.push(char),
  };
  const wrapped = mentions.createMmrMentionProvider(base, options);
  return { wrapped, base, typed, options, reads: () => reads };
}

/** The suggestions with the cursor at the end of `text`. */
function suggest(wrapped, text, force = false) {
  return wrapped.getSuggestions([text], 0, text.length, { signal, force });
}

describe("ampi-tui mentions: autocomplete rows", () => {
  it("adds the commit and thread hints, dim, under Pi's file and directory rows for a bare @", async () => {
    const { wrapped, base } = provider();
    const result = await suggest(wrapped, "look at @");
    assert.equal(result.prefix, "@");
    assert.deepEqual(result.items.slice(0, 3), base.rows, "Pi's rows come first, unchanged");
    assert.deepEqual(
      result.items.slice(3).map((item) => [item.value, item.label]),
      [
        ["@:", "<dim>@: mention a commit</dim>"],
        ["@@", "<dim>@@ mention a thread</dim>"],
      ],
    );
  });

  it("shows as many of Pi's rows as leave both hints in the list's first rows", async () => {
    const base = piFiles();
    const wrapped = mentions.createMmrMentionProvider(base, { ...provider().options, visibleRows: () => 4 });
    assert.deepEqual(
      (await suggest(wrapped, "@")).items.map((item) => item.value),
      ["@src/main.ts", "@src/", "@:", "@@"],
    );
    assert.equal((await suggest(wrapped, "@r")).items.length, 3, "a typed name keeps every row Pi found");
  });

  it("shows the hints alone when Pi finds no files", async () => {
    const { wrapped } = provider({ base: { ...piFiles(), getSuggestions: async () => null } });
    const result = await suggest(wrapped, "@");
    assert.deepEqual(
      result.items.map((item) => item.value),
      ["@:", "@@"],
    );
  });

  it("passes Pi's rows through without hints once a file name is typed, and leaves other text to Pi", async () => {
    const { wrapped, base } = provider();
    const result = await suggest(wrapped, "@ma");
    assert.deepEqual(result, { items: [base.rows[0]], prefix: "@ma" });
    assert.equal(await suggest(wrapped, "plain words"), null);
    assert.deepEqual(base.calls, ["@ma", "plain words"]);
    assert.deepEqual(wrapped.triggerCharacters, [":"], "typing : after @ asks for rows");
  });

  it("offers the thread hint for @@ itself and no rows after it", async () => {
    const { wrapped, base } = provider();
    const result = await suggest(wrapped, "@@", true);
    assert.deepEqual(
      result.items.map((item) => item.value),
      ["@@"],
    );
    assert.equal(await suggest(wrapped, "@@x"), null);
    assert.deepEqual(base.calls, [], "neither asks Pi for files");
  });

  it("picking a hint leaves the @ and then types its second character", async () => {
    const { wrapped, typed } = provider();
    const { items } = await suggest(wrapped, "see @");
    const commitHint = items.find((item) => item.value === "@:");
    const applied = wrapped.applyCompletion(["see @"], 0, 5, commitHint, "@");
    assert.deepEqual(applied, { lines: ["see @"], cursorLine: 0, cursorCol: 5 });
    assert.deepEqual(typed, [], "only after the editor has closed its list");
    await settle();
    assert.deepEqual(typed, [":"]);
    const threadHint = (await suggest(wrapped, "@@")).items[0];
    assert.deepEqual(wrapped.applyCompletion(["x @@ y"], 0, 4, threadHint, "@@"), { lines: ["x @ y"], cursorLine: 0, cursorCol: 3 });
    await settle();
    assert.deepEqual(typed, [":", "@"]);
  });

  it("shows no rows for an @ request that finishes while the Mention Thread picker is open", async () => {
    let open = false;
    let release;
    const base = { ...piFiles(), getSuggestions: () => new Promise((resolve) => (release = resolve)) };
    const wrapped = mentions.createMmrMentionProvider(base, { ...provider().options, suppressed: () => open });
    const pending = suggest(wrapped, "see @");
    open = true;
    release({ items: piFiles().rows, prefix: "@" });
    assert.equal(await pending, null);
    assert.equal(await suggest(wrapped, "@:"), null, "nor any other @ rows");
    open = false;
    assert.equal((await suggest(wrapped, "@:")).items.length, 2);
  });

  it("hands Pi's own rows back to Pi to complete", async () => {
    const { wrapped, base } = provider();
    const applied = wrapped.applyCompletion(["@ma"], 0, 3, base.rows[0], "@ma");
    assert.deepEqual(applied.lines, ["@src/main.ts "]);
    assert.ok(base.calls.includes("apply @src/main.ts"));
  });
});

describe("ampi-tui mentions: commits", () => {
  it("lists the commits newest first as sha and subject, with the dim relative time lined up", async () => {
    const { wrapped } = provider();
    const result = await suggest(wrapped, "fix @:");
    assert.equal(result.prefix, "@:");
    assert.deepEqual(
      result.items.map((item) => [item.value, item.label]),
      [
        ["@:b517caf", "b517caf Add the parser   <dim>5m ago</dim>"],
        ["@:a1c0d3e", "a1c0d3e init demo        <dim>3d ago</dim>"],
      ],
    );
  });

  it("filters by sha prefix or subject as you type, reading git once per open list", async () => {
    const t = provider();
    assert.deepEqual(
      (await suggest(t.wrapped, "@:a1")).items.map((item) => item.value),
      ["@:a1c0d3e"],
    );
    assert.deepEqual(
      (await suggest(t.wrapped, "@:PARSER")).items.map((item) => item.value),
      ["@:b517caf"],
    );
    assert.equal(await suggest(t.wrapped, "@:zzz"), null, "nothing matches: no list");
    assert.equal(t.reads(), 1);
    await suggest(t.wrapped, "then @:");
    assert.equal(t.reads(), 2, "a new @: token reads again");
  });

  it("reads git again for the next list at the same place: after a pick, another request or a pause", async () => {
    let now = NOW;
    const t = provider({ now: () => now });
    const [row] = (await suggest(t.wrapped, "@:")).items;
    t.wrapped.applyCompletion(["@:"], 0, 2, row, "@:");
    await suggest(t.wrapped, "@:");
    assert.equal(t.reads(), 2, "a pick ends the list");
    await suggest(t.wrapped, "@");
    await suggest(t.wrapped, "@:");
    assert.equal(t.reads(), 3, "a request for anything but @: ends the list");
    now += mentions.MMR_COMMIT_MENTION_REUSE_MS;
    await suggest(t.wrapped, "@:b");
    assert.equal(t.reads(), 3, "typing within the pause keeps the list");
    now += mentions.MMR_COMMIT_MENTION_REUSE_MS + 1;
    await suggest(t.wrapped, "@:");
    assert.equal(t.reads(), 4, "a longer pause ends the list");
  });

  it("shows no rows without commits", async () => {
    assert.equal(await suggest(provider({ commits: [] }).wrapped, "@:"), null);
  });

  it("picking a commit inserts @:<sha> and a space", async () => {
    const { wrapped } = provider();
    const [row] = (await suggest(wrapped, "fix @:b5")).items;
    assert.deepEqual(wrapped.applyCompletion(["fix @:b5 now"], 0, 8, row, "@:b5"), {
      lines: ["fix @:b517caf  now"],
      cursorLine: 0,
      cursorCol: 14,
    });
  });

  describe("from git", () => {
    let root;
    beforeEach(() => {
      root = realpathSync(mkdtempSync(path.join(tmpdir(), "ampi-mentions-")));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    function git(cwd, args, date) {
      execFileSync("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
          ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
        },
      });
    }

    it("reads the repository's last commits, newest first, with their committer dates", async () => {
      git(root, ["init", "-q"]);
      git(root, ["commit", "--allow-empty", "-q", "-m", "init demo"], "2026-10-15T12:00:00Z");
      git(root, ["commit", "--allow-empty", "-q", "-m", "Add the parser\n\nWith a body."], "2026-10-18T11:55:00Z");
      const commits = await mentions.readMmrRecentCommits(root);
      assert.deepEqual(
        commits.map((commit) => [commit.subject, commit.time.toISOString()]),
        [
          ["Add the parser", "2026-10-18T11:55:00.000Z"],
          ["init demo", "2026-10-15T12:00:00.000Z"],
        ],
      );
      assert.ok(commits.every((commit) => /^[0-9a-f]{7,}$/.test(commit.sha)));
    });

    it("lists a commit made after the last @: list at the same place in the prompt", async () => {
      git(root, ["init", "-q"]);
      git(root, ["commit", "--allow-empty", "-q", "-m", "init demo"], "2026-10-15T12:00:00Z");
      const wrapped = mentions.createMmrMentionProvider(piFiles(), {
        ...provider().options,
        listCommits: () => mentions.readMmrRecentCommits(root),
      });
      const first = await suggest(wrapped, "@:");
      assert.equal(first.items.length, 1);
      wrapped.applyCompletion(["@:"], 0, 2, first.items[0], "@:");
      git(root, ["commit", "--allow-empty", "-q", "-m", "Fix the divide helper"], "2026-10-18T11:59:00Z");
      const second = await suggest(wrapped, "@:");
      assert.equal(second.items.length, 2);
      assert.match(second.items[0].label, /^[0-9a-f]{7,} Fix the divide helper {3}<dim>1m ago<\/dim>$/);
    });

    it("finds none outside a repository, in one without commits, or without git", async () => {
      assert.deepEqual(await mentions.readMmrRecentCommits(root), []);
      git(root, ["init", "-q"]);
      assert.deepEqual(await mentions.readMmrRecentCommits(root), []);
      git(root, ["commit", "--allow-empty", "-q", "-m", "init demo"]);
      assert.deepEqual(await mentions.readMmrRecentCommits(root, { git: path.join(root, "no-such-git") }), []);
    });
  });
});

describe("ampi-tui mentions: ampi.fuzzy.alwaysIncludePaths", () => {
  let root;
  beforeEach(() => {
    // A repository whose dist/ git ignores, so Pi's file search (stubbed by piFiles) never lists it.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "ampi-include-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    const files = {
      ".gitignore": "dist/\nbig/\n",
      "README.md": "",
      "src/main.ts": "",
      "dist/bundle.js": "",
      "dist/main": "",
      "dist/main.js": "",
      "dist/nested/deep/x.map": "",
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    symlinkSync("../src", path.join(root, "dist/link"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function including(patterns, now = () => NOW) {
    return mentions.createMmrMentionProvider(piFiles(), { ...provider().options, now, alwaysInclude: { cwd: root, patterns } });
  }
  const values = async (wrapped, text) => (await suggest(wrapped, text))?.items.map((item) => item.value);

  it("leaves Pi's rows alone while the setting is empty", async () => {
    const wrapped = including([]);
    assert.equal(await suggest(wrapped, "@bun"), null);
    assert.deepEqual(await values(wrapped, "@main"), ["@src/main.ts"]);
  });

  it("offers matching ignored paths, ranked together with Pi's rows as Pi ranks them", async () => {
    const wrapped = including(["dist/**"]);
    assert.deepEqual((await suggest(wrapped, "@bun")).items, [
      { value: "@dist/bundle.js", label: "bundle.js", description: "dist/bundle.js" },
    ]);
    // An exact name first, then names that start with the query, shorter paths first.
    assert.deepEqual(await values(wrapped, "@main"), ["@dist/main", "@src/main.ts", "@dist/main.js"]);
    // Directories end in a slash; paths that only contain the query come after names that start with it.
    assert.deepEqual((await suggest(wrapped, "@nest")).items, [
      { value: "@dist/nested/", label: "nested/", description: "dist/nested" },
      { value: "@dist/nested/deep/", label: "deep/", description: "dist/nested/deep" },
      { value: "@dist/nested/deep/x.map", label: "x.map", description: "dist/nested/deep/x.map" },
    ]);
    // A symbolic link is offered as itself and never followed.
    assert.deepEqual(await values(wrapped, "@link"), ["@dist/link"]);
    assert.deepEqual(
      await values(wrapped, "@dist/m"),
      ["@dist/main", "@dist/main.js", "@dist/nested/deep/x.map"],
      "a typed directory narrows the paths to those under it",
    );
    assert.equal(await suggest(wrapped, "@src/bun"), null);
  });

  it("matches ** anywhere in a glob, and only what the glob names", async () => {
    const wrapped = including(["dist/**/*.map"]);
    assert.deepEqual(await values(wrapped, "@x"), ["@dist/nested/deep/x.map"]);
    assert.equal(await suggest(wrapped, "@bun"), null);
  });

  it("adds no row Pi already lists, and never walks into .git", async () => {
    const wrapped = including(["src/**", "**/*.ts", "**"]);
    assert.deepEqual(await values(wrapped, "@main.ts"), ["@src/main.ts"]);
    assert.equal(await suggest(wrapped, "@HEAD"), null);
  });

  it("ignores globs that leave the working directory or do not parse", async () => {
    assert.deepEqual(await mentions.walkMmrIncludedPaths(root, ["../**", "/etc/*", "dist/[%]*"]), []);
  });

  it("stops a walk at its entry cap and keeps to Pi's row count", async () => {
    const count = mentions.MMR_INCLUDED_PATHS_MAX_ENTRIES + 50;
    mkdirSync(path.join(root, "big"));
    for (let index = 0; index < count; index++) writeFileSync(path.join(root, "big", `f${String(index).padStart(4, "0")}.txt`), "");
    const walked = await mentions.walkMmrIncludedPaths(root, ["big/**"]);
    assert.equal(walked.length, mentions.MMR_INCLUDED_PATHS_MAX_ENTRIES);
    assert.ok(walked.some((entry) => entry.path === "big/f0000.txt"));
    assert.ok(!walked.some((entry) => entry.path === `big/f${count - 1}.txt`), "the walk stopped before the last entry");
    assert.equal((await values(including(["big/**"]), "@f")).length, mentions.MMR_PI_FILE_ROWS);
  });

  it("reuses one walk while completions follow each other, and walks again after a pause", async () => {
    let now = NOW;
    const wrapped = including(["dist/**"], () => now);
    assert.equal(await suggest(wrapped, "@fresh"), null);
    writeFileSync(path.join(root, "dist/fresh.js"), "");
    now += mentions.MMR_INCLUDED_PATHS_REUSE_MS;
    assert.equal(await suggest(wrapped, "@fresh"), null, "within the reuse window");
    now += mentions.MMR_INCLUDED_PATHS_REUSE_MS + 1;
    assert.deepEqual(await values(wrapped, "@fresh"), ["@dist/fresh.js"]);
  });
});

const SESSIONS = [
  {
    id: "0199a1b2-parser",
    path: "/sessions/parser.jsonl",
    cwd: "/work/demo",
    name: "Parser cleanup",
    created: new Date(NOW - DAY),
    modified: new Date(NOW - 51 * MINUTE),
    messageCount: 2,
    firstMessage: "Clean up the parser",
    allMessagesText: "Clean up the parser",
  },
];

/** Pick the Mention Thread picker's row with the stub's overlay, through the real picker. */
const pickThread = (ctx) => mentions.pickMmrThreadMention(ctx, { list: async () => SESSIONS, readPreview: () => [], now: () => NOW });

describe("ampi-tui mentions: @@ in the prompt box", () => {
  const piDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  let PiKeybindings;
  let createMmrPromptBoxInstall;
  before(async () => {
    ({ KeybindingsManager: PiKeybindings } = await import(pathToFileURL(path.join(piDist, "core/keybindings.js")).href));
    ({ createMmrPromptBoxInstall } = await importSource("extensions/ampi-tui/editor/install.ts"));
  });

  /** The prompt box on Pi's real editor; pasting goes into it the way Pi's pasteToEditor does. */
  function install() {
    const { pi } = createMockPi();
    const context = createMockExtensionContext({ cwd: "/work/demo", sessionId: "current" });
    context.ctx.ui.theme = { fg: (_token, text) => text };
    const promptBox = createMmrPromptBoxInstall(pi, { status: { busy: false, queued: 0 }, refreshQueue() {} }, { pickThread });
    promptBox.start(context.ctx, () => undefined);
    const terminal = new Proxy({ columns: 80, rows: 24 }, { get: (target, name) => (name in target ? target[name] : () => {}) });
    const tui = new TuiMainScreen(terminal);
    tui.requestRender = () => {};
    const editor = context.editors[0](tui, { borderColor: (text) => text, selectList: {} }, new PiKeybindings({}));
    context.ctx.ui.pasteToEditor = (text) => editor.handleInput(`\x1b[200~${text}\x1b[201~`);
    const type = (text) => {
      for (const char of text) editor.handleInput(char);
    };
    return { context, editor, type, promptBox };
  }

  it("opens the Mention Thread picker on the second @ and inserts the session picked", async () => {
    const t = install();
    t.type("see @");
    t.type("@");
    await settle();
    const overlay = t.context.overlays[0];
    assert.ok(overlay, "the picker opened");
    assert.match(overlay.component.render(120).join("\n"), /Mention Thread/);
    assert.equal(t.editor.getText(), "see @", "the second @ is held back");
    overlay.component.handleInput("\r");
    await settle();
    assert.equal(t.editor.getText(), "see @0199a1b2-parser ");
    t.type("please");
    assert.equal(t.editor.getText(), "see @0199a1b2-parser please", "the cursor sits after the reference");
  });

  it("types the @ after all when the picker is closed, and leaves other @ alone", async () => {
    const t = install();
    t.type("@");
    t.type("@");
    await settle();
    t.context.overlays[0].component.handleInput("\x1b");
    await settle();
    assert.equal(t.editor.getText(), "@@");
    t.type(" a@");
    t.type("@");
    assert.equal(t.context.overlays.length, 1, "an @ inside a word starts no mention");
    assert.equal(t.editor.getText(), "@@ a@@");
  });

  it("adds the mention provider to Pi's autocomplete each session, typing hint keys into the box", async () => {
    const t = install();
    assert.equal(t.context.autocompleteProviders.length, 1);
    const wrapped = t.context.autocompleteProviders[0]({ getSuggestions: async () => null, applyCompletion: () => undefined });
    const hint = (await wrapped.getSuggestions(["@"], 0, 1, { signal })).items[1];
    t.type("x @");
    wrapped.applyCompletion(["x @"], 0, 3, hint, "@");
    await settle();
    assert.ok(t.context.overlays[0], "the thread hint typed the second @");
  });
});

describe("ampi-tui thread.mention command", () => {
  beforeEach(() => registry.__resetMmrCommandsForTests());
  afterEach(() => registry.__resetMmrCommandsForTests());

  it("is the thread mention row with no key, in the terminal UI only", async () => {
    const { createMmrTuiCommands } = await importSource("extensions/ampi-tui/keys/commands.ts");
    const opened = [];
    const command = createMmrTuiCommands({ getTui: () => undefined, openThreadMention: (ctx) => opened.push(ctx) }).find(
      (entry) => entry.id === "thread.mention",
    );
    assert.deepEqual([command.noun, command.verb, command.defaultKey], ["thread", "mention", undefined]);
    const tui = createMockExtensionContext().ctx;
    assert.deepEqual(command.availability(tui), { state: "available" });
    assert.deepEqual(command.availability(createMockExtensionContext({ mode: "rpc" }).ctx), {
      state: "unavailable",
      reason: "only in Pi's terminal UI",
    });
    command.run(tui);
    assert.deepEqual(opened, [tui]);
  });

  it("opens the picker from the palette and pastes the reference at the cursor", async () => {
    const { createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts");
    const { pi } = createMockPi();
    const context = createMockExtensionContext({ editorText: "compare with " });
    const dimmed = [];
    const keys = createMmrTuiKeys(pi, { pickThread, onPaletteOpen: (open) => dimmed.push(open) });
    keys.start(context.ctx, () => undefined);
    registry.getMmrCommand("thread.mention").run(context.ctx);
    await settle();
    assert.match(context.overlays[0].component.render(120).join("\n"), /Mention Thread/);
    context.overlays[0].component.handleInput("\r");
    await settle();
    assert.deepEqual(context.pastes, ["@0199a1b2-parser "]);
    assert.equal(context.state.editorText, "compare with @0199a1b2-parser ");
    assert.deepEqual(dimmed, [true, false]);

    registry.getMmrCommand("thread.mention").run(context.ctx);
    await settle();
    context.overlays[1].component.handleInput("\x1b");
    await settle();
    assert.equal(context.pastes.length, 1, "closing the picker inserts nothing");
    keys.stop();
  });
});

describe("ampi-history read_session and mentions", () => {
  it("tells the model what a @<session-id> in the user's message is", async () => {
    const { READ_SESSION_DESCRIPTION } = await importSource("extensions/ampi-history/tools.ts");
    assert.match(READ_SESSION_DESCRIPTION, /`@<session-id>` in the user's message is a mention of a Pi session/);
  });
});
