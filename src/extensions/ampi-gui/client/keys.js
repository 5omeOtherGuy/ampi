// The web GUI's key dispatcher: the chord grammar, a KeyboardEvent as a
// chord, two-step sequences, the rules for keys typed into a field, and
// conflicts between commands. Pure, so tests load it in Node without a DOM;
// app.js feeds it the page's key presses and runs what it picks.
//
// Grammar, spelled as ampi-core's terminal keymap spells it where it can:
//
// - A chord is one or two combos separated by a space: `mod+b`, `g g`,
//   `ctrl+g p`, `esc esc`.
// - A combo is modifiers plus one key joined by `+`, case-insensitive.
//   Modifiers are `ctrl`, `alt` (`option`), `shift`, `meta` (`cmd`,
//   `command`) and `mod`, which is `meta` on macOS and `ctrl` elsewhere.
// - Keys: `esc`, `enter`, `space`, `tab`, `backspace`, `delete`, `up`,
//   `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `f1` to
//   `f12`, or one character. A lone uppercase letter means shift plus that
//   letter. A shifted symbol is the symbol it types: `alt+shift+/` and
//   `alt+?` are the same chord.

/** How long the second key of a sequence may wait, as for the terminal's chords. */
export const SEQUENCE_MS = 1500;

/** Keys a browser tab never hands to the page, as canonical chords by platform. */
export const BROWSER_RESERVED = {
  default: ["ctrl+n", "ctrl+t", "ctrl+w", "ctrl+tab", "ctrl+shift+t"],
  mac: ["meta+n", "meta+t", "meta+w", "ctrl+tab", "shift+meta+t"],
};

const MODIFIERS = ["ctrl", "alt", "shift", "meta"];
const MODIFIER_ALIASES = { ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift", meta: "meta", cmd: "meta", command: "meta", mod: "mod" };
const KEY_ALIASES = {
  esc: "esc",
  escape: "esc",
  enter: "enter",
  return: "enter",
  space: "space",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  del: "delete",
  up: "up",
  arrowup: "up",
  down: "down",
  arrowdown: "down",
  left: "left",
  arrowleft: "left",
  right: "right",
  arrowright: "right",
  home: "home",
  end: "end",
  pageup: "pageup",
  pgup: "pageup",
  pagedown: "pagedown",
  pgdn: "pagedown",
};

/** `KeyboardEvent.key` names of the named keys. */
const EVENT_KEYS = {
  Escape: "esc",
  Esc: "esc",
  Enter: "enter",
  " ": "space",
  Spacebar: "space",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

/** Keys that are not a press of their own: modifiers, dead keys, input methods. */
const NOT_KEYS = new Set([
  "Dead",
  "Unidentified",
  "Process",
  "Compose",
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "Super",
  "Hyper",
  "Fn",
  "CapsLock",
  "NumLock",
  "ScrollLock",
]);

/** What shift types on a US keyboard, so a binding can name either. */
const SHIFTED = {
  "`": "~",
  1: "!",
  2: "@",
  3: "#",
  4: "$",
  5: "%",
  6: "^",
  7: "&",
  8: "*",
  9: "(",
  0: ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
};

/** `KeyboardEvent.code` of the symbol keys: with Alt, macOS types another character, so the key comes from the code. */
const CODE_SYMBOLS = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

const NAMED_LABELS = {
  esc: "Esc",
  enter: "Enter",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

const isLetter = (key) => /^[a-z]$/.test(key);
const isNamed = (key) => key in NAMED_LABELS || /^f([1-9]|1[0-2])$/.test(key);

function parseCombo(text) {
  if (text === "") return { error: "empty key" };
  const combo = { key: "", ctrl: false, alt: false, shift: false, meta: false, mod: false };
  // `+` is a key too: `ctrl++`.
  const parts = text.endsWith("++") ? [...text.slice(0, -2).split("+"), "+"] : text.split("+");
  const keyText = parts.pop();
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) return { error: `unknown modifier "${part}"` };
    combo[modifier] = true;
  }
  if (!keyText) return { error: `no key in "${text}"` };
  const named = KEY_ALIASES[keyText.toLowerCase()];
  if (named) combo.key = named;
  else if (/^f([1-9]|1[0-2])$/i.test(keyText)) combo.key = keyText.toLowerCase();
  else if ([...keyText].length === 1) {
    if (/^[A-Z]$/.test(keyText) && parts.length === 0) combo.shift = true;
    combo.key = keyText.toLowerCase();
  } else return { error: `unknown key "${keyText}"` };
  return combo;
}

/** A chord as written (`alt+shift+/`), parsed: `{ combos }`, or `{ error }` when it does not parse. */
export function parseChord(text) {
  if (typeof text !== "string") return { error: "not a string" };
  const parts = text.trim().split(/\s+/);
  if (parts.length > 2) return { error: "a chord has one or two keys" };
  const combos = [];
  for (const part of parts) {
    const combo = parseCombo(part);
    if (combo.error) return combo;
    combos.push(combo);
  }
  return { combos };
}

/** One combo in canonical form: `mod` resolved, a shifted symbol folded into the symbol, modifiers in a fixed order. */
function comboId(combo, mac) {
  let key = combo.key;
  let shift = combo.shift;
  if (!isLetter(key) && !isNamed(key) && [...key].length === 1) {
    if (shift && SHIFTED[key]) key = SHIFTED[key];
    shift = false;
  }
  const on = {
    ctrl: combo.ctrl || (combo.mod && !mac),
    alt: combo.alt,
    shift,
    meta: combo.meta || (combo.mod && mac),
  };
  return [...MODIFIERS.filter((name) => on[name]), key].join("+");
}

/** The canonical form of a chord as written, on this platform, or `null` when it does not parse. */
export function chordId(text, { mac = false } = {}) {
  const parsed = parseChord(text);
  return parsed.error ? null : parsed.combos.map((combo) => comboId(combo, mac)).join(" ");
}

/** The key an event names, before modifiers. */
function eventKey(event) {
  if (event.altKey) {
    const code = event.code ?? "";
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit\d$/.test(code)) return event.shiftKey ? SHIFTED[code.slice(5)] : code.slice(5);
    if (CODE_SYMBOLS[code]) return event.shiftKey ? SHIFTED[CODE_SYMBOLS[code]] : CODE_SYMBOLS[code];
  }
  if (EVENT_KEYS[event.key]) return EVENT_KEYS[event.key];
  if (/^F([1-9]|1[0-2])$/.test(event.key)) return event.key.toLowerCase();
  if ([...event.key].length === 1) return event.key.toLowerCase();
  return null;
}

