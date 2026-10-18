// The `ampi` theme shipped by ampi-tui: valid against Pi's published theme
// schema, ANSI palette indices only, the Amp-compatible role mapping, and the
// session-only selection that never writes the user's settings.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const themePath = path.join(repoRoot, "src/extensions/ampi-tui/theme/ampi.json");
const theme = JSON.parse(readFileSync(themePath, "utf8"));
// Pi publishes this schema with its package (and at pi.dev/schemas/theme.schema.json).
const schema = JSON.parse(
  readFileSync(path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/schemas/theme.schema.json"), "utf8"),
);

function resolve(value) {
  let current = value;
  for (let depth = 0; typeof current === "string" && current !== "" && depth < 10; depth++) current = theme.vars[current];
  return current;
}

describe("ampi theme file", () => {
  it("satisfies Pi's theme schema: required fields and colours, no unknown keys, valid values", () => {
    for (const key of schema.required) assert.ok(key in theme, `missing ${key}`);
    for (const key of Object.keys(theme)) assert.ok(key in schema.properties, `unknown top-level key ${key}`);
    const colors = schema.properties.colors;
    for (const token of colors.required) assert.ok(token in theme.colors, `missing colour ${token}`);
    for (const token of Object.keys(theme.colors)) assert.ok(token in colors.properties, `unknown colour ${token}`);
    for (const [name, value] of [...Object.entries(theme.vars), ...Object.entries(theme.colors)]) {
      const ok = typeof value === "string" || (Number.isInteger(value) && value >= 0 && value <= 255);
      assert.ok(ok, `${name} has an invalid colour value ${JSON.stringify(value)}`);
      if (typeof value === "string" && value !== "") assert.ok(value in theme.vars, `${name} names unknown variable ${value}`);
    }
  });

  it("uses only ANSI palette indices and terminal defaults, so it follows the terminal's colours", () => {
    for (const [token, value] of Object.entries(theme.colors)) {
      const resolved = resolve(value);
      assert.ok(resolved === "" || Number.isInteger(resolved), `${token} resolves to ${JSON.stringify(resolved)}`);
    }
    assert.ok(!readFileSync(themePath, "utf8").includes("#"), "no hex colours");
  });

  it("maps the transcript roles to the Amp-compatible palette slots", () => {
    const expected = {
      userMessageText: 2,
      userMessageBg: "",
      mdHeading: 6,
      mdCode: 3,
      mdLink: 4,
      mdHr: 8,
      toolDiffAdded: 2,
      toolDiffRemoved: 1,
      toolPendingBg: "",
      toolSuccessBg: "",
      toolErrorBg: "",
    };
    for (const [token, value] of Object.entries(expected)) assert.equal(resolve(theme.colors[token]), value, token);
    assert.equal(resolve(theme.colors.dim), resolve(theme.colors.thinkingText), "thinking text is the secondary grey");
  });

  it("keeps selections, frames and the editor border off slot 8, which some palettes paint as the background", () => {
    for (const token of ["selectedBg", "border", "borderMuted", "thinkingOff", "thinkingMinimal"]) {
      const resolved = resolve(theme.colors[token]);
      assert.ok(Number.isInteger(resolved) && resolved > 15, `${token} resolves to ${JSON.stringify(resolved)}`);
    }
  });

  it("ships through package.json pi.themes under the name ampi", async () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    assert.deepEqual(pkg.pi.themes, ["./src/extensions/ampi-tui/theme/ampi.json"]);
    const { MMR_TUI_THEME_NAME } = await importSource("extensions/ampi-tui/theme/select.ts");
    assert.equal(theme.name, MMR_TUI_THEME_NAME);
  });
});

describe("ampi theme selection", () => {
  async function start(themeName) {
    const { createMmrTuiExtension } = await importSource("extensions/ampi-tui/index.ts");
    const { pi, handlers } = createMockPi();
    createMmrTuiExtension({ loadSettings: () => ({ enabled: true }) })(pi);
    const ampiTheme = { name: "ampi" };
    const mock = createMockExtensionContext({ hasUI: true, themeName, themes: { ampi: ampiTheme } });
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, mock.ctx);
    await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, mock.ctx);
    return { ...mock, ampiTheme };
  }

  it("switches from Pi's default system theme by object, so nothing is written to settings", async () => {
    const { themeChanges, ampiTheme } = await start("system");
    assert.equal(themeChanges.length, 1);
    assert.equal(themeChanges[0], ampiTheme, "a Theme object, never the name");
  });

  it("keeps a theme the user chose", async () => {
    const { themeChanges, widgets } = await start("dark");
    assert.deepEqual(themeChanges, []);
    widgets.get("ampi-tui-theme").content().invalidate();
    assert.deepEqual(themeChanges, [], "a theme change to the user's theme is left alone");
  });

  it("puts the ampi theme back when Pi re-applies its default after the session starts", async () => {
    const { ctx, themeChanges, widgets, ampiTheme } = await start("system");
    const keeper = widgets.get("ampi-tui-theme");
    assert.deepEqual(keeper.options, { placement: "belowEditor" });
    const component = keeper.content();
    assert.deepEqual(component.render(80), [], "the keeper draws no rows");

    // Pi re-applies `system` from settings after /reload, /new, /resume and /fork,
    // and invalidates every component when it does.
    ctx.ui.theme = { name: "system" };
    component.invalidate();
    assert.equal(themeChanges.length, 2);
    assert.equal(ctx.ui.theme, ampiTheme);
    component.invalidate();
    assert.equal(themeChanges.length, 2, "the keeper's own switch does not loop");
  });
});
