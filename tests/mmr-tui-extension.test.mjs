import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { KeybindingsManager, stripTerminalSequences, TuiMainScreen } from "@earendil-works/pi-tui";
import { isolateAnimationEnv, setNoAnimation } from "./helpers/animation-env.mjs";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);
isolateAnimationEnv();

const repoRoot = path.resolve(import.meta.dirname, "..");

/** `beforeCreate` runs after the source is loaded, e.g. to start mock timers the import must not see. */
async function loadExtension(settings, beforeCreate) {
  const { createMmrTuiExtension } = await importSource("extensions/ampi-tui/index.ts");
  beforeCreate?.();
  const mock = createMockPi();
  createMmrTuiExtension({ loadSettings: () => settings })(mock.pi);
  return mock;
}

async function chromeOwner() {
  const { getMmrChromeOwner } = await importSource("extensions/ampi-core/chrome-owner.ts");
  return getMmrChromeOwner();
}

/** Pi's footer data with a branch that tests can change. */
function fakeFooterData(branch) {
  const listeners = new Set();
  const state = { branch };
  const data = {
    getGitBranch: () => state.branch,
    onBranchChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { data, listeners, state };
}

/** A TUI that never starts, with render requests counted. */
function fakeTui(rows = 24) {
  const terminal = new Proxy({ columns: 80, rows }, { get: (target, name) => (name in target ? target[name] : () => {}) });
  const tui = new TuiMainScreen(terminal);
  tui.renders = 0;
  tui.requestRender = () => {
    tui.renders += 1;
  };
  return tui;
}

const editorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};

const startEvent = { type: "session_start", reason: "startup" };
const shutdownEvent = { type: "session_shutdown", reason: "quit" };

