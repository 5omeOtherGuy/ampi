// Guidance from subfolders: which AGENTS.md files a read below the working
// directory adds, how ampi-core appends them to Pi's read results once per
// directory per session branch, and when it stays off. The last suite checks
// the installed Pi's context-file loader, argument parser and in-memory
// session, which the feature mirrors or relies on.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, loadProjectContextFiles, parseArgs, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/ampi-core/subtree-guidance.ts";
const HOOKS = "extensions/ampi-core/subtree-guidance-hooks.ts";
const ENTRY = "ampi-core.subtree-guidance";

/**
 * A temporary root with `home/` and `project/`. `files` maps paths relative
 * to the project to file text; `null` makes a directory instead.
 */
function makeTree(t, files = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ampi-subtree-guidance-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(cwd, relative);
    if (text === null) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, cwd, at: (relative) => path.join(cwd, relative) };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

describe("subfolder guidance selection", () => {
  it("pins Pi's context-file names in Pi's order", async () => {
    const { MMR_CONTEXT_FILE_NAMES } = await importSource(MODULE);
    assert.deepEqual([...MMR_CONTEXT_FILE_NAMES], ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
  });

  it("yields the files of both directories between the working directory and the file, outermost first", async (t) => {
    const { selectMmrSubtreeGuidance } = await importSource(MODULE);
    const tree = makeTree(t, {
      "AGENTS.md": "root rules",
      "src/AGENTS.md": "src rules",
      "src/feature/AGENTS.md": "feature rules",
      "src/feature/x.ts": "x",
    });
    const selection = selectMmrSubtreeGuidance({ filePath: tree.at("src/feature/x.ts"), cwd: tree.cwd, covered: new Set() });
    assert.deepEqual(
      selection.files.map((file) => [file.path, file.directory, file.text]),
      [
        [tree.at("src/AGENTS.md"), tree.at("src"), "src rules"],
        [tree.at("src/feature/AGENTS.md"), tree.at("src/feature"), "feature rules"],
      ],
    );
    assert.deepEqual(selection.covered, [tree.at("src"), tree.at("src/feature")]);
  });

  it("takes AGENTS.override.md over AGENTS.md in its directory", async (t) => {
    const { selectMmrSubtreeGuidance } = await importSource(MODULE);
    const tree = makeTree(t, {
      "lib/AGENTS.override.md": "override",
      "lib/AGENTS.md": "plain",
      "lib/x.ts": "x",
    });
    const { files } = selectMmrSubtreeGuidance({ filePath: tree.at("lib/x.ts"), cwd: tree.cwd, covered: new Set() });
    assert.deepEqual(files.map((file) => file.text), ["override"]);
  });

  it("uses CLAUDE.md only where no AGENTS.md or AGENTS.MD exists", async () => {
    const { selectMmrSubtreeGuidance } = await importSource(MODULE);
    const cwd = path.resolve("/work");
    // An injected reader: Pi's names differ only in case, which a
    // case-insensitive file system cannot hold side by side.
    const present = new Map([
      [path.join(cwd, "a", "AGENTS.MD"), "a upper"],
      [path.join(cwd, "a", "CLAUDE.md"), "a claude"],
      [path.join(cwd, "a", "b", "CLAUDE.md"), "b claude"],
      [path.join(cwd, "a", "b", "CLAUDE.MD"), "b claude upper"],
      [path.join(cwd, "a", "b", "c", "CLAUDE.MD"), "c claude upper"],
    ]);
    const { files } = selectMmrSubtreeGuidance({
      filePath: path.join(cwd, "a", "b", "c", "x.ts"),
      cwd,
      covered: new Set(),
      readFile: (filePath) => present.get(filePath),
    });
    assert.deepEqual(files.map((file) => file.text), ["a upper", "b claude", "c claude upper"]);
  });

  it("strips a leading BOM, as Pi does", async () => {
    const { selectMmrSubtreeGuidance } = await importSource(MODULE);
    const cwd = path.resolve("/work");
    const { files } = selectMmrSubtreeGuidance({
      filePath: path.join(cwd, "a", "x.ts"),
      cwd,
      covered: new Set(),
      readFile: (filePath) => (filePath === path.join(cwd, "a", "AGENTS.md") ? "\uFEFFrules\uFEFF" : undefined),
    });
    assert.deepEqual(files.map((file) => file.text), ["rules\uFEFF"]);
  });

  it("gives a file in the working directory nothing, even with a guidance file beside it", async (t) => {
    const { selectMmrSubtreeGuidance } = await importSource(MODULE);
    const tree = makeTree(t, { "AGENTS.md": "root", "x.ts": "x" });
    assert.deepEqual(selectMmrSubtreeGuidance({ filePath: tree.at("x.ts"), cwd: tree.cwd, covered: new Set() }), { files: [], covered: [] });
  });

  it("gives a file outside the working directory nothing, also through ..", async (t) => {
    const { resolveMmrReadToolPath, selectMmrSubtreeGuidance } = await importSource(MODULE);
    const tree = makeTree(t, { "src/AGENTS.md": "src" });
    mkdirSync(path.join(tree.root, "other", "deep"), { recursive: true });
    writeFileSync(path.join(tree.root, "other", "AGENTS.md"), "other");
    writeFileSync(path.join(tree.root, "other", "deep", "AGENTS.md"), "deep");
    const outside = [
      path.join(tree.root, "other", "deep", "x.ts"),
      resolveMmrReadToolPath("../other/deep/x.ts", tree.cwd),
      resolveMmrReadToolPath("src/../../other/deep/x.ts", tree.cwd),
    ];
    for (const filePath of outside) {
      assert.deepEqual(selectMmrSubtreeGuidance({ filePath, cwd: tree.cwd, covered: new Set() }).files, [], filePath);
    }
    // A sibling whose name starts like the working directory is outside too.
    mkdirSync(`${tree.cwd}-copy/src`, { recursive: true });
    writeFileSync(`${tree.cwd}-copy/src/AGENTS.md`, "copy");
    assert.deepEqual(selectMmrSubtreeGuidance({ filePath: `${tree.cwd}-copy/src/x.ts`, cwd: tree.cwd, covered: new Set() }).files, []);
  });

  it("skips covered directories and still adds deeper uncovered ones", async (t) => {
    const { selectMmrSubtreeGuidance } = await importSource(MODULE);
    const tree = makeTree(t, { "src/AGENTS.md": "src", "src/feature/AGENTS.md": "feature" });
    const selection = selectMmrSubtreeGuidance({ filePath: tree.at("src/feature/x.ts"), cwd: tree.cwd, covered: new Set([tree.at("src")]) });
    assert.deepEqual(selection.files.map((file) => file.text), ["feature"]);
    assert.deepEqual(selection.covered, [tree.at("src/feature")]);
  });

  it("skips a guidance name that is not a regular file", async (t) => {
    const { selectMmrSubtreeGuidance } = await importSource(MODULE);
    const tree = makeTree(t, { "src/AGENTS.md": null, "src/CLAUDE.md": "claude" });
    const { files } = selectMmrSubtreeGuidance({ filePath: tree.at("src/x.ts"), cwd: tree.cwd, covered: new Set() });
    assert.deepEqual(files.map((file) => file.path), [tree.at("src/CLAUDE.md")]);
  });

  it("adds no copy of a guidance file the model reads, but covers its directory", async (t) => {
    const { selectMmrSubtreeGuidance } = await importSource(MODULE);
    const tree = makeTree(t, { "src/AGENTS.md": "src", "src/feature/AGENTS.md": "feature" });
    const selection = selectMmrSubtreeGuidance({ filePath: tree.at("src/feature/AGENTS.md"), cwd: tree.cwd, covered: new Set() });
    assert.deepEqual(selection.files.map((file) => file.text), ["src"]);
    assert.deepEqual(selection.covered, [tree.at("src"), tree.at("src/feature")]);
  });

  it("keeps a file of exactly 32 KiB whole and cuts a longer one after its last whole line", async () => {
    const { capMmrGuidanceText, MMR_SUBTREE_GUIDANCE_MAX_BYTES } = await importSource(MODULE);
    assert.equal(MMR_SUBTREE_GUIDANCE_MAX_BYTES, 32768);
    const line = `${"a".repeat(99)}\n`; // 100 bytes
    const exact = `${line.repeat(327)}${"b".repeat(67)}\n`; // 32700 + 68 bytes
    assert.equal(Buffer.byteLength(exact), 32768);
    assert.deepEqual(capMmrGuidanceText(exact), { text: exact, shortened: false });

    // One byte over: the last line no longer fits, so the text ends after line 327.
    const over = `${line.repeat(327)}${"b".repeat(68)}\n`;
    const cut = capMmrGuidanceText(over);
    assert.equal(cut.shortened, true);
    assert.ok(cut.text.startsWith(line.repeat(327)));
    const note = cut.text.slice(line.length * 327);
    assert.doesNotMatch(note, /b/, "the partial last line is left out");
    assert.match(note, /^\[ampi: .*32 KiB.*\]$/);
  });

  it("cuts a single over-long line on a whole character", async () => {
    const { capMmrGuidanceText } = await importSource(MODULE);
    // U+00E9 is two bytes in UTF-8: 16384 of them fill the cap exactly, a 'x' first pushes the last one over.
    const cut = capMmrGuidanceText(`x${"\u00E9".repeat(16384)}`);
    assert.equal(cut.shortened, true);
    const [kept] = cut.text.split("\n");
    assert.equal(kept, `x${"\u00E9".repeat(16383)}`);
    assert.doesNotMatch(cut.text, /\uFFFD/);
  });

  it("rebuilds coverage from a branch, root first, clearing at a reset and ignoring malformed entries", async () => {
    const { rebuildMmrSubtreeGuidanceCoverage } = await importSource(MODULE);
    const a = path.resolve("/work/a");
    const b = path.resolve("/work/b");
    const c = path.resolve("/work/c");
    const custom = (data, customType = ENTRY) => ({ type: "custom", customType, data });
    const branch = [
      custom({ version: 1, directories: [a] }),
      custom({ version: 1, reset: true }),
      custom({ version: 1, directories: [b] }),
      custom({ version: 1, directories: ["relative/dir"] }),
      custom({ version: 1, directories: [c, 7] }),
      custom({ version: 2, directories: [c] }),
      custom({ directories: [c] }),
      custom("nonsense"),
      custom({ version: 1, directories: [c] }, "other.entry"),
      { type: "message", message: { role: "user", content: "hi" } },
    ];
    assert.deepEqual([...rebuildMmrSubtreeGuidanceCoverage(branch)], [b]);
  });
});

/**
 * ampi-core's subfolder guidance hooks on a mock Pi. Entries the hooks append
 * land on the mock branch, as Pi's session manager does.
 */
async function setupHooks(t, { files = {}, settings, argv = [], discovered = [], entries = [] } = {}) {
  const tree = makeTree(t, files);
  if (settings !== undefined) writeJson(path.join(tree.home, ".pi/agent/settings.json"), settings);
  const { registerMmrSubtreeGuidanceHooks } = await importSource(HOOKS);
  const { pi, handlers, calls } = createMockPi();
  const branch = [...entries];
  const appendEntry = pi.appendEntry;
  pi.appendEntry = (customType, data) => {
    appendEntry(customType, data);
    branch.push({ type: "custom", customType, data });
  };
  const guidance = registerMmrSubtreeGuidanceHooks(pi, { argv, homeDirectory: tree.home, discoverContextFiles: () => discovered });
  const { ctx } = createMockExtensionContext({ cwd: tree.cwd, entries: branch });
  const fire = (name, event = {}) => handlers.get(name)({ type: name, ...event }, ctx);
  await fire("session_start", { reason: "startup" });

  const structuredContent = { kind: "read-result", lines: 1 };
  const read = (filePath, overrides = {}) =>
    fire("tool_result", {
      toolName: "read",
      toolCallId: `call_${calls.appendEntry.length}`,
      input: { path: filePath },
      content: [{ type: "text", text: "file text" }],
      structuredContent,
      details: { truncation: undefined },
      isError: false,
      ...overrides,
    });
  const appendedTexts = (result) => (result?.content ?? []).slice(1).map((block) => block.text);
  const agentStart = (contextFiles) => guidance.observeAgentStart({ systemPromptOptions: { cwd: tree.cwd, contextFiles } }, ctx);
  return { tree, ctx, fire, read, agentStart, branch, calls, structuredContent, appendedTexts };
}

const FEATURE_TREE = {
  "AGENTS.md": "root rules",
  "src/feature/AGENTS.md": "feature rules",
  "src/feature/x.ts": "x",
  "src/feature/y.ts": "y",
  "src/other/AGENTS.md": "other rules",
};

describe("subfolder guidance on read results", () => {
  it("appends each file after the original content under a heading with its relative path", async (t) => {
    const { read, structuredContent } = await setupHooks(t, { files: { ...FEATURE_TREE, "src/AGENTS.md": "src rules" } });
    const result = await read("src/feature/x.ts");
    assert.deepEqual(result.content, [
      { type: "text", text: "file text" },
      { type: "text", text: "Instructions from src/AGENTS.md (they apply to files under src/):\n\nsrc rules" },
      { type: "text", text: "Instructions from src/feature/AGENTS.md (they apply to files under src/feature/):\n\nfeature rules" },
    ]);
    assert.equal(result.structuredContent, structuredContent, "structured content comes back unchanged");
    assert.equal("details" in result, false, "the tool's details are never replaced");
  });

  it("appends to an image read too, after the image", async (t) => {
    const { read, appendedTexts } = await setupHooks(t, { files: FEATURE_TREE });
    const image = { type: "image", data: "aGk=", mimeType: "image/png" };
    const result = await read("src/feature/pic.png", { content: [{ type: "text", text: "Read image file [image/png]" }, image] });
    assert.deepEqual(result.content[1], image);
    assert.deepEqual(appendedTexts(result).slice(1), [
      "Instructions from src/feature/AGENTS.md (they apply to files under src/feature/):\n\nfeature rules",
    ]);
  });

  it("leaves out structured content the read did not have", async (t) => {
    const { read } = await setupHooks(t, { files: FEATURE_TREE });
    const result = await read("src/feature/x.ts", { structuredContent: undefined });
    assert.equal("structuredContent" in result, false);
  });

  it("leaves error results, other tools and nested reads alone", async (t) => {
    const { read, branch } = await setupHooks(t, { files: FEATURE_TREE });
    assert.equal(await read("src/feature/x.ts", { isError: true }), undefined);
    assert.equal(await read("src/feature/x.ts", { toolName: "grep" }), undefined);
    assert.equal(await read("src/feature/x.ts", { toolName: "Read" }), undefined);
    assert.equal(await read("src/feature/x.ts", { parentToolCallId: "call_codemode" }), undefined);
    assert.equal(await read("src/feature/x.ts", { input: { file: "src/feature/x.ts" } }), undefined);
    assert.deepEqual(branch, [], "none of them covers a directory");
    assert.ok(await read("src/feature/x.ts"), "the next plain read still adds the guidance");
  });

  it("adds a directory's file once, and a sibling directory's file on its own first read", async (t) => {
    const { read, appendedTexts, branch, tree } = await setupHooks(t, { files: FEATURE_TREE });
    assert.equal(appendedTexts(await read("src/feature/x.ts")).length, 1);
    assert.equal(await read("src/feature/y.ts"), undefined);
    assert.equal(await read("src/feature/x.ts"), undefined);
    assert.match(appendedTexts(await read("src/other/z.ts"))[0], /^Instructions from src\/other\/AGENTS\.md .*\n\nother rules$/);
    assert.deepEqual(
      branch.map((entry) => [entry.customType, entry.data]),
      [
        [ENTRY, { version: 1, directories: [tree.at("src/feature")] }],
        [ENTRY, { version: 1, directories: [tree.at("src/other")] }],
      ],
    );
  });

  it("treats a relative, an @-prefixed and an absolute path to the same file alike", async (t) => {
    for (const form of ["relative", "at", "absolute"]) {
      const { read, tree, appendedTexts } = await setupHooks(t, { files: FEATURE_TREE });
      const input = { relative: "src/feature/x.ts", at: "@src/feature/x.ts", absolute: tree.at("src/feature/x.ts") }[form];
      const texts = appendedTexts(await read(input));
      assert.equal(texts.length, 1, form);
      assert.match(texts[0], /^Instructions from src\/feature\/AGENTS\.md /, form);
      // The other forms now count as the same directory.
      assert.equal(await read(tree.at("src/feature/y.ts")), undefined, form);
      assert.equal(await read("@src/feature/y.ts"), undefined, form);
    }
  });

  it("rebuilds the covered directories from the branch at session start", async (t) => {
    const { read, fire, tree, branch, appendedTexts } = await setupHooks(t, { files: FEATURE_TREE });
    branch.push({ type: "custom", customType: ENTRY, data: { version: 1, directories: [tree.at("src/feature")] } });
    await fire("session_start", { reason: "resume" });
    assert.equal(await read("src/feature/x.ts"), undefined, "the resumed branch already covers src/feature");

    branch.push({ type: "custom", customType: ENTRY, data: { version: 1, reset: true } });
    await fire("session_tree", { newLeafId: "leaf", oldLeafId: "old" });
    assert.equal(appendedTexts(await read("src/feature/x.ts")).length, 1, "a reset on the branch clears what precedes it");
  });

  it("follows the branch on session_tree", async (t) => {
    const { read, fire, branch, appendedTexts } = await setupHooks(t, { files: FEATURE_TREE });
    assert.equal(appendedTexts(await read("src/feature/x.ts")).length, 1);
    // Move to a branch without the entry, as /tree to an earlier point does.
    branch.length = 0;
    await fire("session_tree", { newLeafId: "earlier", oldLeafId: "later" });
    assert.equal(appendedTexts(await read("src/feature/x.ts")).length, 1);
  });

  it("appends a reset entry on compaction, after which the next read adds the guidance again", async (t) => {
    const { read, fire, branch, appendedTexts } = await setupHooks(t, { files: FEATURE_TREE });
    assert.equal(appendedTexts(await read("src/feature/x.ts")).length, 1);
    await fire("session_compact", { fromExtension: false });
    assert.deepEqual(branch.at(-1), { type: "custom", customType: ENTRY, data: { version: 1, reset: true } });
    assert.equal(appendedTexts(await read("src/feature/x.ts")).length, 1);
    assert.equal(await read("src/feature/x.ts"), undefined);
  });

  it("writes no reset entry when nothing is covered", async (t) => {
    const { fire, branch } = await setupHooks(t, { files: FEATURE_TREE });
    await fire("session_compact", { fromExtension: false });
    assert.deepEqual(branch, []);
  });
});

describe("turning subfolder guidance off", () => {
  for (const [form, settings] of [
    ["flat", { ampiCore: { subtreeGuidance: false } }],
    ["nested", { ampi: { core: { subtreeGuidance: false } } }],
  ]) {
    it(`is off with ${form} subtreeGuidance: false`, async (t) => {
      const { read, branch } = await setupHooks(t, { files: FEATURE_TREE, settings });
      assert.equal(await read("src/feature/x.ts"), undefined);
      assert.deepEqual(branch, []);
    });
  }

  it("stays on with subtreeGuidance: true and warns about a value that is not a boolean", async (t) => {
    const on = await setupHooks(t, { files: FEATURE_TREE, settings: { ampiCore: { subtreeGuidance: true } } });
    assert.ok(await on.read("src/feature/x.ts"));

    const odd = await setupHooks(t, { files: FEATURE_TREE, settings: { ampiCore: { subtreeGuidance: "no" } } });
    assert.ok(await odd.read("src/feature/x.ts"), "an invalid value keeps the default");
    const { loadMmrCoreSettings } = await importSource("extensions/ampi-core/settings.ts");
    const loaded = loadMmrCoreSettings(odd.tree.cwd, odd.tree.home);
    assert.equal(loaded.settings.subtreeGuidance, undefined);
    assert.match(loaded.warnings.join("\n"), /Ignoring ampiCore\.subtreeGuidance in .*: expected true or false\./);
  });

  it("is off when Pi runs with --no-context-files or -nc", async (t) => {
    for (const flag of ["--no-context-files", "-nc"]) {
      const { read } = await setupHooks(t, { files: FEATURE_TREE, argv: ["--model", "faux/faux-1", flag, "-p", "hi"] });
      assert.equal(await read("src/feature/x.ts"), undefined, flag);
    }
    const valued = await setupHooks(t, { files: FEATURE_TREE, argv: ["--model", "-nc"] });
    assert.ok(await valued.read("src/feature/x.ts"), "-nc as the value of --model is not the switch");
  });

  it("is off when Pi passes no context files although its discovery finds some", async (t) => {
    const discovered = [{ path: "/project/AGENTS.md", content: "root rules" }];
    const { read, agentStart } = await setupHooks(t, { files: FEATURE_TREE, discovered });
    agentStart([]);
    assert.equal(await read("src/feature/x.ts"), undefined);

    // Pi passing its files again turns it back on.
    agentStart(discovered);
    assert.ok(await read("src/feature/x.ts"));
  });

  it("stays on when Pi passes no context files because none exist", async (t) => {
    const { read, agentStart } = await setupHooks(t, { files: FEATURE_TREE, discovered: [] });
    agentStart([]);
    assert.ok(await read("src/feature/x.ts"));
  });

  it("learns from ampi-core's before_agent_start hook which context files Pi passed", async (t) => {
    const tree = makeTree(t, FEATURE_TREE);
    const agentDir = path.join(tree.root, "agent");
    mkdirSync(agentDir);
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    });
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const { pi, handlers } = createMockPi();
    extension(pi);
    const { ctx } = createMockExtensionContext({ cwd: tree.cwd });
    const agentStart = (contextFiles) =>
      handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: { cwd: tree.cwd, contextFiles } }, ctx);
    const read = () =>
      handlers.get("tool_result")(
        { type: "tool_result", toolName: "read", toolCallId: "c", input: { path: "src/feature/x.ts" }, content: [{ type: "text", text: "x" }], details: undefined, isError: false },
        ctx,
      );

    // The project's AGENTS.md exists, so Pi passing none means -nc.
    await agentStart([]);
    assert.equal(await read(), undefined);
    await agentStart([{ path: tree.at("AGENTS.md"), content: "root rules" }]);
    assert.equal((await read()).content.length, 2);
  });
});

