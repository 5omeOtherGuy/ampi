// The prompt queue: the box above the prompt box that lists queued messages,
// and the prompt.queue, prompt.dequeue and prompt.steerQueuedMessage
// commands. Pi's queue is played by the test: messages sent while a turn runs
// land in it, and the pi-compat watch reports it. Render fixtures live in
// tests/fixtures/mmr-tui-queue/: each holds the plain rendering for review
// followed by the exact lines with ANSI kept, at 80 and 140 columns.
// PI_MMR_UPDATE_FIXTURES=1 rewrites them; review the diff before committing.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures/mmr-tui-queue");
const UPDATE_FIXTURES = process.env.PI_MMR_UPDATE_FIXTURES === "1";
const WIDTHS = [80, 140];

const { createMmrPromptQueue, renderMmrQueueBox, MMR_QUEUE_WIDGET_ID } = await importSource("extensions/ampi-tui/editor/queue.ts");
const { createMmrStatusFeed } = await importSource("extensions/ampi-tui/editor/status-feed.ts");
const { getMmrCommand, rankMmrCommands } = await importSource("extensions/ampi-core/command-registry.ts");
const { getMmrPromptQueue, removeMmrQueuedPrompt } = await importSource("extensions/ampi-core/prompt-queue.ts");

/** Theme tokens as distinct 256-colour codes, so fixtures show which token styled what. */
const TOKEN_CODES = { accent: 6, dim: 242, muted: 246 };
const theme = {
  fg: (token, text) => `\x1b[38;5;${TOKEN_CODES[token]}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  style: (text) => text,
  colors: {},
};
const plain = (line) => stripTerminalSequences(line);

let stops = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

/**
 * A busy session with the queue installed. `pending` is Pi's queue: Pi adds
 * to it what `sendUserMessage` sends, its dequeue action puts it all back
 * into the prompt, and the watch moves the next follow-up to steering.
 * `pending.blocked` plays a Pi session that cannot move it. `watch: false`
 * plays a Pi whose queue ampi cannot read.
 */
function setup({ idle = false, text = "", watch = true } = {}) {
  const pending = { steering: [], followUp: [], blocked: undefined };
  let report = () => {};
  const reportQueue = () => report();
  const mock = createMockPi({
    onSendUserMessage: (content, options) => {
      pending[options?.deliverAs === "steer" ? "steering" : "followUp"].push(content);
      reportQueue();
    },
  });
  const context = createMockExtensionContext({ idle, editorText: text });
  const feed = createMmrStatusFeed(mock.pi);
  feed.reset(context.ctx);
  const piWatch = {
    stopped: 0,
    steerBlocked: () => pending.blocked,
    steerNext() {
      if (pending.blocked !== undefined || pending.followUp.length === 0) return false;
      pending.steering.push(pending.followUp.shift());
      reportQueue();
      return true;
    },
    remove(kind, index, text) {
      const list = pending[kind];
      if (list[index] !== text) return false;
      list.splice(index, 1);
      reportQueue();
      return true;
    },
    stop() {
      piWatch.stopped += 1;
    },
  };
  // Pi's focused prompt editor with its dequeue action.
  const actions = new Map([
    [
      "app.message.dequeue",
      () => {
        context.state.editorText = [...pending.steering, ...pending.followUp].join("\n\n");
        pending.steering = [];
        pending.followUp = [];
        reportQueue();
      },
    ],
  ]);
  const history = [];
  const tui = { getFocusedComponent: () => ({ actionHandlers: actions, addToHistory: (text) => history.push(text) }), requestRender() {} };
  const queue = createMmrPromptQueue(mock.pi, {
    feed,
    getTui: () => tui,
    watch: (listener) => {
      if (!watch) return undefined;
      report = () => listener({ steering: [...pending.steering], followUp: [...pending.followUp] });
      return piWatch;
    },
  });
  queue.start(context.ctx);
  stops.push(() => queue.stop());
  const emit = (type, event = {}) => mock.handlers.get(type)({ type, ...event }, context.ctx);
  if (!idle) emit("turn_start");
  const command = (id) => getMmrCommand(id);
  const availability = (id) => command(id).availability(context.ctx);
  const box = (width = 80) => {
    const widget = context.widgets.get(MMR_QUEUE_WIDGET_ID);
    if (!widget?.content) return [];
    return widget.content(undefined, theme).render(width).map(plain);
  };
  return { mock, context, feed, queue, pending, actions, history, piWatch, emit, command, availability, box };
}

function fixtureText(name, renders) {
  const parts = [`# ${name}`];
  for (const { width, lines } of renders) {
    parts.push("", `## ${width} columns`, ...lines.map(plain), "", ...lines.map((line) => JSON.stringify(line)));
  }
  return `${parts.join("\n")}\n`;
}

