// The quit summary printed to the normal scrollback after an interactive quit.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

let formatMmrQuitSummary;
let printMmrQuitSummary;

before(async () => {
  ({ formatMmrQuitSummary, printMmrQuitSummary } = await importSource("extensions/ampi-tui/chrome/quit-summary.ts"));
});

/** Marks each colour role, so the test sees which text got which. */
const taggedTheme = { fg: (role, text) => `<${role}>${text}</>`, bold: (text) => `<b>${text}</b>` };
const plainTheme = { fg: (_role, text) => text, bold: (text) => text };

describe("ampi-tui quit summary", () => {
  it("draws the resting mark with the title and the directory beside its middle rows", () => {
    const lines = formatMmrQuitSummary({ title: "rename the parser", cwd: "/work/demo", theme: plainTheme });
    assert.deepEqual(lines, [
      "   ●  ·  ·",
      " •         ·   rename the parser",
      "•     ●     ·  /work/demo",
      " ·         ·",
      "   ·  ·  ·",
    ]);
  });

  it("puts the title in bold and the directory in the dim role", () => {
    const lines = formatMmrQuitSummary({ title: "T", cwd: "/w", theme: taggedTheme });
    assert.ok(lines[1].endsWith("  <b>T</b>"), lines[1]);
    assert.ok(lines[2].endsWith("  <dim>/w</>"), lines[2]);
  });

  it("prints the session title and directory once Pi has handed the terminal back, and no resume command", () => {
    const { ctx, entries } = createMockExtensionContext({ cwd: "/work/demo" });
    entries.push({ type: "message", message: { role: "user", content: "rename the parser module and its imports everywhere" } });
    const out = [];
    assert.equal(printMmrQuitSummary(ctx, { terminalReleased: () => true, write: (text) => out.push(text) }), true);
    assert.equal(out.length, 1);
    const lines = stripTerminalSequences(out[0]).split("\n");
    assert.equal(lines.at(-1), "", "ends with a newline, so Pi's resume line starts on its own row");
    // 39 columns of the message and the ellipsis make the 40.
    assert.match(lines[1], /  rename the parser module and its import…$/);
    assert.match(lines[2], /  \/work\/demo$/);
    assert.ok(!out[0].includes("--session"), "Pi prints the resume command itself");
  });

  it("prints the session name when the session has one", () => {
    const { ctx } = createMockExtensionContext({ cwd: "/work/demo", sessionName: "Parser rename" });
    const out = [];
    printMmrQuitSummary(ctx, { terminalReleased: () => true, write: (text) => out.push(text) });
    assert.match(stripTerminalSequences(out[0]).split("\n")[1], /  Parser rename$/);
  });

  it("prints nothing while Pi's UI still owns the terminal, and never throws on a closed one", () => {
    const { ctx } = createMockExtensionContext({ cwd: "/work/demo" });
    const out = [];
    assert.equal(printMmrQuitSummary(ctx, { terminalReleased: () => false, write: (text) => out.push(text) }), false);
    assert.deepEqual(out, []);
    const broken = () => {
      throw new Error("EIO");
    };
    assert.doesNotThrow(() => printMmrQuitSummary(ctx, { terminalReleased: () => true, write: broken }));
  });
});
