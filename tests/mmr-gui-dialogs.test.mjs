// ampi-gui dialogs: the questions extensions ask through `ctx.ui` in a
// session `ampi app` hosts. The bridge queues them and sends `dialog` and
// `dialog_closed` events, the snapshot lists the open ones, `POST
// /api/dialog` answers them (the first answer wins), Pi's timeout and abort
// signal and an interrupt cancel them, and so does a stretch of 15 minutes
// without a page on the event stream. Timers and the clock are fakes; the
// server runs on 127.0.0.1 with a random port. The page's modal escapes
// every string it draws.

import assert from "node:assert/strict";
import { request } from "node:http";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const MINUTE = 60_000;
const TOKEN = ["dialog", "test", "token"].join("-");

/** A clock and timers that move only when `advance` says so. */
function fakeTime() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (callback, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimer: (handle) => timers.delete(handle),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

async function setup({ dialogs = true, idle = true } = {}) {
  const { createMmrGuiBridge } = await importSource("extensions/ampi-gui/bridge.ts");
  const { createMmrGuiCommands } = await importSource("extensions/ampi-gui/commands.ts");
  const { pi } = createMockPi();
  const context = createMockExtensionContext({ cwd: "/work/app", sessionId: "s-1", idle });
  const time = fakeTime();
  const bridge = createMmrGuiBridge(pi, { now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, home: "/home/u" });
  bridge.start(context.ctx, { dialogs });
  const events = [];
  bridge.subscribe((event) => events.push(event));
  const commands = createMmrGuiCommands(pi, bridge, { find: async () => undefined });
  /** Ask, and record how the promise settled. */
  const ask = (request, options) => {
    const result = { settled: false, answer: undefined };
    result.done = bridge.ask(request, options).then((answer) => {
      result.settled = true;
      result.answer = answer;
      return answer;
    });
    return result;
  };
  return { bridge, commands, context, time, events, ask };
}

const confirm = { kind: "confirm", title: "Delete the branch?", message: "It has unpushed commits." };
const select = { kind: "select", title: "Approval Required", options: ["Allow Once", "Reject"] };
const closedEvents = (events) => events.filter((event) => event.event === "dialog_closed").map((event) => event.data);

describe("ampi-gui dialogs: the bridge's queue", () => {
  it("queues questions in order, sends each as an event and lists the open ones in the snapshot", async () => {
    const { bridge, events, ask } = await setup();
    ask(confirm);
    ask(select);
    ask({ kind: "input", title: "Branch name", placeholder: "feature/…" });
    ask({ kind: "editor", title: "Commit message", initial: "fix: …" });

    const asked = events.filter((event) => event.event === "dialog").map((event) => event.data);
    assert.deepEqual(asked, [
      { id: "dialog-1", kind: "confirm", title: "Delete the branch?", message: "It has unpushed commits.", options: [], placeholder: null, initial: null },
      { id: "dialog-2", kind: "select", title: "Approval Required", message: null, options: ["Allow Once", "Reject"], placeholder: null, initial: null },
      { id: "dialog-3", kind: "input", title: "Branch name", message: null, options: [], placeholder: "feature/…", initial: null },
      { id: "dialog-4", kind: "editor", title: "Commit message", message: null, options: [], placeholder: null, initial: "fix: …" },
    ]);
    assert.deepEqual(bridge.snapshot().dialogs, asked, "oldest first");
  });

  it("answers cancelled at once, with no event, in a session whose extensions ask in the terminal", async () => {
    const { bridge, events } = await setup({ dialogs: false });
    assert.deepEqual(await bridge.ask(confirm), { cancelled: true });
    assert.equal(bridge.snapshot().dialogs, null, "the page keeps its terminal note");
    assert.deepEqual(events, []);
  });

  it("replays open questions to a page that reconnects: in the snapshot, and as buffered events", async () => {
    const { bridge, commands, ask } = await setup();
    const before = bridge.lastEventId;
    ask(confirm);
    ask(select);
    // A page that saw the first question only.
    const missed = bridge.eventsAfter(before + 1);
    assert.deepEqual(
      missed.map((event) => [event.event, event.data.id]),
      [["dialog", "dialog-2"]],
    );
    assert.equal((await commands.dialog({ id: "dialog-1", value: true })).status, 200);
    // A page that loads now gets the one still open, and nothing it would have to undo.
    const snapshot = bridge.snapshot();
    assert.deepEqual(
      snapshot.dialogs.map((dialog) => dialog.id),
      ["dialog-2"],
    );
    assert.deepEqual(bridge.eventsAfter(snapshot.lastEventId), []);
  });

  it("shows an extension's notification as a notice event", async () => {
    const { bridge, events } = await setup();
    bridge.notice("Command blocked by the user", "warning");
    assert.deepEqual(events.at(-1), { id: events.at(-1).id, event: "notice", data: { message: "Command blocked by the user", level: "warning" } });
  });
});

describe("ampi-gui dialogs: answers", () => {
  it("takes the first answer and refuses every later one with 409", async () => {
    const { commands, events, ask } = await setup();
    const asked = ask(select);
    const first = await commands.dialog({ id: "dialog-1", value: "Reject" });
    assert.deepEqual(first, { status: 200, body: { ok: true } });
    assert.deepEqual(await asked.done, { value: "Reject" });
    const second = await commands.dialog({ id: "dialog-1", value: "Allow Once" });
    assert.equal(second.status, 409);
    assert.equal((await commands.dialog({ id: "dialog-1", cancelled: true })).status, 409, "a cancel comes too late as well");
    assert.deepEqual(closedEvents(events), [{ id: "dialog-1", answeredBy: "page" }]);
  });

  it("answers 409 for an id it never issued", async () => {
    const { commands, ask } = await setup();
    const asked = ask(confirm);
    for (const id of ["dialog-9", "dialog-0", "../dialog-1", "__proto__"]) {
      assert.equal((await commands.dialog({ id, value: true })).status, 409, id);
    }
    assert.equal(asked.settled, false);
  });

  it("refuses with 400 an answer that does not fit, and keeps the question open", async () => {
    const { commands, ask } = await setup();
    const yesNo = ask(confirm);
    const choice = ask(select);
    const text = ask({ kind: "input", title: "Name" });
    const bad = [
      { id: "dialog-1", value: "yes" },
      { id: "dialog-2", value: "Allow All" },
      { id: "dialog-2", value: 0 },
      { id: "dialog-3", value: false },
      { id: "dialog-3", value: "x".repeat(100_001) },
      { id: "dialog-1" },
      { value: true },
      { id: "", cancelled: true },
    ];
    for (const body of bad) assert.equal((await commands.dialog(body)).status, 400, JSON.stringify(body).slice(0, 60));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([yesNo.settled, choice.settled, text.settled], [false, false, false]);

    assert.equal((await commands.dialog({ id: "dialog-1", value: false })).status, 200);
    assert.deepEqual(await yesNo.done, { value: false }, "No is an answer, not a cancel");
    assert.equal((await commands.dialog({ id: "dialog-2", cancelled: true })).status, 200);
    assert.deepEqual(await choice.done, { cancelled: true });
    assert.equal((await commands.dialog({ id: "dialog-3", value: "" })).status, 200);
    assert.deepEqual(await text.done, { value: "" });
  });
});

describe("ampi-gui dialogs: cancels", () => {
  it("cancels when Pi's timeout passes, and not before", async () => {
    const { time, events, ask } = await setup();
    const asked = ask(confirm, { timeout: 5_000 });
    time.advance(4_999);
    await Promise.resolve();
    assert.equal(asked.settled, false);
    time.advance(1);
    assert.deepEqual(await asked.done, { cancelled: true });
    assert.deepEqual(closedEvents(events), [{ id: "dialog-1", answeredBy: "timeout" }]);
  });

  it("drops the timeout of a question answered in time", async () => {
    const { commands, time, ask } = await setup();
    // Nobody watches, so the unattended timer runs beside the timeout.
    ask(confirm, { timeout: 5_000 });
    const before = time.pending();
    await commands.dialog({ id: "dialog-1", value: true });
    assert.equal(time.pending(), before - 2, "the timeout and the unattended timer are gone");
  });

  it("cancels when the extension's signal aborts, and at once when it already has", async () => {
    const { events, ask } = await setup();
    const controller = new AbortController();
    const asked = ask(select, { signal: controller.signal });
    controller.abort();
    assert.deepEqual(await asked.done, { cancelled: true });
    assert.deepEqual(closedEvents(events), [{ id: "dialog-1", answeredBy: "abort" }]);

    const aborted = AbortSignal.abort();
    const late = ask(confirm, { signal: aborted });
    assert.deepEqual(await late.done, { cancelled: true });
    assert.equal(events.filter((event) => event.event === "dialog").length, 1, "an aborted question is never shown");
  });

  it("cancels every open question on an interrupt, and the interrupt succeeds while idle when it did", async () => {
    const { commands, context, events, ask } = await setup({ idle: true });
    const one = ask(confirm);
    const two = ask(select);
    assert.deepEqual(await commands.interrupt({}), { status: 200, body: { ok: true } });
    assert.deepEqual([await one.done, await two.done], [{ cancelled: true }, { cancelled: true }]);
    assert.deepEqual(closedEvents(events), [
      { id: "dialog-1", answeredBy: "interrupt" },
      { id: "dialog-2", answeredBy: "interrupt" },
    ]);
    assert.equal(context.lifecycle.abort, 0, "nothing ran, so nothing was aborted");
    assert.equal((await commands.interrupt({})).status, 409, "with nothing open and nothing running there is nothing to interrupt");
  });

  it("cancels every open question when the session stops", async () => {
    const { bridge, ask } = await setup();
    const asked = ask(confirm);
    bridge.stop();
    assert.deepEqual(await asked.done, { cancelled: true });
    assert.deepEqual(await bridge.ask(confirm), { cancelled: true }, "and answers later ones itself");
  });

  it("cancels when no page has followed the session for exactly 15 minutes, not a moment before", async () => {
    const { bridge, time, events, ask } = await setup();
    const page = bridge.watch();
    const asked = ask(select);
    // While a page follows the session, the question waits however long it takes.
    time.advance(60 * MINUTE);
    await Promise.resolve();
    assert.equal(asked.settled, false);

    page();
    time.advance(15 * MINUTE - 1);
    await Promise.resolve();
    assert.equal(asked.settled, false, "14:59.999 after the page left");
    time.advance(1);
    assert.deepEqual(await asked.done, { cancelled: true });
    assert.deepEqual(closedEvents(events), [{ id: "dialog-1", answeredBy: "unattended" }]);
  });

  it("starts the 15 minutes again when a page comes back, and counts them from when nobody watched", async () => {
    const { bridge, time, ask } = await setup();
    // Nobody has watched since the session started: a question asked 10 minutes in has 5 left.
    time.advance(10 * MINUTE);
    const late = ask(confirm);
    time.advance(5 * MINUTE - 1);
    await Promise.resolve();
    assert.equal(late.settled, false);
    time.advance(1);
    assert.deepEqual(await late.done, { cancelled: true });

    // A question asked with nobody watching for longer than the window is cancelled at once.
    time.advance(MINUTE);
    assert.deepEqual(await ask(confirm).done, { cancelled: true });

    // A page that comes and goes restarts the window.
    const first = bridge.watch();
    const asked = ask(select);
    first();
    time.advance(14 * MINUTE);
    const second = bridge.watch();
    time.advance(MINUTE);
    second();
    time.advance(15 * MINUTE - 1);
    await Promise.resolve();
    assert.equal(asked.settled, false);
    time.advance(1);
    assert.deepEqual(await asked.done, { cancelled: true });
  });
});

describe("ampi-gui dialogs: the page's modal", () => {
  const loadDialogs = () => importSource("extensions/ampi-gui/client/dialogs.js");
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>"\'&';

  it("escapes every string it draws: title, message, options, placeholder and prefilled text", async () => {
    const { dialogHtml } = await loadDialogs();
    const html = [
      dialogHtml({ id: "d", kind: "confirm", title: hostile, message: hostile, options: [], placeholder: null, initial: null }),
      dialogHtml({ id: "d", kind: "select", title: hostile, message: null, options: [hostile, `x" onclick="y`], placeholder: null, initial: null }),
      dialogHtml({ id: "d", kind: "input", title: "t", message: null, options: [], placeholder: `"><script>alert(3)</script>`, initial: null }),
      dialogHtml({ id: "d", kind: "editor", title: "t", message: null, options: [], placeholder: null, initial: `</textarea><script>alert(4)</script>` }),
    ].join("\n");
    assert.doesNotMatch(html, /<img|<script|onerror="|onclick="/);
    assert.match(html, /&#60;img src=x onerror=&#34;alert\(1\)&#34;&#62;/);
    assert.match(html, /placeholder="&#34;&#62;&#60;script&#62;/);
    assert.equal((html.match(/<\/textarea>/g) ?? []).length, 1, "the prefilled text cannot end the field");
  });

  it("draws each kind's controls: two buttons, a listbox, a field or a text area", async () => {
    const { dialogHtml } = await loadDialogs();
    const base = { id: "d", title: "T", message: null, options: [], placeholder: null, initial: null };
    const confirmHtml = dialogHtml({ ...base, kind: "confirm", message: "M" });
    assert.match(confirmHtml, />No<\/button>.*>Yes<\/button>/);
    assert.doesNotMatch(confirmHtml, /id="ask-field"/);
    const selectHtml = dialogHtml({ ...base, kind: "select", options: ["A", "B"] });
    assert.match(selectHtml, /role="listbox"[^>]*aria-activedescendant="ask-option-0"/);
    assert.match(selectHtml, /id="ask-option-0"[^>]*aria-selected="true">A</);
    assert.match(selectHtml, /id="ask-option-1"[^>]*aria-selected="false">B</);
    assert.match(dialogHtml({ ...base, kind: "input" }), /<input id="ask-field" type="text"/);
    assert.match(dialogHtml({ ...base, kind: "editor", initial: "a\nb" }), /<textarea id="ask-field"[^>]*>a\nb<\/textarea>/);
  });

  it("moves through a listbox with the arrow keys, Home and End, stopping at the ends", async () => {
    const { moveActive } = await loadDialogs();
    assert.equal(moveActive("ArrowDown", 0, 3), 1);
    assert.equal(moveActive("ArrowDown", 2, 3), 2);
    assert.equal(moveActive("ArrowUp", 0, 3), 0);
    assert.equal(moveActive("ArrowUp", 2, 3), 1);
    assert.equal(moveActive("Home", 2, 3), 0);
    assert.equal(moveActive("End", 0, 3), 2);
    assert.equal(moveActive("a", 1, 3), 1);
    assert.equal(moveActive("ArrowDown", 0, 0), 0);
  });
});

describe("ampi-gui dialogs over HTTP", () => {
  it("streams the question, takes the answer with the token and the server's Origin, and refuses a second one", async () => {
    const { startMmrGuiServer } = await importSource("extensions/ampi-gui/server.ts");
    const { bridge, commands, ask } = await setup();
    const sessions = { list: async () => ({ currentId: null, groups: [], actions: {} }), view: async () => undefined };
    const clientDir = new URL("../src/extensions/ampi-gui/client", import.meta.url).pathname;
    const server = await startMmrGuiServer({ bridge, commands, sessions, token: TOKEN, clientDir });
    const { port } = server;
    const host = `127.0.0.1:${port}`;
    const auth = { Host: host, Cookie: `ampi_gui_${port}=${TOKEN}` };
    const send = ({ method = "GET", target, headers, body }) =>
      new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method, path: target, headers, setHost: false, agent: false }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    const answer = (payload, extra = {}) =>
      send({
        method: "POST",
        target: "/api/dialog",
        headers: { ...auth, "Content-Type": "application/json", Origin: `http://${host}`, ...extra },
        body: JSON.stringify(payload),
      });

    try {
      // A page on the event stream sees the question as it is asked.
      const seen = await new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: auth, setHost: false, agent: false }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
            if (text.includes("event: dialog\n")) {
              req.destroy();
              resolve({ type: res.headers["content-type"], text });
            }
          });
          ask(confirm);
        });
        req.on("error", (error) => (error.code === "ECONNRESET" ? undefined : reject(error)));
        req.end();
      });
      assert.match(seen.type, /^text\/event-stream/);
      assert.match(seen.text, /event: dialog\ndata: \{"id":"dialog-1","kind":"confirm","title":"Delete the branch\?"/);

      const transcript = JSON.parse((await send({ target: "/api/transcript", headers: auth })).body);
      assert.deepEqual(
        transcript.dialogs.map((dialog) => dialog.id),
        ["dialog-1"],
      );

      assert.equal((await answer({ id: "dialog-1", value: true }, { Origin: "http://evil.example" })).status, 403, "foreign Origin");
      assert.equal((await answer({ id: "dialog-1", value: true }, { Cookie: "" })).status, 403, "no token");
      assert.equal((await answer({ id: "dialog-1", value: true }, { Host: "evil.example" })).status, 403, "foreign Host");
      const first = await answer({ id: "dialog-1", value: true });
      assert.equal(first.status, 200);
      assert.equal(first.headers["access-control-allow-origin"], undefined, "no CORS");
      const second = await answer({ id: "dialog-1", value: false });
      assert.equal(second.status, 409);
      assert.match(JSON.parse(second.body).error, /no longer open/);

      const script = await send({ target: "/client/dialogs.js", headers: auth });
      assert.equal(script.status, 200);
      assert.match(script.headers["content-type"], /^text\/javascript/);
    } finally {
      await server.close();
    }
  });
});