function assertFixture(name, renders) {
  const file = path.join(FIXTURE_DIR, `${name}.txt`);
  const actual = fixtureText(name, renders);
  if (UPDATE_FIXTURES) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.ok(existsSync(file), `missing fixture ${file}; run with PI_MMR_UPDATE_FIXTURES=1`);
  assert.equal(actual, readFileSync(file, "utf8"), `fixture drift in ${file}; rerun with PI_MMR_UPDATE_FIXTURES=1 and review`);
}

const CASES = {
  "queued-one": { steering: [], followUp: ["Run the whole test suite once this is done"] },
  "queued-several": {
    steering: [],
    followUp: [
      "Then update the changelog",
      "Check the README too,\n  and the quick reference",
      `Finally ${"rename every helper that still uses the old prefix ".repeat(4).trim()}.`,
    ],
  },
  steering: {
    steering: ["Also cover the error path"],
    followUp: ["Then update the changelog", "And run the linter"],
  },
  "steering-only": { steering: ["Stop after the parser"], followUp: [] },
};

describe("ampi-tui queue box: render fixtures", () => {
  for (const [name, queue] of Object.entries(CASES)) {
    it(name, () => {
      const renders = WIDTHS.map((width) => ({ width, lines: renderMmrQueueBox(queue, width, theme) }));
      for (const { width, lines } of renders) {
        assert.equal(lines.length, queue.steering.length + queue.followUp.length + 2, "one row per message inside the frame");
        for (const line of lines) assert.equal(visibleWidth(line), width, `every row fills ${width} columns: ${plain(line)}`);
      }
      assertFixture(name, renders);
    });
  }

  it("labels steering messages, then the first follow-up, with the text aligned after the labels", () => {
    const lines = renderMmrQueueBox(CASES.steering, 80, theme).map(plain);
    assert.match(lines[0], /^ ╭─+╮ $/);
    assert.match(lines[1], /^ │ steering: Also cover the error path +│ $/);
    assert.match(lines[2], /^ │ queued: {3}Then update the changelog +│ $/);
    assert.match(lines[3], /^ │ {11}And run the linter +│ $/);
    assert.match(lines[4], /^ ╰─+╯ $/);
    const queuedOnly = renderMmrQueueBox(CASES["queued-several"], 80, theme).map(plain);
    assert.match(queuedOnly[1], /^ │ queued: Then update the changelog +│ $/, "no steering row: the label column narrows");
    assert.match(queuedOnly[2], /^ │ {9}Check the README too, and the quick reference +│ $/, "line breaks become one space");
    assert.match(queuedOnly[3], /… │ $/, "a long message is cut");
  });

  it("styles the steering label in the accent colour and queued text muted", () => {
    const [, steering, queued] = renderMmrQueueBox(CASES.steering, 80, theme);
    assert.ok(steering.includes(theme.fg("accent", "steering:")));
    assert.ok(queued.includes(theme.fg("dim", "queued:")));
    assert.ok(queued.includes(theme.fg("muted", "Then update the changelog")));
  });

  it("draws nothing with an empty queue or too little width", () => {
    assert.deepEqual(renderMmrQueueBox({ steering: [], followUp: [] }, 80, theme), []);
    assert.deepEqual(renderMmrQueueBox(CASES["queued-one"], 9, theme), []);
    assert.equal(renderMmrQueueBox(CASES["queued-one"], 10, theme)[0].length, 10);
  });
});