/**
 * A key press as a canonical combo (`ctrl+shift+e`, `?`, `alt+?`, `up`), or
 * `null` for a press that is no key of its own: a modifier, a dead key, an
 * input method composing.
 */
export function eventChord(event, { mac = false } = {}) {
  if (!event?.key || event.isComposing || NOT_KEYS.has(event.key)) return null;
  const key = eventKey(event);
  if (!key) return null;
  return comboId(
    { key, ctrl: Boolean(event.ctrlKey), alt: Boolean(event.altKey), shift: Boolean(event.shiftKey), meta: Boolean(event.metaKey), mod: false },
    mac,
  );
}

/** Whether a canonical combo holds Ctrl, Alt or Meta: only those fire while a field has focus. */
export function hasCommandModifier(combo) {
  return /(^|\+)(ctrl|alt|meta)\+/.test(combo);
}

/** Whether focus is in a text field, where plain keys type. */
export function inTextField(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

/** Whether the browser keeps a canonical chord for itself in a tab. */
export function isBrowserReserved(id, { mac = false } = {}) {
  return (mac ? BROWSER_RESERVED.mac : BROWSER_RESERVED.default).includes(id);
}

/** A command's keys: the user's override when there is one, else its defaults. */
export function keysOf(command, overrides = {}) {
  return Object.hasOwn(overrides, command.id) ? overrides[command.id] : (command.keys ?? []);
}

/** A command's availability for `state`: `{ state: "available" | "unavailable" | "hidden", reason? }`. */
export function availabilityOf(command, state) {
  return command.when ? command.when(state) : { state: "available" };
}

/** The context a command listens in: `global` unless it names one, such as `sidebar` for the sidebar's focus mode. */
const contextOf = (command) => command.context ?? "global";

/**
 * Pairs of commands that cannot both have their keys: the same chord, or
 * one chord that starts the other's sequence, in the same context.
 * Answers `[{ chord, ids: [first, second], kind: "same" | "prefix" }]`.
 */
export function findConflicts(commands, { mac = false, overrides = {} } = {}) {
  const bindings = [];
  for (const command of commands) {
    for (const text of keysOf(command, overrides)) {
      const id = chordId(text, { mac });
      if (id) bindings.push({ id, command: command.id, context: contextOf(command) });
    }
  }
  const conflicts = [];
  for (const [index, a] of bindings.entries()) {
    for (const b of bindings.slice(index + 1)) {
      if (a.context !== b.context || a.command === b.command) continue;
      if (a.id === b.id) conflicts.push({ chord: a.id, ids: [a.command, b.command], kind: "same" });
      else if (b.id.startsWith(`${a.id} `) || a.id.startsWith(`${b.id} `)) {
        conflicts.push({ chord: a.id.length < b.id.length ? a.id : b.id, ids: [a.command, b.command], kind: "prefix" });
      }
    }
  }
  return conflicts;
}

/**
 * The dispatcher. `commands()` lists the registry's entries; `now` is the
 * clock the sequence window reads. `handle(event, state)` answers what a
 * key press does, and never runs anything itself:
 *
 * - `{ kind: "run", command, chord }`: run it, and take the key from the browser;
 * - `{ kind: "pending", prefix, commands, consume }`: the first key of a
 *   sequence, waiting for the second; `consume` when it holds a modifier
 *   (`ctrl+g`), so the browser does not act on it;
 * - `{ kind: "unavailable", command, chord, reason }`: bound, but its
 *   `when(state)` says no;
 * - `{ kind: "swallow" }`: a wrong key after `ctrl+g`, which does nothing;
 * - `null`: not a key of this page.
 *
 * `state.contexts` lists the contexts that listen, most specific first
 * (default `["global"]`). A wrong key after a plain first key (`g`, `esc`)
 * counts as a new press.
 */
export function createKeyDispatcher({ commands, mac = false, now = () => Date.now(), windowMs = SEQUENCE_MS, overrides = {} }) {
  let pending = null;

  function bindings(contexts) {
    const found = [];
    for (const context of contexts) {
      for (const command of commands()) {
        if (contextOf(command) !== context) continue;
        for (const text of keysOf(command, overrides)) {
          const id = chordId(text, { mac });
          if (id) found.push({ id, command });
        }
      }
    }
    return found;
  }

  function exact(list, id, state) {
    let blocked = null;
    for (const binding of list) {
      if (binding.id !== id) continue;
      const availability = availabilityOf(binding.command, state);
      if (availability.state === "available") return { kind: "run", command: binding.command, chord: id };
      if (availability.state === "unavailable" && !blocked) {
        blocked = { kind: "unavailable", command: binding.command, chord: id, reason: availability.reason };
      }
    }
    return blocked;
  }

  return {
    handle(event, state = {}) {
      if (event.defaultPrevented) {
        pending = null;
        return null;
      }
      const combo = eventChord(event, { mac });
      if (!combo) return null;
      if (inTextField(event.target) && !hasCommandModifier(combo) && combo !== "esc") {
        pending = null;
        return null;
      }
      const list = bindings(state.contexts ?? ["global"]);
      const at = now();
      if (pending) {
        const { prefix, since } = pending;
        pending = null;
        if (at - since <= windowMs) {
          const second = exact(list, `${prefix} ${combo}`, state);
          if (second?.kind === "run") return second;
          if (hasCommandModifier(prefix)) return second ?? { kind: "swallow" };
        }
      }
      const result = exact(list, combo, state);
      if (result?.kind === "run") return result;
      const waiting = list.filter((binding) => binding.id.startsWith(`${combo} `) && availabilityOf(binding.command, state).state === "available");
      if (waiting.length > 0) {
        pending = { prefix: combo, since: at };
        return { kind: "pending", prefix: combo, commands: [...new Set(waiting.map((binding) => binding.command))], consume: hasCommandModifier(combo) };
      }
      return result;
    },
    /** Forget a sequence's first key. */
    reset() {
      pending = null;
    },
  };
}

function comboLabel(combo, mac) {
  let key = combo.key;
  const modified = combo.ctrl || combo.alt || combo.meta || combo.mod || (combo.shift && (isLetter(key) || isNamed(key)));
  key = NAMED_LABELS[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : modified ? key.toUpperCase() : key);
  const meta = combo.meta || (combo.mod && mac);
  const ctrl = combo.ctrl || (combo.mod && !mac);
  if (mac) return `${ctrl ? "⌃" : ""}${combo.alt ? "⌥" : ""}${combo.shift ? "⇧" : ""}${meta ? "⌘" : ""}${key}`;
  return [ctrl && "Ctrl", combo.alt && "Alt", combo.shift && "Shift", meta && "Meta", key].filter(Boolean).join("+");
}

/**
 * A chord as the key chips a person presses, one per step, in the
 * platform's names: `mod+shift+e` is `["Ctrl+Shift+E"]`, or `["⇧⌘E"]` on
 * macOS; `ctrl+g p` is `["Ctrl+G", "p"]`. Empty when it does not parse.
 */
export function chordLabels(text, { mac = false } = {}) {
  const parsed = parseChord(text);
  return parsed.error ? [] : parsed.combos.map((combo) => comboLabel(combo, mac));
}
