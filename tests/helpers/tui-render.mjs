// Render helpers for ampi-tui component tests: a fixed ANSI theme, so render
// fixtures keep their escapes and read in a terminal as they would in Pi, and
// a fixture comparison that PI_MMR_UPDATE_FIXTURES=1 rewrites.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { backgroundAnsi, foregroundAnsi, indexedColor, styleTextWithAnsi } from "@earendil-works/pi-tui";

const FOREGROUND = {
  accent: "\x1b[34m",
  warning: "\x1b[33m",
  success: "\x1b[32m",
  userMessageText: "\x1b[32m",
  dim: "\x1b[2m",
  scrollbarThumb: "\x1b[38;5;243m",
};

/**
 * A theme with the methods ampi-tui components call, mapping each token to a
 * fixed ANSI color in the spirit of the `ampi` theme: `accent` blue,
 * `warning` yellow, `success` and `userMessageText` green, `dim` faint, a
 * gray scrollbar.
 */
export function createAnsiTheme() {
  const tokenAnsi = (token) => {
    const ansi = FOREGROUND[token];
    assert.ok(ansi, `the test theme has no foreground token "${token}"`);
    return ansi;
  };
  return {
    fg: (token, text) => (token === "dim" ? `\x1b[2m${text}\x1b[22m` : `${tokenAnsi(token)}${text}\x1b[39m`),
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    italic: (text) => `\x1b[3m${text}\x1b[23m`,
    style: (text, { fg, bg, ...attributes } = {}) =>
      styleTextWithAnsi(
        text,
        fg === undefined ? undefined : typeof fg === "string" ? tokenAnsi(fg) : foregroundAnsi(fg, "256color"),
        bg === undefined ? undefined : backgroundAnsi(bg, "256color"),
        attributes,
      ),
    colors: { warning: indexedColor(3), scrollbarTrack: indexedColor(236) },
  };
}

/** Pi's fake-cursor markers, resolved the way Pi's TUI draws them. */
function resolveCursor(line) {
  return line.replaceAll("\x1b_pi:c\x07", "").replaceAll("\x1b_pi:fc\x07", "\x1b[7m").replaceAll("\x1b_pi:/fc\x07", "\x1b[27m");
}

/** Remove escapes, leaving the layout. */
export function plain(lines) {
  return lines.map((line) => resolveCursor(line).replace(/\x1b\[[0-9;:]*m/g, ""));
}

/**
 * Compare rendered lines with `tests/fixtures/<dir>/<name>.ansi`. With
 * PI_MMR_UPDATE_FIXTURES=1 the fixture is rewritten instead.
 */
export function expectFixture(dir, name, lines) {
  const file = path.join(import.meta.dirname, "..", "fixtures", dir, `${name}.ansi`);
  const actual = `${lines.map(resolveCursor).join("\n")}\n`;
  if (process.env.PI_MMR_UPDATE_FIXTURES === "1" || !existsSync(file)) {
    if (process.env.PI_MMR_UPDATE_FIXTURES !== "1") assert.fail(`missing fixture ${file}; run with PI_MMR_UPDATE_FIXTURES=1`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(actual, readFileSync(file, "utf8"), `fixture ${dir}/${name}.ansi drift; rerun with PI_MMR_UPDATE_FIXTURES=1 to refresh`);
}