describe("finder line numbers and subfolder guidance", () => {
  it("numbers the file text of a finder read but not the guidance appended to it", async (t) => {
    // The runtime at its stable URL, the one finder's module imports.
    const runtime = await import(pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href);
    const { maybeNumberFinderReadToolResult } = await importSource("extensions/ampi-workers/builtin-workers/finder.ts");
    const { read } = await setupHooks(t, { files: FEATURE_TREE });
    const withGuidance = await read("src/feature/x.ts", { content: [{ type: "text", text: "one\ntwo" }] });
    runtime.setMmrSubagentState({
      profile: "finder",
      provider: "faux",
      model: "faux-1",
      thinkingLevel: "minimal",
      promptRoute: "subagent",
      activeTools: ["grep", "find", "read"],
      activatedAt: "2026-10-18T00:00:00.000Z",
    });
    t.after(() => runtime.setMmrSubagentState(undefined));
    const numbered = maybeNumberFinderReadToolResult({ toolName: "read", input: {}, isError: false, content: withGuidance.content });
    assert.deepEqual(numbered.content.map((block) => block.text), [
      "1: one\n2: two",
      "Instructions from src/feature/AGENTS.md (they apply to files under src/feature/):\n\nfeature rules",
    ]);
  });
});

describe("the installed Pi", () => {
  it("takes the same file per directory as ampi, by the same names and order", async (t) => {
    const { selectMmrSubtreeGuidance } = await importSource(MODULE);
    // A directory under the first name, and files under lower-ranked names,
    // so the pick depends on the order and on the regular-file check.
    const tree = makeTree(t, {
      "a/AGENTS.override.md": null,
      "a/AGENTS.md": "a agents",
      "a/CLAUDE.md": "a claude",
      "a/b/CLAUDE.md": "b claude",
      "a/b/c/AGENTS.override.md": "c override",
      "a/b/c/AGENTS.md": "c agents",
    });
    const agentDir = path.join(tree.root, "agent");
    mkdirSync(agentDir);
    // Pi, started in a/b/c, loads the files of a/b/c and its parents; ampi,
    // started in the project, adds those of the directories below it.
    const piPicks = loadProjectContextFiles({ cwd: tree.at("a/b/c"), agentDir }).map((file) => [file.path, file.content]);
    const { files } = selectMmrSubtreeGuidance({ filePath: tree.at("a/b/c/x.ts"), cwd: tree.cwd, covered: new Set() });
    assert.deepEqual(piPicks, [
      [tree.at("a/AGENTS.md"), "a agents"],
      [tree.at("a/b/CLAUDE.md"), "b claude"],
      [tree.at("a/b/c/AGENTS.override.md"), "c override"],
    ]);
    assert.deepEqual(files.map((file) => [file.path, file.text]), piPicks);
  });

  it("passes no context files with noContextFiles, while its discovery still finds them", async (t) => {
    const tree = makeTree(t, { "AGENTS.md": "root rules" });
    const agentDir = path.join(tree.root, "agent");
    mkdirSync(agentDir);
    const settingsManager = SettingsManager.create(tree.cwd, agentDir);
    const loader = new DefaultResourceLoader({ cwd: tree.cwd, agentDir, settingsManager, noContextFiles: true, noExtensions: true });
    await loader.reload();
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(
      loadProjectContextFiles({ cwd: tree.cwd, agentDir }).map((file) => file.path),
      [tree.at("AGENTS.md")],
    );
  });

  it("reads -nc and --no-context-files as ampi does", async () => {
    const { extractExplicitWorkerCliFlags } = await importSource("extensions/ampi-core/worker-cli-flags.ts");
    for (const argv of [["-nc"], ["--no-context-files"], ["--model", "faux/faux-1", "-nc", "hi"], ["hi"], ["--tools", "read"]]) {
      assert.equal(extractExplicitWorkerCliFlags(argv).noContextFiles, parseArgs(argv).noContextFiles === true, argv.join(" "));
    }
  });

  it("keeps appended custom entries on the branch of an in-memory session", () => {
    const session = SessionManager.inMemory(os.tmpdir());
    session.appendCustomEntry(ENTRY, { version: 1, directories: [path.resolve("/work/src")] });
    assert.deepEqual(
      session.getBranch().filter((entry) => entry.type === "custom").map((entry) => [entry.customType, entry.data]),
      [[ENTRY, { version: 1, directories: [path.resolve("/work/src")] }]],
    );
  });
});
