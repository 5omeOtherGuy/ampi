// Welcome header: layout fixtures, animation on a fake clock, card dismissal,
// and the changelog card built from a fixture CHANGELOG.
//
// PI_MMR_UPDATE_FIXTURES=1 rewrites the layout snapshots in
// tests/fixtures/ampi-tui-welcome/; every other run pins them.

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const fixtureDir = path.join(import.meta.dirname, "fixtures/ampi-tui-welcome");
const UPDATE_FIXTURES = process.env.PI_MMR_UPDATE_FIXTURES === "1";

const plainTheme = { fg: (_token, text) => text, bold: (text) => text };
const taggedTheme = { fg: (token, text) => `<${token}>${text}</${token}>`, bold: (text) => `<b>${text}</b>` };

const CARD = {
  title: "New in ampi 1.2.0",
  summary:
    "ampi-tui: a welcome screen with ampi's mark and the newest changelog item, shown when an interactive session starts, " +
    "with a summary long enough to need more than three rows of the card.",
};

// Truncation adds SGR resets around its ellipsis even with a plain theme.
const stripSgr = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

function assertFixture(name, lines) {
  const actual = `${lines.map((line) => stripSgr(line).trimEnd()).join("\n")}\n`;
  const fixturePath = path.join(fixtureDir, name);
  if (UPDATE_FIXTURES) {
    writeFileSync(fixturePath, actual);
    return;
  }
  assert.ok(existsSync(fixturePath), `missing fixture ${name}; rerun with PI_MMR_UPDATE_FIXTURES=1`);
  assert.equal(actual, readFileSync(fixturePath, "utf8"), `fixture ${name} drift; rerun with PI_MMR_UPDATE_FIXTURES=1 to refresh`);
}

function fakeTimers() {
  const intervals = new Map();
  let next = 1;
  return {
    timers: {
      setInterval: (callback, ms) => {
        intervals.set(next, { callback, ms });
        return next++;
      },
      clearInterval: (handle) => intervals.delete(handle),
    },
    intervals,
    tick() {
      for (const { callback } of [...intervals.values()]) callback();
    },
  };
}

describe("ampi-tui welcome layout", () => {
  for (const [width, rows] of [
    [140, 44],
    [80, 24],
  ]) {
    it(`matches the ${width}x${rows} fixtures for the first, second and last frame`, async () => {
      const { renderMmrWelcome, MMR_WELCOME_FRAME_COUNT } = await importSource("extensions/ampi-tui/chrome/welcome.ts");
      const last = MMR_WELCOME_FRAME_COUNT - 1;
      for (const frame of [0, 1, last]) {
        const lines = renderMmrWelcome({ width, rows, frame, card: CARD, theme: plainTheme });
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
        assertFixture(`${width}x${rows}-frame${frame === last ? "last" : frame}.txt`, lines);
      }
      assert.notDeepEqual(
        renderMmrWelcome({ width, rows, frame: 0, card: CARD, theme: plainTheme }),
        renderMmrWelcome({ width, rows, frame: 1, card: CARD, theme: plainTheme }),
        "consecutive frames differ",
      );
    });
  }

  it("shrinks on short terminals, drops the mark when narrow, and centres the hints without a card", async () => {
    const { renderMmrWelcome } = await importSource("extensions/ampi-tui/chrome/welcome.ts");
    const short = renderMmrWelcome({ width: 140, rows: 24, frame: 0, card: CARD, theme: plainTheme });
    assert.equal(short.length, 5, "a 24-row terminal gets the five-row mark even when wide");
    assert.equal(short.filter((line) => line.includes("dismiss")).length, 1, "and the one-line card");

    assertFixture("140x44-no-card.txt", renderMmrWelcome({ width: 140, rows: 44, frame: 0, theme: plainTheme }));
    assertFixture("50x20-narrow.txt", renderMmrWelcome({ width: 50, rows: 20, frame: 0, card: CARD, theme: plainTheme }));
  });

  it("styles keys, descriptions, the mark's head and the card through theme tokens", async () => {
    const { renderMmrWelcome } = await importSource("extensions/ampi-tui/chrome/welcome.ts");
    // Wide enough that the tags themselves never force a truncation.
    const text = renderMmrWelcome({ width: 400, rows: 44, frame: 0, card: CARD, theme: taggedTheme }).join("\n");
    assert.match(text, /<b><accent>ctrl\+o<\/accent><\/b><dim> for commands · <\/dim><b><accent>\?<\/accent><\/b><dim> for shortcuts<\/dim>/);
    assert.match(text, /<b>Welcome to <\/b><b><success>ampi<\/success><\/b>/);
    assert.match(text, /<b><success>●<\/success><\/b>/, "the outer ring's head is bold green");
    assert.match(text, /<b><accent>●<\/accent><\/b>/, "the inner ring's head uses the accent colour");
    assert.match(text, /<dim>dismiss<\/dim>/);
    assert.match(text, /<success>▍<\/success> <dim>\/ampi-changelog lists every change<\/dim>/);
  });
});

