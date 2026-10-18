import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext } from "./helpers/pi-stub.mjs";
import { createAnsiTheme, expectFixture, plain } from "./helpers/tui-render.mjs";

after(cleanupLoadedSource);

let help;
let reports;
let seam;
let createMmrTuiCommands;
const theme = createAnsiTheme();

before(async () => {
  help = await importSource("extensions/ampi-tui/overlays/help-keymap.ts");
  reports = await importSource("extensions/ampi-tui/overlays/thread-reports.ts");
  seam = await importSource("extensions/ampi-core/thread-reports.ts");
  ({ createMmrTuiCommands } = await importSource("extensions/ampi-tui/keys/commands.ts"));
});

const COST = {
  total: 0.0285,
  unknown: 1,
  models: [
    { label: "anthropic/claude-sonnet-4-5", cost: 0.0265, input: 13200, output: 116, cacheRead: 26400, cacheWrite: 13100 },
    { label: "local/a-model-with-a-rather-long-name-that-the-narrow-box-has-to-cut-short", cost: undefined, input: 2100, output: 40, cacheRead: 0, cacheWrite: 0 },
    { label: "session summaries", cost: 0.002, input: 9000, output: 300, cacheRead: 0, cacheWrite: 0 },
  ],
};

const ANALYSIS = {
  model: "anthropic/claude-sonnet-4-5",
  contextWindow: 200000,
  sections: [
    { id: "system-prompt", name: "System prompt", tokens: 3120 },
    { id: "builtin-tools", name: "Built-in tools", tokens: 5240, count: 15 },
    { id: "agents-files", name: "AGENTS.md files", tokens: 820, count: 2 },
    { id: "mcp-tools", name: "MCP tools", tokens: 0, count: 0 },
    { id: "loaded-skills", name: "Loaded skills", tokens: 210, count: 3 },
    { id: "compaction-summary", name: "Compaction summary", tokens: 640 },
    { id: "messages", name: "Messages", tokens: 48200 },
  ],
  totalTokens: 58230,
  measuredTokens: 61000,
  compactionCount: 1,
};

/** The overlay as Pi draws it: 100 columns wide, or the terminal width less four. */
function render(title, content, columns, rows) {
  const view = new help.MmrScrollOverlay({ title, content, theme, onClose() {}, terminalRows: () => rows, fit: true });
  return view.render(Math.min(100, columns - 4));
}
const costLines = (report) => (width, frameTheme) => reports.renderMmrThreadCostLines(report, width, frameTheme);
const contextLines = (analysis) => (width, frameTheme) => reports.renderMmrContextAnalysisLines(analysis, width, frameTheme);

describe("Thread Cost overlay", () => {
  it("shows the total, then each model's cost with its tokens under it, at 140 and 80 columns", () => {
    expectFixture("ampi-tui-thread-reports", "cost-140", render(reports.MMR_THREAD_COST_TITLE, costLines(COST), 140, 44));
    const at80 = render(reports.MMR_THREAD_COST_TITLE, costLines(COST), 80, 24);
    expectFixture("ampi-tui-thread-reports", "cost-80", at80);
    const text = plain(at80);
    assert.equal(text.length, 3 + 8, "as tall as its content: borders, the padding row and eight lines");
    assert.match(text[2], /^│ Total: \$0\.03, not counting 1 model without a price +│$/);
    assert.match(text[6], /^│ local\/a-model-with-a-rather-long-name-that-the-narrow-box-has-t… unknown │$/);
    assert.match(text.at(-1), /^╰─+ Esc close ─╯$/, "no scroll hint while it all fits");
  });

  it("reads unknown when no model has a price, and says when no model has answered", () => {
    const unknown = { total: 0, unknown: 1, models: [{ label: "faux/faux-1", cost: undefined, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }] };
    expectFixture("ampi-tui-thread-reports", "cost-unknown-80", render(reports.MMR_THREAD_COST_TITLE, costLines(unknown), 80, 24));
    assert.match(plain(render(reports.MMR_THREAD_COST_TITLE, costLines(unknown), 80, 24))[2], /^│ Total: unknown +│$/);
    const empty = plain(render(reports.MMR_THREAD_COST_TITLE, costLines({ total: 0, unknown: 0, models: [] }), 80, 24));
    assert.match(empty[2], /^│ No model has answered in this session yet\. +│$/);
  });
});