describe("ampi-tui extension", () => {
  afterEach(async () => {
    // Leave no owner behind for the next case (the seam is process-global).
    assert.equal(await chromeOwner(), undefined, "each case must release the chrome owner");
  });

  it("takes the chrome and removes the footer in an interactive terminal session", async () => {
    const { handlers } = await loadExtension({ enabled: true });
    const { ctx, footers, headers } = createMockExtensionContext({ hasUI: true });

    await handlers.get("session_start")(startEvent, ctx);

    assert.equal(await chromeOwner(), "ampi-tui");
    assert.equal(headers.length, 1, "the welcome header replaces Pi's");
    assert.equal(footers.length, 1);
    const branch = fakeFooterData("main");
    const footer = footers[0](fakeTui(), undefined, branch.data);
    assert.deepEqual(footer.render(140), []);
    assert.deepEqual(footer.render(80), []);
    footer.dispose();
    assert.equal(branch.listeners.size, 0, "the footer stops following the branch when Pi disposes it");

    await handlers.get("session_shutdown")(shutdownEvent, ctx);
    assert.equal(await chromeOwner(), undefined);
  });

  it("keeps the welcome mark on its first frame when NO_ANIMATION is set", async (t) => {
    setNoAnimation(t);
    const { handlers } = await loadExtension({ enabled: true });
    const { ctx, headers } = createMockExtensionContext({ hasUI: true });
    await handlers.get("session_start")(startEvent, ctx);
    try {
      const header = headers[0](fakeTui(44), ctx.ui.theme);
      assert.equal(header.animating, false);
      assert.equal(header.frame, 0);
    } finally {
      await handlers.get("session_shutdown")(shutdownEvent, ctx);
    }
  });

  it("registers once across repeated session starts and releases on one shutdown", async () => {
    const { handlers } = await loadExtension({ enabled: true });
    const { ctx, footers } = createMockExtensionContext({ hasUI: true });

    await handlers.get("session_start")(startEvent, ctx);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.equal(footers.length, 2, "each session start removes the footer again");

    await handlers.get("session_shutdown")(shutdownEvent, ctx);
    assert.equal(await chromeOwner(), undefined);
  });

  it("replaces Pi's editor with the prompt box, hides Pi's working row and follows the turn", async () => {
    const { handlers } = await loadExtension({ enabled: true });
    const { ctx, footers, editors, workingVisible, entries } = createMockExtensionContext({ hasUI: true, cwd: "/work/demo" });
    await handlers.get("session_start")(startEvent, ctx);
    try {
      assert.deepEqual(workingVisible, [false]);
      assert.equal(editors.length, 1);
      const tui = fakeTui();
      const branch = fakeFooterData("main");
      footers[0](tui, undefined, branch.data);
      const box = editors[0](tui, editorTheme, new KeybindingsManager({}));
      tui.setFocus(box);
      const top = () => stripTerminalSequences(box.render(80)[0]);
      const bottom = () => stripTerminalSequences(box.render(80).at(-1));

      assert.match(bottom(), /^╰─+ \/work\/demo \(main\) ─╯$/);
      assert.ok(!top().includes("$"), "a fresh session shows no gauge");

      handlers.get("turn_start")({ type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
      assert.match(bottom(), /^╰ ∼ Sending · Enter to steer ─+ \/work\/demo \(main\) ─╯$/);
      assert.match(top(), / \$···· ─/, "the cost is unknown until the first response");
      entries.push({ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cost: { total: 0.0234 } } } });
      assert.match(top(), / \$0\.02 ─/);

      const renders = tui.renders;
      branch.state.branch = "feature";
      for (const listener of branch.listeners) listener();
      assert.ok(tui.renders > renders, "a branch change redraws");
      assert.match(bottom(), /\(feature\) ─╯$/);

      handlers.get("agent_settled")({ type: "agent_settled", aborted: false }, ctx);
      assert.match(bottom(), /^╰─+ \/work\/demo \(feature\) ─╯$/);
    } finally {
      await handlers.get("session_shutdown")(shutdownEvent, ctx);
    }
  });

  it("prices the gauge as thread show cost does, and hides it when ampiThreads.showCosts is off", async () => {
    const { handlers } = await loadExtension({ enabled: true });
    const models = [{ provider: "acme", id: "priced", cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }];
    const { ctx, footers, editors, entries } = createMockExtensionContext({ hasUI: true, models });
    const seam = await importSource("extensions/ampi-core/thread-reports.ts");
    await handlers.get("session_start")(startEvent, ctx);
    let release;
    try {
      const tui = fakeTui();
      footers[0](tui, undefined, fakeFooterData(undefined).data);
      const box = editors[0](tui, editorTheme, new KeybindingsManager({}));
      const top = () => stripTerminalSequences(box.render(80)[0]);
      const usage = (input, output, total) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: { total } });
      // No recorded cost: 1000 × 3 + 1000 × 15 per million = $0.018. The cache warm entry recorded $0.012.
      entries.push({ type: "message", message: { role: "assistant", provider: "acme", model: "priced", usage: usage(1000, 1000, 0) } });
      entries.push({ type: "usage", kind: "cache_warm", provider: "acme", model: "priced", usage: usage(0, 0, 0.012) });
      assert.match(top(), / \$0\.03 ─/);

      release = seam.registerMmrThreadReports({ showCosts: false, cost: () => undefined, analyzeContext: () => undefined });
      entries.push({ type: "message", message: { role: "user", content: "next" } });
      assert.ok(!top().includes("$"), "showCosts: false hides the gauge");
    } finally {
      release?.();
      await handlers.get("session_shutdown")(shutdownEvent, ctx);
    }
  });

  it("clears the prompt on the first Esc of a running turn and shows Cancelling on the second", async () => {
    const { handlers } = await loadExtension({ enabled: true });
    const { ctx, footers, editors, terminalInput, state, lifecycle } = createMockExtensionContext({ hasUI: true, idle: false, cwd: "/work/demo" });
    await handlers.get("session_start")(startEvent, ctx);
    try {
      const tui = fakeTui();
      footers[0](tui, undefined, fakeFooterData(undefined).data);
      const box = editors[0](tui, editorTheme, new KeybindingsManager({}));
      tui.setFocus(box);
      handlers.get("turn_start")({ type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
      state.editorText = "half a thought";
      assert.equal(terminalInput.send("\x1b"), true);
      assert.equal(state.editorText, "", "the first Esc clears the prompt");
      assert.equal(lifecycle.abort, 0);
      assert.equal(terminalInput.send("\x1b"), true);
      assert.equal(lifecycle.abort, 1);
      assert.match(stripTerminalSequences(box.render(80).at(-1)), /^╰ ∼ Cancelling ─/);
    } finally {
      await handlers.get("session_shutdown")(shutdownEvent, ctx);
    }
  });

  it("shows the force-quit hint after the first Ctrl+C", async () => {
    const { handlers } = await loadExtension({ enabled: true });
    const { ctx, footers, editors, terminalInput } = createMockExtensionContext({ hasUI: true, cwd: "/work/demo" });
    await handlers.get("session_start")(startEvent, ctx);
    try {
      const tui = fakeTui();
      footers[0](tui, undefined, fakeFooterData(undefined).data);
      const box = editors[0](tui, editorTheme, new KeybindingsManager({}));
      tui.setFocus(box);
      terminalInput.send("\x03");
      assert.match(stripTerminalSequences(box.render(80).at(-1)), /^╰ ctrl\+c again to force quit ─/);
      terminalInput.send("x");
      assert.doesNotMatch(stripTerminalSequences(box.render(80).at(-1)), /force quit/, "another key ends the chord and the hint");
    } finally {
      await handlers.get("session_shutdown")(shutdownEvent, ctx);
    }
  });

  it("dims the prompt box frame while the command palette is open", async () => {
    const { handlers } = await loadExtension({ enabled: true });
    const { ctx, footers, editors, terminalInput, overlays } = createMockExtensionContext({ hasUI: true, cwd: "/work/demo" });
    await handlers.get("session_start")(startEvent, ctx);
    try {
      const tui = fakeTui();
      footers[0](tui, undefined, fakeFooterData(undefined).data);
      const box = editors[0](tui, editorTheme, new KeybindingsManager({}));
      tui.setFocus(box);
      const dim = () => box.render(80)[0].startsWith("\x1b[2m╭");
      assert.equal(dim(), false);
      assert.equal(terminalInput.send("\x0f"), true);
      const palette = overlays.at(-1);
      assert.equal(palette.options.overlayOptions.anchor, "center", "Ctrl+O opened the palette");
      assert.equal(dim(), true, "the frame dims while the palette is open");
      palette.component.handleInput("\x1b");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(palette.closed, true);
      assert.equal(dim(), false, "closing the palette restores the frame");
    } finally {
      await handlers.get("session_shutdown")(shutdownEvent, ctx);
    }
  });

  it("opens the shortcuts help on ? in an empty prompt, listing the session's keys, and closes it on Esc", async () => {
    // Outside tmux the help asks nothing of tmux.
    const tmux = process.env.TMUX;
    delete process.env.TMUX;
    const { handlers } = await loadExtension({ enabled: true });
    const { ctx, footers, editors, terminalInput, overlays, state } = createMockExtensionContext({ hasUI: true, cwd: "/work/demo" });
    await handlers.get("session_start")(startEvent, ctx);
    try {
      const tui = fakeTui();
      footers[0](tui, undefined, fakeFooterData(undefined).data);
      const box = editors[0](tui, editorTheme, new KeybindingsManager({}));
      tui.setFocus(box);
      assert.equal(terminalInput.send("?"), true);
      const lines = box.render(80).map(stripTerminalSequences);
      assert.match(lines[1], /^│ Alt\+Enter newline +@ mention files +│$/, "no mode keys without ampi-core");
      assert.match(lines[2], /^│ Ctrl\+X leader key +Ctrl\+O open command palette +│$/);
      assert.match(lines[5], /^│ Ctrl\+G open in editor +Ctrl\+R history +│$/);
      assert.match(lines[6], /^│ Alt\+T toggle details +\? toggle shortcuts help +│$/);
      assert.equal(lines[7], `│ ${"─".repeat(76)} │`);

      box.handleInput("\x1b");
      assert.equal(box.render(80).length, 5);

      // A key that runs another command closes the help: / opens the palette.
      assert.equal(terminalInput.send("?"), true);
      assert.equal(terminalInput.send("/"), true);
      assert.equal(overlays.at(-1).options.overlayOptions.anchor, "center", "/ opened the palette");
      assert.equal(box.render(80).length, 5, "the help closed behind it");
      overlays.at(-1).component.handleInput("\x1b");
      await new Promise((resolve) => setImmediate(resolve));

      state.editorText = "why";
      assert.equal(terminalInput.send("?"), false, "with text, ? is typed");
    } finally {
      await handlers.get("session_shutdown")(shutdownEvent, ctx);
      if (tmux !== undefined) process.env.TMUX = tmux;
    }
  });

  it("does nothing at all when disabled", async () => {
    const { handlers } = await loadExtension({ enabled: false });
    assert.deepEqual([...handlers.keys()], []);
    assert.equal(await chromeOwner(), undefined);
  });

  for (const [label, options] of [
    ["print or JSON (no UI)", { hasUI: false }],
    ["RPC (dialogs but no terminal)", { hasUI: true, mode: "rpc" }],
  ]) {
    it(`leaves ${label} sessions untouched`, async () => {
      const { handlers } = await loadExtension({ enabled: true });
      const { ctx, footers, headers, statuses, notifications, editors, workingVisible } = createMockExtensionContext(options);

      await handlers.get("session_start")(startEvent, ctx);

      assert.equal(footers.length, 0);
      assert.equal(headers.length, 0);
      assert.equal(editors.length, 0, "Pi's editor stays");
      assert.equal(workingVisible.length, 0);
      assert.equal(statuses.length, 0);
      assert.equal(notifications.length, 0);
      assert.equal(await chromeOwner(), undefined);
      await handlers.get("session_shutdown")(shutdownEvent, ctx);
    });
  }
});