describe("ampi-tui welcome header component", () => {
  it("animates on the injected clock, rests on the last frame, and asks for a render each frame", async () => {
    const { MmrWelcomeHeader, MMR_WELCOME_FRAME_COUNT, MMR_WELCOME_FRAME_MS } = await importSource(
      "extensions/ampi-tui/chrome/welcome.ts",
    );
    const clock = fakeTimers();
    let renders = 0;
    const header = new MmrWelcomeHeader({
      theme: plainTheme,
      animate: true,
      timers: clock.timers,
      requestRender: () => renders++,
      rows: () => 44,
    });
    assert.equal(clock.intervals.size, 1);
    assert.equal([...clock.intervals.values()][0].ms, MMR_WELCOME_FRAME_MS);
    assert.ok(MMR_WELCOME_FRAME_MS >= 100 && MMR_WELCOME_FRAME_MS <= 200);

    clock.tick();
    assert.equal(header.frame, 1);
    for (let i = 0; i < MMR_WELCOME_FRAME_COUNT + 10; i++) clock.tick();
    assert.equal(header.frame, MMR_WELCOME_FRAME_COUNT - 1, "stops on the last frame");
    assert.equal(header.animating, false);
    assert.equal(clock.intervals.size, 0, "the timer is cleared");
    assert.equal(renders, MMR_WELCOME_FRAME_COUNT - 1);
    assert.match(header.render(140).join("\n"), /Welcome to ampi/);
  });

  it("settles on the first message: the animation stops and the card goes", async () => {
    const { MmrWelcomeHeader } = await importSource("extensions/ampi-tui/chrome/welcome.ts");
    const clock = fakeTimers();
    const header = new MmrWelcomeHeader({ theme: plainTheme, card: CARD, animate: true, timers: clock.timers });
    clock.tick();
    assert.ok(header.render(140).some((line) => line.includes("New in ampi 1.2.0")));
    header.settle();
    assert.equal(header.animating, false);
    assert.equal(clock.intervals.size, 0);
    assert.equal(header.cardVisible, false);
    assert.ok(!header.render(140).some((line) => line.includes("dismiss")));
    assert.equal(header.frame, 1, "the mark keeps the frame it stopped on");
  });

  it("does not animate a resumed session and clears its timer on dispose", async () => {
    const { MmrWelcomeHeader } = await importSource("extensions/ampi-tui/chrome/welcome.ts");
    const clock = fakeTimers();
    const still = new MmrWelcomeHeader({ theme: plainTheme, animate: false, timers: clock.timers });
    assert.equal(still.animating, false);
    assert.equal(clock.intervals.size, 0);
    const moving = new MmrWelcomeHeader({ theme: plainTheme, animate: true, timers: clock.timers });
    moving.dispose();
    assert.equal(clock.intervals.size, 0);
  });

  it("treats key presses, not releases, mouse reports, focus changes or terminal replies, as dismissing input", async () => {
    const { isMmrKeyInput } = await importSource("extensions/ampi-tui/chrome/welcome.ts");
    for (const key of ["a", "\r", "\x1b", "\x1b[A", "\x0f", "\x1b[13;2u"]) assert.equal(isMmrKeyInput(key), true, JSON.stringify(key));
    // Kitty key-release reports follow every press when the terminal sends them.
    for (const report of ["\x1b[13;1:3u", "\x1b[97;5:3u", "\x1b[1;1:3A", "\x1b[<35;10;5M", "\x1b[M #!", "\x1b[I", "\x1b[O", "\x1b[?62;4c", "\x1b[6;18;9t", "\x1b]11;rgb:0000/0000/0000\x07", "\x1bP>|kitty\x1b\\", "\x1b_Gi=1;OK\x1b\\"]) {
      assert.equal(isMmrKeyInput(report), false, JSON.stringify(report));
    }
  });
});

