import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

let decode;
let format;

before(async () => {
  ({ decodeMmrTerminalKeys: decode } = await importSource("extensions/ampi-tui/keys/decode.ts"));
  const { formatMmrKeyChord } = await importSource("extensions/ampi-core/keymap.ts");
  format = (combos) => combos.map((combo) => formatMmrKeyChord({ leader: false, combos: [combo] })).join(" ");
});

/** Decoded combos in canonical keymap text, or undefined. */
function keys(data) {
  const combos = decode(data);
  return combos === undefined ? undefined : format(combos);
}

describe("ampi-tui key decoder", () => {
  it("decodes printable characters as the keymap parses them", () => {
    assert.equal(keys("a"), "a");
    assert.equal(keys("Z"), "shift+z");
    assert.equal(keys("?"), "?");
    assert.equal(keys("/"), "/");
    assert.equal(keys(" "), "space");
    assert.equal(keys("é"), "é");
  });

  it("decodes control bytes", () => {
    assert.equal(keys("\x03"), "ctrl+c");
    assert.equal(keys("\x18"), "ctrl+x");
    assert.equal(keys("\x07"), "ctrl+g");
    assert.equal(keys("\x0f"), "ctrl+o");
    assert.equal(keys("\x00"), "ctrl+space");
    assert.equal(keys("\t"), "tab");
    assert.equal(keys("\r"), "enter");
    assert.equal(keys("\x7f"), "backspace");
    assert.equal(keys("\x08"), "backspace");
  });

  it("tells a lone Escape from an Escape-prefixed Alt key", () => {
    assert.equal(keys("\x1b"), "esc");
    assert.equal(keys("\x1bx"), "alt+x");
    assert.equal(keys("\x1bX"), "alt+shift+x");
    assert.equal(keys("\x1b\r"), "alt+enter", "Esc+Enter typed fast cannot be told from Alt+Enter");
    assert.equal(keys("\x1b\x7f"), "alt+backspace");
    assert.equal(keys("\x1b\x03"), "ctrl+alt+c");
    assert.equal(keys("\x1b["), "alt+[");
  });

  it("splits a merged double Escape but keeps Alt plus an escape sequence whole", () => {
    assert.equal(keys("\x1b\x1b"), "esc esc");
    assert.equal(keys("\x1b\x1b[A"), "alt+up");
    assert.equal(keys("\x1b\x1b\x1b"), undefined);
  });

  it("decodes cursor, page and function keys in their CSI and SS3 forms", () => {
    assert.equal(keys("\x1b[A"), "up");
    assert.equal(keys("\x1bOB"), "down");
    assert.equal(keys("\x1b[1;5C"), "ctrl+right");
    assert.equal(keys("\x1b[H"), "home");
    assert.equal(keys("\x1bOH"), "home");
    assert.equal(keys("\x1b[1~"), "home");
    assert.equal(keys("\x1b[7~"), "home");
    assert.equal(keys("\x1b[F"), "end");
    assert.equal(keys("\x1b[4~"), "end");
    assert.equal(keys("\x1b[1;5H"), "ctrl+home", "a modifier keeps Home distinct from plain Home");
    assert.equal(keys("\x1b[5~"), "pageup");
    assert.equal(keys("\x1b[6;2~"), "shift+pagedown");
    assert.equal(keys("\x1b[3~"), "delete");
    assert.equal(keys("\x1bOP"), "f1");
    assert.equal(keys("\x1b[15~"), "f5");
    assert.equal(keys("\x1b[24~"), "f12");
    assert.equal(keys("\x1b[Z"), "shift+tab");
    assert.equal(keys("\x1b[2~"), undefined, "Insert has no keymap name");
  });

  it("decodes CSI-u (kitty) keys, including shifted alternates and lock bits", () => {
    assert.equal(keys("\x1b[99;5u"), "ctrl+c");
    assert.equal(keys("\x1b[120;5u"), "ctrl+x");
    assert.equal(keys("\x1b[27u"), "esc");
    assert.equal(keys("\x1b[13;3u"), "alt+enter");
    assert.equal(keys("\x1b[122;2u"), "shift+z");
    assert.equal(keys("\x1b[47:63;2u"), "?", "the reported shifted character replaces shift+/");
    assert.equal(keys("\x1b[47;2u"), "shift+/", "without a shifted character the shift stays");
    assert.equal(keys("\x1b[99;69u"), "ctrl+c", "caps lock (64) is ignored");
    assert.equal(keys("\x1b[107;9u"), "meta+k");
  });

  it("ignores key releases but keeps repeats", () => {
    assert.equal(keys("\x1b[99;5:3u"), undefined);
    assert.equal(keys("\x1b[1;1:3H"), undefined);
    assert.equal(keys("\x1b[99;5:2u"), "ctrl+c");
    assert.equal(keys("\x1b[99;5:1u"), "ctrl+c");
  });

  it("decodes the modifyOtherKeys form tmux can emit", () => {
    assert.equal(keys("\x1b[27;5;99~"), "ctrl+c");
    assert.equal(keys("\x1b[27;5;120~"), "ctrl+x");
    assert.equal(keys("\x1b[27;2;13~"), "shift+enter");
  });

  it("returns nothing for text and sequences that are not keys", () => {
    assert.equal(keys("hello"), undefined);
    assert.equal(keys("\x1b[200~pasted\x1b[201~"), undefined);
    assert.equal(keys("\x1b[57399u"), undefined, "kitty keypad keys have no keymap name");
    assert.equal(keys("\x1b[<0;10;5M"), undefined, "mouse reports are not keys");
    assert.equal(keys(""), undefined);
  });
});
