import type { MmrKeyCombo } from "../../ampi-core/keymap.js";

/**
 * Terminal input -> key combos in the keymap's vocabulary.
 *
 * Covers what a terminal sends for the keys ampi binds: printable characters,
 * Ctrl+letter, Alt+key as an ESC prefix, Esc, Enter, Tab, Backspace, Delete,
 * the arrows, Home/End, PageUp/PageDown, F1-F12, the CSI forms with a
 * modifier parameter, the CSI-u form (kitty keyboard protocol) and the
 * `CSI 27;mod;code ~` form (xterm modifyOtherKeys, which tmux can emit).
 *
 * Two Escapes typed quickly can reach Pi as one chunk; `\x1b\x1b` decodes to
 * two `esc` combos. Esc followed quickly by Enter arrives as `\x1b\r`, which
 * is indistinguishable from Alt+Enter and decodes as that.
 */

const ESC = "\x1b";

interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

const NONE: Modifiers = { ctrl: false, alt: false, shift: false, meta: false };

function combo(key: string, mods: Partial<Modifiers> = {}): MmrKeyCombo {
  return { key, ...NONE, ...mods };
}

/** Letter keys of `CSI <params> <letter>` and `SS3 <letter>`. */
const LETTER_KEYS: Readonly<Record<string, string>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

/** Numbers of `CSI <n> ~`. Insert (2) has no keymap name and stays undecoded. */
const TILDE_KEYS: Readonly<Record<number, string>> = {
  1: "home",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

/** Code points with a keymap name in CSI-u and modifyOtherKeys sequences. */
const CODE_KEYS: Readonly<Record<number, string>> = {
  8: "backspace",
  9: "tab",
  13: "enter",
  27: "esc",
  32: "space",
  127: "backspace",
};

/** Single control bytes other than Ctrl+letter. */
const CONTROL_KEYS: ReadonlyMap<number, MmrKeyCombo> = new Map([
  [0x00, combo("space", { ctrl: true })],
  [0x08, combo("backspace")],
  [0x09, combo("tab")],
  [0x0a, combo("enter")],
  [0x0d, combo("enter")],
  [0x1b, combo("esc")],
  [0x1c, combo("\\", { ctrl: true })],
  [0x1d, combo("]", { ctrl: true })],
  [0x1e, combo("^", { ctrl: true })],
  [0x1f, combo("-", { ctrl: true })],
  [0x20, combo("space")],
  [0x7f, combo("backspace")],
]);

/** The terminal modifier parameter: 1 + bit set (shift 1, alt 2, ctrl 4, super 8, meta 32; lock bits ignored). */
function parseModifierParam(text: string | undefined): Modifiers | undefined {
  if (text === undefined || text === "") return NONE;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) return undefined;
  const bits = value - 1;
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
    meta: (bits & (8 | 32)) !== 0,
  };
}

function withModifiers(base: MmrKeyCombo, mods: Modifiers): MmrKeyCombo {
  return {
    key: base.key,
    ctrl: base.ctrl || mods.ctrl,
    alt: base.alt || mods.alt,
    shift: base.shift || mods.shift,
    meta: base.meta || mods.meta,
  };
}

/** One printable character as the keymap would parse it: `Z` is shift+z. */
function characterCombo(char: string, mods: Modifiers = NONE): MmrKeyCombo {
  const lower = char.toLowerCase();
  if (lower !== char && [...lower].length === 1) return withModifiers(combo(lower), { ...mods, shift: true });
  return withModifiers(combo(char), mods);
}

/** Key from a code point in a CSI-u or modifyOtherKeys sequence. */
function codeCombo(code: number, shifted: number | undefined, mods: Modifiers): MmrKeyCombo | undefined {
  const named = CODE_KEYS[code];
  if (named) return withModifiers(combo(named), mods);
  // Private-use code points are kitty's functional keys (keypad, media,
  // lone modifiers); none of them has a keymap name.
  if (code < 32 || (code >= 0xe000 && code <= 0xf8ff) || code > 0x10ffff) return undefined;
  const char = String.fromCodePoint(code);
  if (mods.shift && shifted !== undefined && shifted >= 32) {
    // The terminal reported the shifted character (`?` for shift+/), so the
    // shift is already part of the key.
    return characterCombo(String.fromCodePoint(shifted), { ...mods, shift: false });
  }
  return characterCombo(char, mods);
}

const CSI = /^\x1b\[([0-9:;]*)([A-Za-z~])$/;
const SS3 = /^\x1bO([A-Z])$/;

type Decoded = MmrKeyCombo | "release" | undefined;

function decodeSequence(data: string): Decoded {
  const ss3 = SS3.exec(data);
  if (ss3) {
    const key = LETTER_KEYS[ss3[1]];
    return key ? combo(key) : undefined;
  }
  const csi = CSI.exec(data);
  if (!csi) return undefined;
  const [, paramText, final] = csi;
  const params = paramText.split(";").map((part) => part.split(":"));
  const modsField = params[1] ?? [];
  // Kitty event types: 1 press, 2 repeat, 3 release.
  if (modsField[1] === "3") return "release";
  const mods = parseModifierParam(modsField[0]);
  if (!mods) return undefined;

  if (final === "u") {
    const code = Number(params[0]?.[0]);
    if (!Number.isInteger(code)) return undefined;
    const shiftedText = params[0]?.[1];
    const shifted = shiftedText ? Number(shiftedText) : undefined;
    return codeCombo(code, Number.isInteger(shifted) ? shifted : undefined, mods);
  }
  if (final === "~") {
    const number = Number(params[0]?.[0]);
    if (number === 27 && params.length >= 3) {
      // modifyOtherKeys: CSI 27 ; <mods> ; <code> ~
      const code = Number(params[2]?.[0]);
      return Number.isInteger(code) ? codeCombo(code, undefined, mods) : undefined;
    }
    const key = TILDE_KEYS[number];
    return key ? withModifiers(combo(key), mods) : undefined;
  }
  if (final === "Z" && paramText === "") return combo("tab", { shift: true });
  const key = LETTER_KEYS[final];
  return key ? withModifiers(combo(key), mods) : undefined;
}

/** One key without an ESC prefix: a control byte, a printable character or an escape sequence. */
function decodeOne(data: string): Decoded {
  if (data.startsWith(ESC) && data.length > 1) return decodeSequence(data);
  const chars = [...data];
  if (chars.length !== 1) return undefined;
  const code = data.codePointAt(0) ?? -1;
  const control = CONTROL_KEYS.get(code);
  if (control) return control;
  if (code >= 0x01 && code <= 0x1a) return combo(String.fromCharCode(code + 0x60), { ctrl: true });
  if (code < 0x20) return undefined;
  return characterCombo(data);
}

/**
 * Decode one chunk of terminal input. Returns the key combos it holds (two
 * for a merged double Escape, otherwise one), or `undefined` when the chunk
 * is not a key ampi understands: pasted or multi-character text, unknown
 * sequences, and key-release reports.
 */
export function decodeMmrTerminalKeys(data: string): MmrKeyCombo[] | undefined {
  if (data === `${ESC}${ESC}`) return [combo("esc"), combo("esc")];
  const direct = decodeOne(data);
  if (direct === "release") return undefined;
  if (direct) return [direct];
  // Alt+key: ESC followed by the key's own bytes (`\x1bx`, `\x1b\r`, `\x1b\x1b[A`).
  if (data.startsWith(ESC) && data.length > 1) {
    const rest = decodeOne(data.slice(1));
    if (rest && rest !== "release" && !rest.alt) return [{ ...rest, alt: true }];
  }
  return undefined;
}