describe("ampi-tui welcome card from the changelog", () => {
  function withFixturePackage(run, { changelog = "CHANGELOG.md", version = "1.2.0" } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), "ampi-tui-welcome-"));
    const packageRoot = path.join(root, "pkg");
    mkdirSync(packageRoot);
    copyFileSync(path.join(fixtureDir, changelog), path.join(packageRoot, "CHANGELOG.md"));
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "ampi", version }));
    return Promise.resolve(run({ packageRoot, statePath: path.join(root, "state.json") })).finally(() =>
      rmSync(root, { recursive: true, force: true }),
    );
  }

  const expectedCard = {
    title: "New in ampi 1.2.0",
    summary:
      "ampi-tui: a welcome screen with ampi's mark and the newest changelog item, shown when an interactive session starts (#12).",
  };

  it("shows the first item of the newest version as plain text", async () => {
    const { evaluateMmrChangelogForDisplay } = await importSource("extensions/ampi-core/changelog.ts");
    const { buildMmrWelcomeCard } = await importSource("extensions/ampi-tui/chrome/welcome.ts");
    await withFixturePackage(({ packageRoot, statePath }) => {
      const display = evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-09-02T00:00:00.000Z" });
      assert.deepEqual(buildMmrWelcomeCard(display), expectedCard);
    });
    assert.deepEqual(buildMmrWelcomeCard({ kind: "unreleased", displayVersion: "0.0.0", markdown: "## Unreleased\n\n### Added\n\n- Draft." }), {
      title: "New in ampi",
      summary: "Draft.",
    });
    assert.equal(buildMmrWelcomeCard({ kind: "versioned", displayVersion: "1.0.0", markdown: "## 1.0.0\n\nNo bullets." }), undefined);
  });

  it("reads a section release-please wrote, without its issue and commit links", async () => {
    const { evaluateMmrChangelogForDisplay } = await importSource("extensions/ampi-core/changelog.ts");
    const { buildMmrWelcomeCard } = await importSource("extensions/ampi-tui/chrome/welcome.ts");
    await withFixturePackage(
      ({ packageRoot, statePath }) => {
        const display = evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-10-21T00:00:00.000Z" });
        assert.deepEqual(buildMmrWelcomeCard(display), {
          title: "New in ampi 1.3.0",
          summary: "ampi-tui: add a welcome screen with the newest changelog item",
        });
      },
      { changelog: "CHANGELOG-release-please.md", version: "1.3.0" },
    );
  });

  // Pi records these before session_start in every new session.
  const startupEntries = [{ type: "model_change" }, { type: "thinking_level_change" }];

  async function startTui(settings, { entries = startupEntries } = {}) {
    const { createMmrTuiExtension } = await importSource("extensions/ampi-tui/index.ts");
    const mock = createMockPi();
    createMmrTuiExtension({ loadSettings: () => settings })(mock.pi);
    const context = createMockExtensionContext({ hasUI: true, entries });
    return { ...mock, ...context };
  }

  async function showNotice(ctx, packageRoot, statePath) {
    const { maybeShowMmrChangelogOnSessionStart } = await importSource("extensions/ampi-core/changelog.ts");
    await maybeShowMmrChangelogOnSessionStart({ type: "session_start", reason: "startup" }, ctx, {
      packageRoot,
      statePath,
      now: "2026-09-02T00:00:00.000Z",
    });
  }

  const tui = { terminal: { rows: 44 }, requestRender() {} };
  // The key dispatcher keeps its own raw input listener in every TUI session.
  const KEY_LISTENERS = 1;

  it("replaces ampi-core's notification with the card, which a key press dismisses", async () => {
    await withFixturePackage(async ({ packageRoot, statePath }) => {
      const { handlers, ctx, headers, notifications, terminalInput } = await startTui({ enabled: true });
      try {
        await showNotice(ctx, packageRoot, statePath);
        assert.deepEqual(notifications, [], "the card replaces the notification");

        await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
        assert.equal(headers.length, 1);
        const header = headers[0](tui, plainTheme);
        const screen = header.render(140).join("\n");
        assert.match(screen, /New in ampi 1\.2\.0 +dismiss/);
        assert.match(screen, /a welcome screen with ampi's mark/);
        assert.equal(header.animating, true, "a fresh session animates");

        assert.equal(terminalInput.listeners.size, KEY_LISTENERS + 1);
        assert.equal(terminalInput.send("\x1b[<35;10;5M"), false, "input passes through untouched");
        assert.equal(header.cardVisible, true, "a mouse report leaves the card");
        assert.equal(terminalInput.send("h"), false);
        assert.equal(header.cardVisible, false, "a key press dismisses it");
        assert.equal(terminalInput.listeners.size, KEY_LISTENERS, "and the listener goes away");

        handlers.get("input")({ type: "input", text: "from another extension", source: "extension" }, ctx);
        assert.equal(header.animating, true, "a prompt another extension sends leaves the header running");
        handlers.get("input")({ type: "input", text: "hello", source: "interactive" }, ctx);
        assert.equal(header.animating, false, "the first message stops the animation");
      } finally {
        await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
      }
    });
  });

  it("draws no header under Pi's quietStartup and leaves the notification to ampi-core", async () => {
    await withFixturePackage(async ({ packageRoot, statePath }) => {
      const { handlers, ctx, headers, notifications, terminalInput } = await startTui({ enabled: true, quietStartup: true });
      try {
        await showNotice(ctx, packageRoot, statePath);
        assert.equal(notifications.length, 1);
        assert.match(notifications[0].message, /ampi What's New \(v1\.2\.0\)/);
        await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
        assert.equal(headers.length, 0);
        assert.equal(terminalInput.listeners.size, KEY_LISTENERS);
      } finally {
        await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
      }
    });
  });

  it("keeps a resumed session's header still and without a card", async () => {
    const { handlers, ctx, headers, terminalInput } = await startTui({ enabled: true }, { entries: [...startupEntries, { type: "message" }] });
    try {
      await handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);
      const header = headers[0](tui, plainTheme);
      assert.equal(header.animating, false);
      assert.equal(header.cardVisible, false);
      assert.equal(terminalInput.listeners.size, KEY_LISTENERS);
    } finally {
      await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
    }
  });

  it("gives the notification back to ampi-core once the session shuts down", async () => {
    await withFixturePackage(async ({ packageRoot, statePath }) => {
      const { handlers, ctx, notifications } = await startTui({ enabled: true });
      await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx);
      await showNotice(ctx, packageRoot, statePath);
      assert.equal(notifications.length, 1);
    });
  });
});