describe("ampi-tui queue commands: availability", () => {
  it("queue needs a running turn and text in the prompt", () => {
    assert.deepEqual(setup({ idle: true, text: "later" }).availability("prompt.queue"), {
      state: "unavailable",
      reason: "nothing is running",
    });
    assert.deepEqual(setup({ text: "  \n " }).availability("prompt.queue"), {
      state: "unavailable",
      reason: "type a prompt to queue it",
    });
    const t = setup({ text: "later" });
    assert.equal(t.availability("prompt.queue").state, "available");
    t.emit("session_before_compact", { reason: "threshold" });
    assert.deepEqual(t.availability("prompt.queue"), { state: "unavailable", reason: "Pi is compacting the conversation" });
  });

  it("dequeue needs a queued message and Pi's dequeue action", () => {
    const t = setup({ text: "later" });
    assert.deepEqual(t.availability("prompt.dequeue"), { state: "unavailable", reason: "no message is queued" });
    t.command("prompt.queue").run(t.context.ctx);
    assert.equal(t.availability("prompt.dequeue").state, "available");
    t.actions.clear();
    assert.deepEqual(t.availability("prompt.dequeue"), { state: "unavailable", reason: "the prompt is not focused" });
  });

  it("steer needs a queued follow-up, not just a steering message", () => {
    const t = setup({ text: "now" });
    assert.deepEqual(t.availability("prompt.steerQueuedMessage"), { state: "unavailable", reason: "no message is queued" });
    t.mock.pi.sendUserMessage("now", { deliverAs: "steer" });
    assert.equal(t.feed.status.queued, 1);
    assert.deepEqual(t.availability("prompt.steerQueuedMessage"), { state: "unavailable", reason: "no message is queued" });
    t.command("prompt.queue").run(t.context.ctx);
    assert.equal(t.availability("prompt.steerQueuedMessage").state, "available");
  });

  it("steer is unavailable where ampi cannot read Pi's queue", () => {
    const t = setup({ text: "later", watch: false });
    t.command("prompt.queue").run(t.context.ctx);
    assert.deepEqual(t.availability("prompt.steerQueuedMessage"), {
      state: "unavailable",
      reason: "this Pi version does not show ampi its queue",
    });
    assert.equal(t.queue.steerNext(), false);
  });

  it("steer gives Pi's reason when Pi cannot move the queued message", () => {
    const t = setup({ text: "later" });
    t.command("prompt.queue").run(t.context.ctx);
    t.pending.blocked = "this Pi version does not let ampi move a queued message";
    assert.deepEqual(t.availability("prompt.steerQueuedMessage"), {
      state: "unavailable",
      reason: "this Pi version does not let ampi move a queued message",
    });
    assert.equal(t.queue.steerNext(), false);
    assert.deepEqual(t.pending.followUp, ["later"], "the message stays queued");
  });
});

