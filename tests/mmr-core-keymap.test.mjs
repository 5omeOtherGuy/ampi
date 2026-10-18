// Keymap model: key-string grammar, formatting, the ampi.keymap settings
// reader, override resolution, conflict detection, and JSONC output.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const KEYMAP_MODULE = "extensions/ampi-core/keymap.ts";
const keymap = await importSource(KEYMAP_MODULE);
const {
  areMmrKeyChordsEqual,
  formatMmrKeyChord,
  formatMmrKeymapJsonc,
  parseMmrKeyChord,
  readMmrKeymapSettings,
  resolveMmrKeymap,
} = keymap;

function combo(key, mods = []) {
  return {
    key,
    ctrl: mods.includes("ctrl"),
    alt: mods.includes("alt"),
    shift: mods.includes("shift"),
    meta: mods.includes("meta"),
  };
}

function canonical(text) {
  const parsed = parseMmrKeyChord(text);
  assert.ok(!("error" in parsed), `expected "${text}" to parse, got ${JSON.stringify(parsed)}`);
  return formatMmrKeyChord(parsed);
}

describe("parseMmrKeyChord", () => {
  it("parses chords into combos", () => {
    assert.deepEqual(parseMmrKeyChord("ctrl+c ctrl+n"), {
      leader: false,
      combos: [combo("c", ["ctrl"]), combo("n", ["ctrl"])],
    });
    assert.deepEqual(parseMmrKeyChord("  esc   esc "), { leader: false, combos: [combo("esc"), combo("esc")] });
    assert.deepEqual(parseMmrKeyChord("alt+shift+meta+ctrl+a"), {
      leader: false,
      combos: [combo("a", ["ctrl", "alt", "shift", "meta"])],
    });
  });

  it("normalises modifier aliases and case", () => {
    const cases = {
      "option+x": "alt+x",
      "cmd+x": "meta+x",
      "command+x": "meta+x",
      "mod+s": "ctrl+s",
      "CTRL+C": "ctrl+c",
      "Ctrl+Shift+C": "ctrl+shift+c",
      "shift+ctrl+a": "ctrl+shift+a",
      "Meta+Alt+x": "alt+meta+x",
    };
    for (const [input, expected] of Object.entries(cases)) assert.equal(canonical(input), expected, input);
  });

  it("normalises key names", () => {
    const cases = {
      escape: "esc",
      ESC: "esc",
      return: "enter",
      Enter: "enter",
      space: "space",
      tab: "tab",
      backspace: "backspace",
      Delete: "delete",
      up: "up",
      down: "down",
      left: "left",
      right: "right",
      home: "home",
      end: "end",
      pgup: "pageup",
      PageUp: "pageup",
      pgdn: "pagedown",
      pagedown: "pagedown",
      F5: "f5",
      f12: "f12",
      "?": "?",
      "ctrl++": "ctrl++",
      "+": "+",
      "alt+/": "alt+/",
    };
    for (const [input, expected] of Object.entries(cases)) assert.equal(canonical(input), expected, input);
  });

  it("reads a lone uppercase letter as shift plus the letter", () => {
    assert.equal(canonical("Z"), "shift+z");
    assert.equal(canonical("shift+Z"), "shift+z");
    assert.equal(canonical("z"), "z");
    assert.equal(canonical("<leader>Z"), "<leader>shift+z");
  });

  it("keeps <leader> as a marker at the start of a chord", () => {
    const expected = { leader: true, combos: [combo("z", ["shift"])] };
    assert.deepEqual(parseMmrKeyChord("<leader>shift+z"), expected);
    assert.deepEqual(parseMmrKeyChord("<leader> shift+z"), expected);
    assert.deepEqual(parseMmrKeyChord("<LEADER>Shift+Z"), expected);
    assert.deepEqual(parseMmrKeyChord("<leader>p q"), { leader: true, combos: [combo("p"), combo("q")] });
  });

  it("returns an error for malformed key strings", () => {
    const cases = {
      "": /empty key string/,
      "   ": /empty key string/,
      "ctrl+": /no key after the last "\+"/,
      "hyper+x": /"hyper" is not a modifier/,
      "ctrl+ctrl+x": /repeats the ctrl modifier/,
      "mod+ctrl+x": /repeats the ctrl modifier/,
      "ctrl+foo": /"foo" is not a key name/,
      f13: /"f13" is not a key name/,
      "x <leader>": /may only start a chord/,
      "ctrl+<leader>": /may only start a chord/,
      "<leader>": /must be followed by a key/,
      "++x": /is not a modifier/,
    };
    for (const [input, pattern] of Object.entries(cases)) {
      const result = parseMmrKeyChord(input);
      assert.ok("error" in result, `expected an error for ${JSON.stringify(input)}`);
      assert.match(result.error, pattern, input);
    }
  });
});

