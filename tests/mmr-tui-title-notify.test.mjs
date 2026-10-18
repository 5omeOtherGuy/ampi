// Terminal title and notifications: formatter, notification policy, and the
// controller that follows the thread status on a fake clock.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

let mod;

before(async () => {
  mod = await importSource("extensions/ampi-tui/chrome/title-notify.ts");
});

const ESC = "\u001b";
const osc = (text) => `${ESC}]777;notify;ampi;${text}${ESC}\\`;
const idle = { busy: false, attention: false, label: "", phase: "idle" };
const thinking = { busy: true, attention: false, label: "Thinking", phase: "thinking" };
const approval = { busy: true, attention: true, label: "Waiting for Approval", phase: "waitingApproval" };
const failed = { busy: false, attention: true, label: "Error", phase: "error" };
const userEntry = (content) => ({ type: "message", message: { role: "user", content } });

/** A fake clock whose timers run when `advance` passes their time. */
function fakeClock() {
  let time = 1_000;
  const timers = [];
  return {
    now: () => time,
    setTimer: (callback, ms) => {
      const timer = { callback, at: time + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    pending: () => timers.filter((timer) => !timer.cleared).length,
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = timers.filter((timer) => !timer.cleared && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        time = next.at;
        next.cleared = true;
        next.callback();
      }
      time = end;
    },
  };
}

describe("ampi-tui session title", () => {
  it("prefers the session name, then the first user message, then 'new session'", () => {
    assert.equal(mod.formatMmrSessionTitle("Parser rename", "fix the parser"), "Parser rename");
    assert.equal(mod.formatMmrSessionTitle("   ", "fix the parser"), "fix the parser", "a blank name does not count");
    assert.equal(mod.formatMmrSessionTitle(undefined, "  \n "), "new session");
    assert.equal(mod.formatMmrSessionTitle(undefined, undefined), "new session");
  });

  it("cuts the first message to 40 columns and keeps it on one plain line", () => {
    const forty = "a".repeat(40);
    assert.equal(mod.formatMmrSessionTitle(undefined, forty), forty, "exactly 40 columns stay whole");
    assert.equal(mod.formatMmrSessionTitle(undefined, `${forty}b`), `${"a".repeat(39)}…`);
    assert.equal(mod.formatMmrSessionTitle(undefined, "line one\n\n  line\ttwo"), "line one line two");
    assert.equal(mod.formatMmrSessionTitle(undefined, `bell\u0007 ${ESC}]0;evil${ESC}\\ and ${ESC}[31mred`), "bell and red");
    // Wide characters take two columns each: 20 of them fill the 40.
    const wide = "語".repeat(21);
    assert.equal(mod.formatMmrSessionTitle(undefined, wide), `${"語".repeat(19)}…`);
  });

  it("finds the first user message among the session entries", () => {
    const entries = [
      { type: "model_change" },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
      userEntry([{ type: "image" }, { type: "text", text: "first" }, { type: "text", text: "part" }]),
      userEntry("second"),
    ];
    assert.equal(mod.firstMmrUserMessage(entries), " first part");
    assert.equal(mod.firstMmrUserMessage([userEntry("plain")]), "plain");
    assert.equal(mod.firstMmrUserMessage([{ type: "custom" }]), undefined);
  });
});

describe("ampi-tui terminal title", () => {
  const base = { title: "fix the parser", cwd: "/work/demo" };

  it("names the session and the directory when idle", () => {
    assert.equal(mod.formatMmrTerminalTitle({ ...base, status: idle, waveFrame: 2 }), "fix the parser - ampi - /work/demo");
  });

  it("puts the status slot's wave glyph in front while busy, stepping through its frames", () => {
    const glyphs = [0, 1, 2, 3, -1].map((waveFrame) => mod.formatMmrTerminalTitle({ ...base, status: thinking, waveFrame })[0]);
    assert.deepEqual(glyphs, ["∼", "≈", "≋", "∼", "≋"]);
    assert.equal(mod.formatMmrTerminalTitle({ ...base, status: thinking, waveFrame: 1 }), "≈ fix the parser - ampi - /work/demo");
  });

  it("switches to the attention form, busy or not", () => {
    assert.equal(
      mod.formatMmrTerminalTitle({ ...base, status: approval, waveFrame: 1 }),
      "! Waiting for Approval: fix the parser - ampi - /work/demo",
    );
    assert.equal(mod.formatMmrTerminalTitle({ ...base, status: failed, waveFrame: 0 }), "! Error: fix the parser - ampi - /work/demo");
  });
});

describe("ampi-tui notification policy", () => {
  const on = { enabled: true, system: true, sound: false };

  function makeNotifier({ settings = on, env = {}, files = [] } = {}) {
    const clock = fakeClock();
    const writes = [];
    const spawns = [];
    const notifier = mod.createMmrNotifier({
      settings,
      env,
      now: clock.now,
      write: (data) => writes.push(data),
      spawn: (command, args) => spawns.push([command, ...args]),
      exists: (file) => files.includes(file),
    });
    return { notifier, clock, writes, spawns };
  }

  it("sends an OSC 777 notification with ampi's own text for each kind", () => {
    const { notifier, clock, writes } = makeNotifier();
    assert.equal(notifier.notify("ready"), true);
    clock.advance(2_000);
    notifier.notify("approval");
    clock.advance(2_000);
    notifier.notify("error");
    assert.deepEqual(writes, [osc("ampi is ready"), osc("ampi needs your approval"), osc("ampi stopped on an error")]);
  });

  it("sends at most one notification every two seconds", () => {
    const { notifier, clock, writes } = makeNotifier();
    notifier.notify("ready");
    clock.advance(1_999);
    assert.equal(notifier.notify("approval"), false);
    clock.advance(1);
    assert.equal(notifier.notify("approval"), true);
    assert.equal(writes.length, 2);
  });

  it("rings the bell instead over SSH or with AMPI_FORCE_BEL", () => {
    for (const env of [{ SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22" }, { SSH_TTY: "/dev/pts/3" }, { AMPI_FORCE_BEL: "1" }]) {
      const { notifier, writes } = makeNotifier({ env });
      notifier.notify("ready");
      assert.deepEqual(writes, ["\u0007"], JSON.stringify(env));
    }
    const { notifier: plain, writes } = makeNotifier({ env: { AMPI_FORCE_BEL: "0" } });
    plain.notify("ready");
    assert.deepEqual(writes, [osc("ampi is ready")]);
  });

  it("does nothing when notifications are off, and nothing on the terminal without system", () => {
    const off = makeNotifier({ settings: { enabled: false, system: true, sound: true }, env: { PATH: "/usr/bin" } });
    assert.equal(off.notifier.notify("ready"), false);
    assert.deepEqual([off.writes, off.spawns], [[], []]);
    const quiet = makeNotifier({ settings: { enabled: true, system: false, sound: false } });
    assert.equal(quiet.notifier.notify("ready"), false);
    assert.deepEqual(quiet.writes, []);
  });

  it("plays a freedesktop sound through paplay when sound is on and both exist", () => {
    const settings = { enabled: true, system: false, sound: true };
    const files = ["/opt/bin/paplay", "/usr/share/sounds/freedesktop/stereo/complete.oga", "/usr/share/sounds/freedesktop/stereo/dialog-warning.oga"];
    const env = { PATH: "/usr/local/bin:/opt/bin" };
    const played = makeNotifier({ settings, env, files });
    assert.equal(played.notifier.notify("ready"), true);
    played.clock.advance(2_000);
    played.notifier.notify("approval");
    assert.deepEqual(played.spawns, [
      ["/opt/bin/paplay", "/usr/share/sounds/freedesktop/stereo/complete.oga"],
      ["/opt/bin/paplay", "/usr/share/sounds/freedesktop/stereo/dialog-warning.oga"],
    ]);
    assert.deepEqual(played.writes, [], "system off: no escape sequence");

    const noPlayer = makeNotifier({ settings, env: { PATH: "/usr/local/bin" }, files });
    assert.equal(noPlayer.notifier.notify("ready"), false);
    const remote = makeNotifier({ settings, env: { ...env, SSH_TTY: "/dev/pts/1" }, files });
    assert.equal(remote.notifier.notify("ready"), false, "a sound over SSH would play on the remote machine");
    assert.deepEqual([noPlayer.spawns, remote.spawns], [[], []]);
  });
});

describe("ampi-tui title and notification controller", () => {
  function setup({ settings = { enabled: true, system: true, sound: false }, entries = [] } = {}) {
    const clock = fakeClock();
    const writes = [];
    const feed = { status: idle };
    const mock = createMockPi();
    const context = createMockExtensionContext({ cwd: "/work/demo", entries });
    const controller = mod.createMmrTitleNotify(mock.pi, feed, {
      settings,
      env: {},
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      write: (data) => writes.push(data),
    });
    const emit = (type, event = {}) => mock.handlers.get(type)({ type, ...event }, context.ctx);
    const setStatus = (status) => {
      feed.status = status;
      controller.statusChanged();
    };
    return { controller, clock, writes, titles: context.titles, ctx: context.ctx, emit, setStatus, entries: context.entries };
  }

  it("writes the first title one interval after session start, after Pi's own", () => {
    const { controller, clock, titles, ctx } = setup();
    controller.start(ctx);
    clock.advance(249);
    assert.deepEqual(titles, []);
    clock.advance(1);
    assert.deepEqual(titles, ["new session - ampi - /work/demo"]);
    controller.stop();
  });

  it("steps the glyph at most four times a second while busy and settles on the idle title", () => {
    const { controller, clock, titles, ctx, setStatus, entries } = setup();
    controller.start(ctx);
    clock.advance(1_000);
    entries.push(userEntry("rename the parser module"));
    setStatus(thinking);
    // Status changes inside one interval do not add writes.
    setStatus({ ...thinking, label: "Streaming", phase: "streaming" });
    setStatus(thinking);
    clock.advance(1_000);
    const busy = titles.slice(1);
    assert.equal(busy.length, 5, "the write on the change, then one per 250 ms");
    assert.deepEqual(
      busy.map((title) => title[0]),
      ["∼", "≈", "≋", "∼", "≈"],
    );
    assert.equal(busy[0], "∼ rename the parser module - ampi - /work/demo");
    setStatus(idle);
    clock.advance(250);
    assert.equal(titles.at(-1), "rename the parser module - ampi - /work/demo");
    clock.advance(5_000);
    assert.equal(titles.at(-1), "rename the parser module - ampi - /work/demo");
    assert.equal(clock.pending(), 0, "no timer runs while idle");
    controller.stop();
  });

  it("writes the attention form and notifies once when an approval starts waiting", () => {
    const { controller, clock, titles, writes, ctx, setStatus } = setup();
    controller.start(ctx);
    clock.advance(1_000);
    setStatus(thinking);
    clock.advance(500);
    setStatus(approval);
    setStatus(approval);
    clock.advance(250);
    assert.equal(titles.at(-1), "! Waiting for Approval: new session - ampi - /work/demo");
    assert.deepEqual(writes, [osc("ampi needs your approval")]);
    controller.stop();
  });

  it("notifies when a run settles, with the error text after a failure, and not after an abort", () => {
    const { controller, clock, writes, ctx, emit, setStatus } = setup();
    controller.start(ctx);
    setStatus(idle);
    emit("agent_settled", { aborted: true });
    assert.deepEqual(writes, [], "the user stopped the run and is at the terminal");
    emit("agent_settled", { aborted: false });
    clock.advance(2_000);
    setStatus(failed);
    emit("agent_settled", { aborted: false });
    assert.deepEqual(writes, [osc("ampi is ready"), osc("ampi stopped on an error")]);
    controller.stop();
  });

  it("re-asserts the title after Pi rewrites its own on a rename", () => {
    const { controller, clock, titles, ctx, emit } = setup();
    controller.start(ctx);
    clock.advance(1_000);
    emit("session_info_changed", { name: undefined });
    assert.deepEqual(titles, ["new session - ampi - /work/demo", "new session - ampi - /work/demo"]);
    controller.stop();
  });

  it("clears the title on stop and does nothing outside a started session", () => {
    const { controller, clock, titles, writes, ctx, emit, setStatus } = setup();
    setStatus(thinking);
    emit("agent_settled", { aborted: false });
    clock.advance(1_000);
    assert.deepEqual([titles, writes], [[], []], "never started: print, JSON and RPC runs");
    controller.start(ctx);
    clock.advance(250);
    controller.stop();
    assert.equal(titles.at(-1), "");
    const count = titles.length;
    setStatus(idle);
    emit("agent_settled", { aborted: false });
    clock.advance(1_000);
    assert.equal(titles.length, count);
    assert.deepEqual(writes, []);
  });

  it("keeps the title but sends nothing with notifications off", () => {
    const { controller, clock, titles, writes, ctx, emit, setStatus } = setup({
      settings: { enabled: false, system: true, sound: true },
    });
    controller.start(ctx);
    clock.advance(250);
    setStatus(approval);
    setStatus(idle);
    emit("agent_settled", { aborted: false });
    assert.ok(titles.length > 0);
    assert.deepEqual(writes, []);
    controller.stop();
  });
});