describe("ampi-tui terminal title wiring", () => {
  it("titles an interactive session after Pi's own title, follows the turn and clears it at shutdown", async (t) => {
    const { handlers } = await loadExtension({ enabled: true }, () => t.mock.timers.enable({ apis: ["setTimeout", "Date"] }));
    const { ctx, titles } = createMockExtensionContext({ hasUI: true, cwd: "/work/demo", sessionName: "Parser rename" });
    await handlers.get("session_start")(startEvent, ctx);
    try {
      assert.deepEqual(titles, []);
      t.mock.timers.tick(250);
      assert.deepEqual(titles, ["Parser rename - ampi - /work/demo"]);
      t.mock.timers.tick(1_000);
      await handlers.get("turn_start")({ type: "turn_start" }, ctx);
      assert.equal(titles.at(-1), "∼ Parser rename - ampi - /work/demo");
      t.mock.timers.tick(250);
      assert.equal(titles.at(-1), "≈ Parser rename - ampi - /work/demo");
    } finally {
      await handlers.get("session_shutdown")(shutdownEvent, ctx);
    }
    assert.equal(titles.at(-1), "");
  });

  it("leaves the title alone outside the terminal UI", async (t) => {
    const { handlers } = await loadExtension({ enabled: true }, () => t.mock.timers.enable({ apis: ["setTimeout", "Date"] }));
    const { ctx, titles } = createMockExtensionContext({ hasUI: false, cwd: "/work/demo" });
    await handlers.get("session_start")(startEvent, ctx);
    await handlers.get("turn_start")({ type: "turn_start" }, ctx);
    t.mock.timers.tick(1_000);
    await handlers.get("session_shutdown")(shutdownEvent, ctx);
    assert.deepEqual(titles, []);
  });
});