describe("formatMmrKeyChord and areMmrKeyChordsEqual", () => {
  it("renders canonical and display forms", () => {
    const archive = parseMmrKeyChord("ctrl+c ctrl+n");
    assert.equal(formatMmrKeyChord(archive), "ctrl+c ctrl+n");
    assert.equal(formatMmrKeyChord(archive, { style: "display" }), "Ctrl+C Ctrl+N");
    assert.equal(formatMmrKeyChord(parseMmrKeyChord("escape escape"), { style: "display" }), "Esc Esc");
    assert.equal(formatMmrKeyChord(parseMmrKeyChord("alt+pgdn"), { style: "display" }), "Alt+PgDn");
    assert.equal(formatMmrKeyChord(parseMmrKeyChord("shift+f5"), { style: "display" }), "Shift+F5");
  });

  it("expands <leader> only when a leader is given", () => {
    const redo = parseMmrKeyChord("<leader>shift+z");
    const leader = combo("x", ["ctrl"]);
    assert.equal(formatMmrKeyChord(redo), "<leader>shift+z");
    assert.equal(formatMmrKeyChord(redo, { leader }), "ctrl+x shift+z");
    assert.equal(formatMmrKeyChord(redo, { leader, style: "display" }), "Ctrl+X Shift+Z");
  });

  it("round-trips the display form", () => {
    for (const text of ["ctrl+c ctrl+n", "shift+z", "alt+t", "esc esc", "ctrl+shift+pageup"]) {
      const display = formatMmrKeyChord(parseMmrKeyChord(text), { style: "display" });
      assert.equal(canonical(display), text, display);
    }
  });

  it("compares chords, expanding <leader> when asked", () => {
    const undo = parseMmrKeyChord("<leader>z");
    const spelled = parseMmrKeyChord("ctrl+x z");
    assert.equal(areMmrKeyChordsEqual(undo, spelled), false);
    assert.equal(areMmrKeyChordsEqual(undo, spelled, combo("x", ["ctrl"])), true);
    assert.equal(areMmrKeyChordsEqual(undo, spelled, combo("y", ["ctrl"])), false);
    assert.equal(areMmrKeyChordsEqual(parseMmrKeyChord("escape escape"), parseMmrKeyChord("esc esc")), true);
    assert.equal(areMmrKeyChordsEqual(parseMmrKeyChord("ctrl+c"), parseMmrKeyChord("ctrl+c ctrl+c")), false);
  });
});

describe("readMmrKeymapSettings", () => {
  it("returns nothing for missing sections", () => {
    for (const settings of [undefined, null, "x", {}, { ampi: "x" }, { ampi: {} }, { ampiCore: { keymap: { "a.b": "x" } } }]) {
      const result = readMmrKeymapSettings(settings);
      assert.deepEqual({ ...result.overrides }, {}, JSON.stringify(settings));
      assert.deepEqual(result.problems, []);
      assert.equal(result.leader, undefined);
    }
  });

  it("reports a keymap that is not an object", () => {
    const result = readMmrKeymapSettings({ ampi: { keymap: ["ctrl+s"] } });
    assert.deepEqual({ ...result.overrides }, {});
    assert.deepEqual(result.problems, ["Ignoring ampi.keymap: expected an object that maps command ids to key strings."]);
  });

  it("keeps strings, string arrays and null, and skips other values", () => {
    const settings = JSON.parse(`{
      "ampi": { "keymap": {
        "leader": "ctrl+b",
        "mode.toggle": "alt+m",
        "thread.new": ["ctrl+t", "alt+n"],
        "thread.interrupt": null,
        "thread.archive": 5,
        "thread.switch": ["ctrl+w", 3],
        "prompt.undo": { "key": "z" },
        "__proto__": "ctrl+p"
      } }
    }`);
    const result = readMmrKeymapSettings(settings);
    assert.equal(result.leader, "ctrl+b");
    assert.deepEqual(Object.entries(result.overrides), [
      ["mode.toggle", "alt+m"],
      ["thread.new", ["ctrl+t", "alt+n"]],
      ["thread.interrupt", null],
      ["__proto__", "ctrl+p"],
    ]);
    assert.deepEqual(result.problems, [
      "Ignoring ampi.keymap.thread.archive: expected a key string, an array of key strings, or null.",
      "Ignoring ampi.keymap.thread.switch: expected a key string, an array of key strings, or null.",
      "Ignoring ampi.keymap.prompt.undo: expected a key string, an array of key strings, or null.",
    ]);
  });

  it("reports a leader that is not a string", () => {
    const result = readMmrKeymapSettings({ ampi: { keymap: { leader: 7 } } });
    assert.equal(result.leader, undefined);
    assert.deepEqual(result.problems, ["Ignoring ampi.keymap.leader: expected a key string."]);
  });
});

