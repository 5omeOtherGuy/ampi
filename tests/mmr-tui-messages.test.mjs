// User message styling: the renderer and the pi-compat patch on Pi's real
// UserMessageComponent. The probe against the installed Pi lives in
// tests/mmr-tui-pi-compat.test.mjs.

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const taggedTheme = { fg: (token, text) => `<${token}>${text}</${token}>`, italic: (text) => `<i>${text}</i>` };
const plainTheme = { fg: (_token, text) => text, italic: (text) => text };

// Pi's own render() wraps the block in OSC 133 prompt marks; they are not part of the drawing.
const stripOsc133 = (line) => line.replace(/\x1b\]133;[ABC]\x07/g, "");

const originalRebuild = UserMessageComponent.prototype.rebuild;

describe("ampi-tui user message renderer", () => {
  it("puts the bar on every physical line, wrapped ones included, in front of raw italic text", async () => {
    const { renderMmrUserMessage } = await importSource("extensions/ampi-tui/transcript/messages.ts");
    const text = "**not bold** and a line long enough to wrap\n\n- not a list";
    const lines = renderMmrUserMessage(text, 24, 1, plainTheme);
    assert.deepEqual(lines, [
      "",
      " ┃ **not bold** and a",
      " ┃ line long enough to",
      " ┃ wrap",
      " ┃ ",
      " ┃ - not a list",
    ]);
    for (const line of lines) assert.ok(visibleWidth(line) <= 24);

    const [, first] = renderMmrUserMessage("hi", 24, 1, taggedTheme);
    assert.equal(first, " <userMessageText>┃ </userMessageText><i><userMessageText>hi</userMessageText></i>");
  });

  it("honours Pi's margin setting and never runs out of room", async () => {
    const { renderMmrUserMessage } = await importSource("extensions/ampi-tui/transcript/messages.ts");
    assert.deepEqual(renderMmrUserMessage("abc", 20, 0, plainTheme), ["", "┃ abc"]);
    assert.deepEqual(renderMmrUserMessage("abcdef", 4, 1, plainTheme), ["", "┃ ab", "┃ cd", "┃ ef"], "the margin gives way first");
    for (const line of renderMmrUserMessage("x".repeat(30), 12, 1, plainTheme)) {
      assert.ok(visibleWidth(line) <= 11, "the last column stays free for the scrollbar, as with Pi's margin");
    }
  });
});

describe("ampi-tui pi-compat user message patch", () => {
  afterEach(() => {
    assert.equal(UserMessageComponent.prototype.rebuild, originalRebuild, "each case must restore Pi's rebuild");
  });

  it("draws Pi's own user message components, wrapped lines included, until restored", async () => {
    const { installMmrUserMessageDraw } = await importSource("extensions/ampi-tui/pi-compat/messages.ts");
    const { renderMmrUserMessage } = await importSource("extensions/ampi-tui/transcript/messages.ts");
    const restore = installMmrUserMessageDraw((text, width, pad) => renderMmrUserMessage(text, width, pad, plainTheme));
    try {
      const message = new UserMessageComponent("a user message long enough to wrap twice at this width");
      const lines = message.render(24).map(stripOsc133);
      assert.deepEqual(lines, ["", " ┃ a user message long", " ┃ enough to wrap twice", " ┃ at this width"]);

      message.setOutputPad(0);
      assert.equal(stripOsc133(message.render(24)[1]), "┃ a user message long", "a margin change redraws through the patch");
    } finally {
      restore();
    }
  });

  it("numbers components in the order Pi builds them, and keeps the number through a margin change", async () => {
    const { installMmrUserMessageDraw, getMmrLatestUserMessageNumber } = await importSource(
      "extensions/ampi-tui/pi-compat/messages.ts",
    );
    const restore = installMmrUserMessageDraw((_text, _width, _pad, number) => [`#${number}`]);
    try {
      const before = getMmrLatestUserMessageNumber();
      const first = new UserMessageComponent("a");
      const second = new UserMessageComponent("b");
      assert.equal(getMmrLatestUserMessageNumber(), before + 2);
      first.setOutputPad(0);
      assert.deepEqual(first.render(10).map(stripOsc133), [`#${before + 1}`]);
      assert.deepEqual(second.render(10).map(stripOsc133), [`#${before + 2}`]);
      assert.equal(getMmrLatestUserMessageNumber(), before + 2, "a rebuild is no new message");
    } finally {
      restore();
    }
  });

  it("replaces an earlier draw instead of stacking, and restores Pi's rebuild exactly once", async () => {
    const { installMmrUserMessageDraw } = await importSource("extensions/ampi-tui/pi-compat/messages.ts");
    const first = installMmrUserMessageDraw(() => ["first"]);
    // A second module copy, as /reload loads one.
    const reloaded = await importSource("extensions/ampi-tui/pi-compat/messages.ts");
    const second = reloaded.installMmrUserMessageDraw(() => ["second"]);
    assert.deepEqual(new UserMessageComponent("x").render(10).map(stripOsc133), ["second"]);
    first();
    assert.deepEqual(new UserMessageComponent("x").render(10).map(stripOsc133), ["second"], "a stale restore is ignored");
    second();
    second();
  });

  it("leaves a class with a different shape alone and says what changed", async () => {
    const { installMmrUserMessageDraw, probeMmrUserMessageComponent } = await importSource(
      "extensions/ampi-tui/pi-compat/messages.ts",
    );
    class Renamed {
      constructor(content) {
        this.content = content;
        this.outputPad = 1;
      }
      rebuild() {}
      clear() {}
      addChild() {}
      render() {
        return [];
      }
    }
    class NoRebuild {
      clear() {}
      addChild() {}
      render() {
        return [];
      }
    }
    assert.equal(probeMmrUserMessageComponent(null), "UserMessageComponent is no longer exported as a class");
    assert.equal(probeMmrUserMessageComponent(NoRebuild), "UserMessageComponent.prototype.rebuild is missing");
    assert.equal(probeMmrUserMessageComponent(Renamed), "UserMessageComponent no longer keeps its text in `text`");

    const rebuild = Renamed.prototype.rebuild;
    assert.equal(installMmrUserMessageDraw(() => ["x"], Renamed), undefined);
    assert.equal(Renamed.prototype.rebuild, rebuild, "the prototype is untouched");
  });
});

describe("ampi-tui transcript styling in a session", () => {
  it("installs on load, hides the collapsed-thinking label, draws in the session theme, and restores on shutdown", async () => {
    const { createMmrTuiExtension } = await importSource("extensions/ampi-tui/index.ts");
    const { pi, handlers } = createMockPi();
    createMmrTuiExtension({ loadSettings: () => ({ enabled: true, intro: false }) })(pi);
    assert.notEqual(UserMessageComponent.prototype.rebuild, originalRebuild, "the patch is in before any session starts");
    assert.deepEqual(
      new UserMessageComponent("hi").render(20).map(stripOsc133),
      ["", " ┃ hi"],
      "without a session theme yet, the drawing has no colour",
    );

    const { ctx, thinkingLabels } = createMockExtensionContext({ hasUI: true });
    ctx.ui.theme = { ...ctx.ui.theme, ...taggedTheme };
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    assert.deepEqual(thinkingLabels, [""]);
    assert.match(new UserMessageComponent("hi").render(20).map(stripOsc133)[1], /<userMessageText>┃ <\/userMessageText><i>/);

    await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
    assert.equal(UserMessageComponent.prototype.rebuild, originalRebuild);
  });
});