describe("ampi-tui settings", () => {
  function withDirs(run) {
    const root = mkdtempSync(path.join(os.tmpdir(), "ampi-tui-settings-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
    mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    const writeGlobal = (value) => writeFileSync(path.join(home, ".pi/agent/settings.json"), JSON.stringify(value));
    const writeProject = (value) => writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify(value));
    return Promise.resolve(run({ home, cwd, writeGlobal, writeProject })).finally(() =>
      rmSync(root, { recursive: true, force: true }),
    );
  }

  it("is on by default", async () => {
    const { loadMmrTuiSettings } = await importSource("extensions/ampi-tui/config.ts");
    await withDirs(({ home, cwd }) => {
      assert.deepEqual(loadMmrTuiSettings(cwd, { homeDirectory: home, env: {} }), {
        enabled: true,
        quietStartup: false,
        notifications: { enabled: true, system: true, sound: false },
      });
    });
  });

  it("reads each ampiTui.notifications switch on its own, the project file winning per key", async () => {
    const { loadMmrTuiSettings } = await importSource("extensions/ampi-tui/config.ts");
    await withDirs(({ home, cwd, writeGlobal, writeProject }) => {
      const load = () => loadMmrTuiSettings(cwd, { homeDirectory: home, env: {} }).notifications;
      writeGlobal({ ampiTui: { notifications: { sound: true, system: false } } });
      assert.deepEqual(load(), { enabled: true, system: false, sound: true });
      writeProject({ ampi: { tui: { notifications: { system: true, enabled: "no" } } } });
      assert.deepEqual(load(), { enabled: true, system: true, sound: true }, "a non-boolean value is ignored");
      writeProject({ ampiTui: { notifications: { enabled: false } } });
      assert.deepEqual(load(), { enabled: false, system: false, sound: true });
    });
  });

  it("reads ampiTui.enabled globally, lets the project override it, and accepts nested ampi.tui", async () => {
    const { loadMmrTuiSettings } = await importSource("extensions/ampi-tui/config.ts");
    await withDirs(({ home, cwd, writeGlobal, writeProject }) => {
      const load = () => loadMmrTuiSettings(cwd, { homeDirectory: home, env: {} }).enabled;
      writeGlobal({ ampiTui: { enabled: false } });
      assert.equal(load(), false);
      writeProject({ ampi: { tui: { enabled: true } } });
      assert.equal(load(), true);
      writeProject({ ampiTui: { enabled: "no" } });
      assert.equal(load(), false, "a non-boolean value is ignored, so the global value stands");
    });
  });

  it("reads Pi's quietStartup, where only true silences the header and the project file wins", async () => {
    const { loadMmrTuiSettings } = await importSource("extensions/ampi-tui/config.ts");
    await withDirs(({ home, cwd, writeGlobal, writeProject }) => {
      const load = () => loadMmrTuiSettings(cwd, { homeDirectory: home, env: {} }).quietStartup;
      writeGlobal({ quietStartup: true });
      assert.equal(load(), true);
      writeProject({ quietStartup: "header" });
      assert.equal(load(), false, "\"header\" keeps Pi's header, so ampi's welcome shows too");
      writeProject({});
      assert.equal(load(), true, "a project file without the key keeps the global value");
    });
  });

  it("lets AMPI_TUI_ENABLE (legacy MMR_TUI_ENABLE) override settings files", async () => {
    const { loadMmrTuiSettings } = await importSource("extensions/ampi-tui/config.ts");
    await withDirs(({ home, cwd, writeGlobal }) => {
      writeGlobal({ ampiTui: { enabled: true } });
      const load = (env) => loadMmrTuiSettings(cwd, { homeDirectory: home, env }).enabled;
      assert.equal(load({ AMPI_TUI_ENABLE: "false" }), false);
      assert.equal(load({ MMR_TUI_ENABLE: "0" }), false);
      assert.equal(load({ AMPI_TUI_ENABLE: "true", MMR_TUI_ENABLE: "false" }), true);
    });
  });
});

describe("ampi-tui package wiring", () => {
  it("auto-loads after ampi-custom-subagents and before ampi-threads, with ampi-history last", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const order = pkg.pi.extensions;
    const tui = order.indexOf("./src/extensions/ampi-tui/index.ts");
    assert.equal(order[tui - 1], "./src/extensions/ampi-custom-subagents/index.ts");
    assert.equal(order[tui + 1], "./src/extensions/ampi-threads/index.ts");
    assert.equal(order.at(-1), "./src/extensions/ampi-history/index.ts");
  });
});