const DEFAULTS = {
  "thread.new": null,
  "thread.archive": "ctrl+c ctrl+n",
  "prompt.undo": "<leader>z",
  "mode.toggle": "ctrl+s",
  "thread.interrupt": "esc esc",
};

function bindingsOf(resolved) {
  return Object.fromEntries([...resolved.bindings].map(([id, chords]) => [id, chords.map((chord) => formatMmrKeyChord(chord))]));
}

describe("resolveMmrKeymap", () => {
  it("uses the defaults and indexes chords with the leader expanded", () => {
    const resolved = resolveMmrKeymap({ defaults: DEFAULTS });
    assert.deepEqual(resolved.leader, combo("x", ["ctrl"]));
    assert.deepEqual(bindingsOf(resolved), {
      "thread.new": [],
      "thread.archive": ["ctrl+c ctrl+n"],
      "prompt.undo": ["<leader>z"],
      "mode.toggle": ["ctrl+s"],
      "thread.interrupt": ["esc esc"],
    });
    assert.deepEqual(
      resolved.byChord,
      new Map([
        ["ctrl+c ctrl+n", "thread.archive"],
        ["ctrl+x z", "prompt.undo"],
        ["ctrl+s", "mode.toggle"],
        ["esc esc", "thread.interrupt"],
      ]),
    );
    assert.deepEqual(resolved.conflicts, []);
    assert.deepEqual(resolved.problems, []);
  });

  it("applies string, array and null overrides", () => {
    const resolved = resolveMmrKeymap({
      defaults: DEFAULTS,
      overrides: {
        "mode.toggle": "alt+m",
        "thread.new": ["ctrl+t", "Alt+N", "alt+n"],
        "thread.interrupt": null,
        "thread.archive": [],
        "prompt.undo": ["<leader>u"],
      },
    });
    assert.deepEqual(bindingsOf(resolved), {
      "thread.new": ["ctrl+t", "alt+n"],
      "thread.archive": [],
      "prompt.undo": ["<leader>u"],
      "mode.toggle": ["alt+m"],
      "thread.interrupt": [],
    });
    assert.deepEqual(
      [...resolved.byChord.keys()],
      ["ctrl+t", "alt+n", "ctrl+x u", "alt+m"],
    );
    assert.deepEqual(resolved.problems, []);
  });

  it("reports unknown ids and unparsable chords without throwing", () => {
    const resolved = resolveMmrKeymap({
      defaults: DEFAULTS,
      overrides: {
        "thread.missing": "ctrl+q",
        "mode.toggle": "hyper+m",
        "thread.new": ["ctrl+t", "nope+x"],
      },
    });
    assert.deepEqual(bindingsOf(resolved)["mode.toggle"], ["ctrl+s"]);
    assert.deepEqual(bindingsOf(resolved)["thread.new"], ["ctrl+t"]);
    assert.deepEqual(resolved.problems, [
      'Ignoring keymap entry "thread.missing": no command has that id.',
      'Ignoring key for mode.toggle: "hyper" is not a modifier (use ctrl, alt, shift, or meta) in "hyper+m".',
      'Ignoring key for thread.new: "nope" is not a modifier (use ctrl, alt, shift, or meta) in "nope+x".',
    ]);
  });

  it("uses a configured leader and falls back on an invalid one", () => {
    const custom = resolveMmrKeymap({ defaults: DEFAULTS, leader: "alt+x" });
    assert.equal(custom.byChord.get("alt+x z"), "prompt.undo");
    assert.equal(custom.byChord.has("ctrl+x z"), false);

    const cases = {
      "ctrl+x ctrl+y": 'Ignoring leader: "ctrl+x ctrl+y" is not a single key combo.',
      "<leader>a": 'Ignoring leader: "<leader>a" is not a single key combo.',
      "hyper+x": 'Ignoring leader: "hyper" is not a modifier (use ctrl, alt, shift, or meta) in "hyper+x".',
    };
    for (const [leader, problem] of Object.entries(cases)) {
      const resolved = resolveMmrKeymap({ defaults: DEFAULTS, leader });
      assert.deepEqual(resolved.leader, combo("x", ["ctrl"]), leader);
      assert.deepEqual(resolved.problems, [problem]);
      assert.equal(resolved.byChord.get("ctrl+x z"), "prompt.undo");
    }
  });

  it("reports duplicate chords, including different spellings of the same keys", () => {
    const resolved = resolveMmrKeymap({
      defaults: DEFAULTS,
      overrides: { "thread.new": ["ctrl+s", "escape escape"] },
    });
    assert.deepEqual(resolved.conflicts, [
      { kind: "duplicate", chord: "ctrl+s", ids: ["thread.new", "mode.toggle"] },
      { kind: "duplicate", chord: "esc esc", ids: ["thread.new", "thread.interrupt"] },
    ]);
    assert.equal(resolved.byChord.get("ctrl+s"), "thread.new");
  });

  it("reports a chord that is a strict prefix of another, after leader expansion", () => {
    const resolved = resolveMmrKeymap({
      defaults: DEFAULTS,
      overrides: { "thread.new": ["ctrl+c", "ctrl+x"], "thread.interrupt": "esc" },
    });
    assert.deepEqual(resolved.conflicts, [
      {
        kind: "prefix",
        chord: "ctrl+c",
        ids: ["thread.new"],
        longerChord: "ctrl+c ctrl+n",
        longerIds: ["thread.archive"],
      },
      { kind: "prefix", chord: "ctrl+x", ids: ["thread.new"], longerChord: "ctrl+x z", longerIds: ["prompt.undo"] },
    ]);
  });
});