describe("Analyze Context overlay", () => {
  it("lists each section's tokens and share of the window, the total and the free space, at 140 and 80 columns", () => {
    expectFixture("ampi-tui-thread-reports", "context-140", render(reports.MMR_CONTEXT_ANALYSIS_TITLE, contextLines(ANALYSIS), 140, 44));
    const at80 = render(reports.MMR_CONTEXT_ANALYSIS_TITLE, contextLines(ANALYSIS), 80, 24);
    expectFixture("ampi-tui-thread-reports", "context-80", at80);
    const text = plain(at80);
    assert.match(text[2], /^│ anthropic\/claude-sonnet-4-5 · 200k context window +│$/);
    assert.match(text[4], /^│ System prompt {8}3\.1k {4}1\.6% +│$/);
    assert.match(text[5], /^│ Built-in tools \(15\) {2}5\.2k {4}2\.6% +│$/);
    assert.match(text[10], /^│ Messages {14}48k {3}24\.1% +│$/);
    assert.match(text[12], /^│ Total {17}58k {3}29\.1% +│$/);
    assert.match(text[13], /^│ Free space {11}142k {3}70\.9% +│$/);
    assert.match(text[15], /^│ Compactions: 1 +│$/);
  });

  it("shows no shares without a known window, and scrolls when the screen is too short", () => {
    const unknownWindow = { ...ANALYSIS, model: undefined, contextWindow: undefined, measuredTokens: undefined };
    const text = plain(render(reports.MMR_CONTEXT_ANALYSIS_TITLE, contextLines(unknownWindow), 80, 24));
    assert.match(text[2], /^│ No model selected · context window unknown +│$/);
    assert.match(text[4], /^│ System prompt {8}3\.1k {7}— +│$/);
    assert.ok(!text.some((line) => line.includes("Free space")));

    const short = plain(render(reports.MMR_CONTEXT_ANALYSIS_TITLE, contextLines(ANALYSIS), 80, 12));
    assert.equal(short.length, 12 - 2);
    assert.match(short.at(-1), / Esc close · ↑↓\/j\/k scroll ─╯$/);
  });
});

describe("thread report commands", () => {
  let release;
  afterEach(() => {
    release?.();
    release = undefined;
  });

  const opened = [];
  const host = {
    getTui: () => undefined,
    pi: { getCommands: () => [], getSettings: () => ({}), sendUserMessage() {} },
    openThreadCost: (_ctx, source) => opened.push(["cost", source]),
    openContextAnalysis: (_ctx, source) => opened.push(["context", source]),
  };
  const find = (id) => createMmrTuiCommands(host).find((command) => command.id === id);

  it("are unavailable without ampi-threads and outside the terminal UI, and open the overlays with its reports", () => {
    const { ctx } = createMockExtensionContext({ hasUI: true });
    for (const id of ["thread.showCost", "thread.analyzeContext"]) {
      assert.deepEqual(find(id).availability(ctx), { state: "unavailable", reason: "ampi-threads is not loaded" });
    }
    const source = { showCosts: true, cost: () => COST, analyzeContext: () => ANALYSIS };
    release = seam.registerMmrThreadReports(source);
    const print = createMockExtensionContext({ hasUI: false }).ctx;
    assert.deepEqual(find("thread.showCost").availability(print), { state: "unavailable", reason: "only in Pi's terminal UI" });
    assert.deepEqual(find("thread.showCost").availability(ctx), { state: "available" });
    assert.deepEqual(
      [find("thread.showCost"), find("thread.analyzeContext")].map((command) => `${command.noun} ${command.verb}`),
      ["thread show cost", "thread analyze context"],
    );
    find("thread.showCost").run(ctx);
    find("thread.analyzeContext").run(ctx);
    assert.deepEqual(opened, [
      ["cost", source],
      ["context", source],
    ]);
  });
});
