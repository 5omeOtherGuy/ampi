// ampi-gui composer helpers: which key does what, the Esc Esc chord, the
// send request, the queued-message bubbles and the send/stop button. Pure
// functions from the client module; the page wiring is checked in a browser.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const load = () => importSource("extensions/ampi-gui/client/composer.js");
const key = (key, mods = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...mods });

describe("ampi-gui composer keys", () => {
  it("sends on Enter, queues on Ctrl+Enter or ⌘+Enter, and leaves line breaks and input methods alone", async () => {
    const { composerKeyAction } = await load();
    assert.equal(composerKeyAction(key("Enter")), "send");
    assert.equal(composerKeyAction(key("Enter", { ctrlKey: true })), "queue");
    assert.equal(composerKeyAction(key("Enter", { metaKey: true })), "queue");
    assert.equal(composerKeyAction(key("Enter", { shiftKey: true })), null, "Shift+Enter is a line break");
    assert.equal(composerKeyAction(key("Enter", { altKey: true })), null);
    assert.equal(composerKeyAction(key("Enter", { isComposing: true })), null, "Enter confirms the input method's text");
    assert.equal(composerKeyAction(key("Escape")), "escape");
    assert.equal(composerKeyAction(key("a")), null);
  });

  it("counts a second Escape within the chord window as Esc Esc, and only once", async () => {
    const { createEscapeChord, ESCAPE_CHORD_MS } = await load();
    let now = 10_000;
    const chord = createEscapeChord(() => now);
    assert.equal(chord.press(), false);
    now += ESCAPE_CHORD_MS;
    assert.equal(chord.press(), true, "the window's last millisecond still counts");
    assert.equal(chord.press(), false, "a third press starts a new chord");
    now += ESCAPE_CHORD_MS + 1;
    assert.equal(chord.press(), false, "too late: this press starts over");
    now += 10;
    assert.equal(chord.press(), true);
    chord.press();
    chord.reset();
    assert.equal(chord.press(), false, "reset forgets the first press");
  });

  it("counts Escape toward Esc Esc only while the live composer is usable", async () => {
    const { escapeCounts } = await load();
    const inside = (selector) => ({ closest: (query) => (query === selector ? {} : null) });
    const live = { busy: true, usable: true };
    assert.equal(escapeCounts(key("Escape", { target: inside("") }), live), true);
    assert.equal(escapeCounts(key("Escape"), { busy: true, usable: false }), false, "another session is shown, or the sidebar sheet covers the page");
    assert.equal(escapeCounts(key("Escape"), { busy: false, usable: true }), false, "no turn to interrupt");
    assert.equal(escapeCounts(key("Escape", { target: inside("dialog[open]") }), live), false, "this Escape closes a dialog");
    assert.equal(escapeCounts(key("Escape", { defaultPrevented: true }), live), false, "a field or menu took it");
    assert.equal(escapeCounts(key("Enter"), live), false);
  });
});

describe("ampi-gui composer requests and view", () => {
  it("steers by default and queues on request, keeping the text as typed", async () => {
    const { sendBody } = await load();
    assert.deepEqual(sendBody("fix it\n", false), { text: "fix it\n", deliverAs: "steer" });
    assert.deepEqual(sendBody("later", true), { text: "later", deliverAs: "followUp" });
    assert.equal(sendBody(" \n ", false), null);
  });

  it("lists steering messages first and lets only the next follow-up steer", async () => {
    const { queueEntries } = await load();
    assert.deepEqual(queueEntries(null), []);
    const entries = queueEntries({ steering: ["now"], followUp: ["next", "after"] });
    assert.deepEqual(
      entries.map(({ kind, index, label, canSteer }) => [kind, index, label, canSteer]),
      [
        ["steering", 0, "Steering", false],
        ["followUp", 0, "Queued", true],
        ["followUp", 1, "Queued", false],
      ],
    );
  });

  it("shows stop while a turn runs and nothing is typed, and send otherwise", async () => {
    const { submitState } = await load();
    assert.deepEqual(submitState({ busy: true, text: "", connected: true }), { mode: "stop", label: "Interrupt (Esc Esc)", disabled: false });
    assert.equal(submitState({ busy: true, text: "more", connected: true }).mode, "send", "typed text steers");
    assert.equal(submitState({ busy: true, text: "more", connected: true }).label, "Send to steer (Enter)");
    assert.equal(submitState({ busy: false, text: "", connected: true }).disabled, true, "nothing to send");
    assert.equal(submitState({ busy: false, text: "hi", connected: true }).disabled, false);
    assert.equal(submitState({ busy: false, text: "hi", connected: false }).disabled, true, "not while disconnected");
  });

  it("names the keys in the placeholder while a turn runs", async () => {
    const { placeholderFor } = await load();
    assert.equal(placeholderFor(false, false), "Write a message");
    assert.equal(placeholderFor(true, false), "Enter steers, Ctrl+Enter queues, Esc Esc interrupts");
    assert.match(placeholderFor(true, true), /⌘\+Enter queues/);
  });
});