describe("formatMmrKeymapJsonc", () => {
  it("lists the leader first, then every command id in sorted order", () => {
    const commands = [
      { id: "thread.new", description: "Start a fresh thread" },
      { id: "mode.toggle", description: "Cycle the agent mode" },
      { id: "thread.archive", description: "Archive this thread\n  and open a new one" },
      { id: "prompt.undo", description: "Undo the last prompt edit" },
      { id: "thread.interrupt", description: "Stop the running turn" },
    ];
    const resolved = resolveMmrKeymap({
      defaults: DEFAULTS,
      overrides: { "thread.new": ["ctrl+t", "Alt+N"], "thread.interrupt": null },
    });
    const expected = [
      "{",
      '  "leader": "ctrl+x",',
      '  "mode.toggle": "ctrl+s", // Cycle the agent mode',
      '  "prompt.undo": "<leader>z", // Undo the last prompt edit',
      '  "thread.archive": "ctrl+c ctrl+n", // Archive this thread and open a new one',
      '  "thread.interrupt": null, // Stop the running turn',
      '  "thread.new": ["ctrl+t", "alt+n"] // Start a fresh thread',
      "}",
    ].join("\n");
    const text = formatMmrKeymapJsonc(commands, resolved);
    assert.equal(text, expected);
    assert.deepEqual(JSON.parse(text.replace(/ \/\/ .*$/gm, "")), {
      leader: "ctrl+x",
      "mode.toggle": "ctrl+s",
      "prompt.undo": "<leader>z",
      "thread.archive": "ctrl+c ctrl+n",
      "thread.interrupt": null,
      "thread.new": ["ctrl+t", "alt+n"],
    });
  });

  it("prints a custom leader and an empty command list", () => {
    const resolved = resolveMmrKeymap({ defaults: {}, leader: "Alt+B" });
    assert.equal(formatMmrKeymapJsonc([], resolved), '{\n  "leader": "alt+b"\n}');
  });
});