describe("ampi-tui queue commands: queue, dequeue, steer", () => {
  it("queues the prompt as a follow-up, lists it above the prompt, and dequeue puts it back", () => {
    const t = setup({ text: "  update the docs next  " });
    t.command("prompt.queue").run(t.context.ctx);
    assert.deepEqual(t.mock.calls.sendUserMessage, [
      { content: "update the docs next", options: { deliverAs: "followUp", expandPromptTemplates: true } },
    ]);
    assert.equal(t.context.state.editorText, "", "the prompt is cleared");
    assert.deepEqual(t.history, ["update the docs next"], "Up recalls it");
    assert.equal(t.context.widgets.get(MMR_QUEUE_WIDGET_ID).options.placement, "aboveEditor");
    assert.match(t.box()[1], /│ queued: update the docs next +│/);
    assert.equal(t.feed.status.hint, "Enter to steer, Backspace to dequeue");

    t.context.state.editorText = "and the tests";
    t.command("prompt.queue").run(t.context.ctx);
    assert.equal(t.box().length, 4, "two rows in the frame");

    t.context.state.editorText = "";
    t.command("prompt.dequeue").run(t.context.ctx);
    assert.equal(t.context.state.editorText, "update the docs next\n\nand the tests");
    assert.equal(t.context.widgets.get(MMR_QUEUE_WIDGET_ID).content, undefined, "the box goes");
    assert.equal(t.feed.status.queued, 0);
    assert.equal(t.feed.status.hint, "Enter to steer");
  });

  it("steers with the next queued message and keeps the rest queued in order", () => {
    const t = setup();
    t.mock.pi.sendUserMessage("already steering", { deliverAs: "steer" });
    for (const text of ["first later", "second later", "third later"]) {
      t.context.state.editorText = text;
      t.command("prompt.queue").run(t.context.ctx);
    }
    t.mock.calls.sendUserMessage.length = 0;
    t.command("prompt.steerQueuedMessage").run(t.context.ctx);
    assert.deepEqual(t.mock.calls.sendUserMessage, [], "Pi moves the message; nothing is sent again");
    assert.deepEqual(t.pending.steering, ["already steering", "first later"]);
    const rows = t.box(80);
    assert.match(rows[1], /│ steering: already steering +│/);
    assert.match(rows[2], /│ steering: first later +│/);
    assert.match(rows[3], /│ queued: {3}second later +│/);
    assert.match(rows[4], /│ {11}third later +│/);
    assert.equal(t.feed.status.queued, 4);
  });

  it("publishes the queue through ampi-core's seam, takes one message back through the watch, and releases the seam on stop", () => {
    const t = setup();
    assert.deepEqual(getMmrPromptQueue(), { steering: [], followUp: [] });
    t.mock.pi.sendUserMessage("steer now", { deliverAs: "steer" });
    t.mock.pi.sendUserMessage("same", { deliverAs: "followUp" });
    t.mock.pi.sendUserMessage("other", { deliverAs: "followUp" });
    assert.deepEqual(getMmrPromptQueue(), { steering: ["steer now"], followUp: ["same", "other"] });
    assert.equal(removeMmrQueuedPrompt("followUp", 0, "other"), false, "a stale index changes nothing");
    assert.equal(removeMmrQueuedPrompt("followUp", 1, "other"), true);
    assert.deepEqual(getMmrPromptQueue(), { steering: ["steer now"], followUp: ["same"] });
    assert.equal(t.feed.status.queued, 2);
    t.queue.stop();
    assert.equal(getMmrPromptQueue(), undefined);
    assert.equal(removeMmrQueuedPrompt("followUp", 0, "same"), false);
  });

  it("does not own the seam where ampi cannot read Pi's queue", () => {
    setup({ watch: false });
    assert.equal(getMmrPromptQueue(), undefined);
  });

  it("steers on Enter only while a follow-up waits and the turn can take it", () => {
    const t = setup({ text: "later" });
    assert.equal(t.queue.steerNext(), false, "nothing queued");
    t.command("prompt.queue").run(t.context.ctx);
    t.emit("session_before_compact", { reason: "threshold" });
    assert.equal(t.queue.steerNext(), false, "not while Pi compacts");
    t.emit("session_compact", { reason: "threshold" });
    assert.equal(t.queue.steerNext(), true);
    assert.deepEqual(t.pending.steering, ["later"]);
    assert.equal(t.queue.steerNext(), false, "the message already steers");
  });

  it("ranks each command first in the palette for its own name", () => {
    const t = setup({ text: "later" });
    t.command("prompt.queue").run(t.context.ctx);
    const commands = ["prompt.queue", "prompt.dequeue", "prompt.steerQueuedMessage"].map(t.command);
    const first = (query) => rankMmrCommands(commands, query)[0]?.command.id;
    assert.equal(first("queue message"), "prompt.queue");
    assert.equal(first("dequeue"), "prompt.dequeue");
    assert.equal(first("steer queued"), "prompt.steerQueuedMessage");
  });

  it("registers the commands for the session and gives Pi its list back at shutdown", () => {
    const t = setup();
    assert.ok(t.command("prompt.queue"));
    t.queue.stop();
    assert.equal(t.piWatch.stopped, 1);
    for (const id of ["prompt.queue", "prompt.dequeue", "prompt.steerQueuedMessage"]) assert.equal(getMmrCommand(id), undefined);
  });
});
