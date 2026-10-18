import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";
import { createAnsiTheme, expectFixture, plain } from "./helpers/tui-render.mjs";

after(cleanupLoadedSource);

let sources;
let info;
let help;
let changelog;
let createMmrTuiCommands;
let createMmrTuiKeys;
let registry;
const theme = createAnsiTheme();

before(async () => {
  sources = await importSource("extensions/ampi-core/skill-sources.ts");
  info = await importSource("extensions/ampi-tui/overlays/info.ts");
  help = await importSource("extensions/ampi-tui/overlays/help-keymap.ts");
  changelog = await importSource("extensions/ampi-core/changelog.ts");
  ({ createMmrTuiCommands } = await importSource("extensions/ampi-tui/keys/commands.ts"));
  ({ createMmrTuiKeys } = await importSource("extensions/ampi-tui/keys/install.ts"));
  registry = await importSource("extensions/ampi-core/command-registry.ts");
});

const HOME = "/home/user";
const AMPI = `${HOME}/projects/ampi`;
const info_ = (path, source, scope, origin = "top-level") => ({ path, source, scope, origin });

/** One skill from each place Pi finds them, with the sourceInfo Pi gives each. */
const SKILL_SOURCES = {
  user: info_(`${HOME}/.pi/agent/skills/pdf-tools/SKILL.md`, "auto", "user"),
  userAgents: info_(`${HOME}/.agents/skills/review/SKILL.md`, "auto", "user"),
  project: info_(`${AMPI}/.pi/skills/release-notes/SKILL.md`, "auto", "project"),
  projectAgents: info_(`${AMPI}/.agents/skills/triage/SKILL.md`, "auto", "project"),
  package: info_(`${HOME}/.pi/agent/npm/node_modules/pi-skills/skills/brave-search/SKILL.md`, "npm:pi-skills", "user", "package"),
  settings: info_(`${HOME}/shared-skills/deploy/SKILL.md`, "local", "user"),
  temporary: info_(`/tmp/try/SKILL.md`, "cli", "temporary"),
  // Folders ampi-core adds through resources_discover: Pi marks them temporary.
  userClaude: info_(`${HOME}/.claude/skills/commit/SKILL.md`, "extension:index", "temporary"),
  projectClaude: info_(`${AMPI}/.claude/skills/lint/SKILL.md`, "extension:index", "temporary"),
  ampiPath: info_(`${HOME}/my-skills/notes/SKILL.md`, "extension:index", "temporary"),
};

/** The overlay as Pi draws it: `width` columns wide, or the terminal width less four. */
function render(title, content, columns, rows, width) {
  const view = new help.MmrScrollOverlay({ title, content, theme, onClose() {}, terminalRows: () => rows, fit: true });
  return view.render(Math.min(width, columns - 4));
}

describe("skill source classification", () => {
  it("puts each place Pi finds skills into its own group and marks the .agents directories", () => {
    const classified = Object.fromEntries(
      Object.entries(SKILL_SOURCES).map(([key, source]) => [key, sources.classifyMmrSkillSource(source, source.path, HOME)]),
    );
    assert.deepEqual(classified, {
      user: { group: "user", origin: "pi" },
      userAgents: { group: "user", origin: "agents" },
      project: { group: "project", origin: "pi" },
      projectAgents: { group: "project", origin: "agents" },
      package: { group: "package", origin: "pi", packageName: "npm:pi-skills" },
      settings: { group: "settings", origin: "pi" },
      temporary: { group: "temporary", origin: "pi" },
      userClaude: { group: "user", origin: "claude" },
      projectClaude: { group: "project", origin: "claude" },
      ampiPath: { group: "settings", origin: "pi" },
    });
    // A package passed with -e is loaded for this run only: temporary wins over package.
    assert.deepEqual(sources.classifyMmrSkillSource(info_("/x/skills/a/SKILL.md", "npm:pi-skills", "temporary", "package")), {
      group: "temporary",
      origin: "pi",
    });
    // The file path, when given, decides the origin.
    assert.equal(sources.classifyMmrSkillSource(SKILL_SOURCES.user, `${HOME}/.agents/skills/x/SKILL.md`).origin, "agents");
    assert.deepEqual(sources.MMR_SKILL_GROUPS, ["user", "project", "package", "settings", "temporary"]);
  });
});

const skillCommand = (name, description, sourceInfo) => ({ name: `skill:${name}`, description, source: "skill", sourceInfo });
const eventSkill = (name, description, sourceInfo, extra = {}) => ({ name, description, filePath: sourceInfo.path, sourceInfo, ...extra });

describe("Skills dialog", () => {
  it("lists the union of skill commands and the last turn's skills, the command's description winning", () => {
    const sections = info.buildMmrSkillSections(
      [
        skillCommand("pdf-tools", "Extract text and tables from PDF files", SKILL_SOURCES.user),
        skillCommand("release-notes", "From the command", SKILL_SOURCES.project),
        { name: "ampi-status", description: "not a skill", source: "extension", sourceInfo: SKILL_SOURCES.user },
      ],
      [
        eventSkill("release-notes", "From the event", SKILL_SOURCES.project, { disableModelInvocation: true }),
        eventSkill("triage", "Only the event knows this one", SKILL_SOURCES.projectAgents),
      ],
    );
    assert.deepEqual(
      sections.map((section) => [section.title, section.rows.map((row) => [row.name, row.description, row.commandOnly, row.origin])]),
      [
        ["User", [["pdf-tools", "Extract text and tables from PDF files", false, "pi"]]],
        [
          "Project",
          [
            ["release-notes", "From the command", true, "pi"],
            ["triage", "Only the event knows this one", false, "agents"],
          ],
        ],
      ],
    );
  });

  it("groups package skills with their source, tags command-only and .agents skills, and says where Pi looks", () => {
    const sections = info.buildMmrSkillSections(
      [
        skillCommand("pdf-tools", "Extract text and tables from PDF files. Use when reading, converting or inspecting PDFs.", SKILL_SOURCES.user),
        skillCommand("review", "Review a diff for correctness, regressions and missing tests before it lands.", SKILL_SOURCES.userAgents),
        skillCommand("release-notes", "Draft release notes from the pull requests merged since the last tag.", SKILL_SOURCES.project),
        skillCommand("lint", "Run the linters the repository uses.", SKILL_SOURCES.projectClaude),
        skillCommand("brave-search", "Search the web and read pages without a browser.", SKILL_SOURCES.package),
        skillCommand("deploy", "Deploy the site after the gate passed.", SKILL_SOURCES.settings),
        skillCommand("scratch", "A skill tried out for one run.", SKILL_SOURCES.temporary),
      ],
      [eventSkill("deploy", "Deploy the site after the gate passed.", SKILL_SOURCES.settings, { disableModelInvocation: true })],
    );
    const count = sections.reduce((sum, section) => sum + section.rows.length, 0);
    const lines = (width, frameTheme) => info.renderMmrSkillLines(sections, width, frameTheme);
    expectFixture("ampi-tui-info-dialogs", "skills-140", render(info.mmrSkillsTitle(count), lines, 140, 44, info.MMR_SKILLS_WIDTH));
    const at80 = plain(render(info.mmrSkillsTitle(count), lines, 80, 44, info.MMR_SKILLS_WIDTH));
    expectFixture("ampi-tui-info-dialogs", "skills-80", render(info.mmrSkillsTitle(count), lines, 80, 44, info.MMR_SKILLS_WIDTH));
    assert.match(at80[0], /^╭─ Skills \(7\) ─+╮$/);
    assert.deepEqual(
      at80.filter((line) => /^│ \S/.test(line)).map((line) => line.slice(2, -1).trim()).slice(0, 5),
      ["User", "Project", "Packages", "Settings", "Temporary"],
    );
    // The name column is as wide as the widest name with its tags; descriptions start after it.
    assert.match(at80[3], /^│ {3}pdf-tools {19}Extract text and tables from PDF files\. U… │$/);
    assert.match(at80[4], /^│ {3}review agents {15}Review/);
    assert.match(at80[7], /^│ {3}lint claude {17}Run the linters/);
    assert.match(at80[11], /^│ {3}brave-search npm:pi-skills {2}Search/);
    assert.match(at80[14], /^│ {3}deploy command only {9}Deploy/);
    assert.match(at80.slice(-6, -1).join(" "), /Run \/reload to pick up a skill +│ │ you added\./);
    assert.match(at80.at(-1), /^╰─+ Esc close ─╯$/);
  });

  it("caps the name column at 32 columns and says so when Pi loaded no skills", () => {
    const long = "a-skill-with-a-name-far-longer-than-the-column-allows";
    const lines = plain(info.renderMmrSkillLines(info.buildMmrSkillSections([skillCommand(long, "Its description", SKILL_SOURCES.user)]), 72, theme));
    assert.equal(lines[1], `  ${long.slice(0, 31)}…  Its description`);

    const empty = plain(render(info.mmrSkillsTitle(0), (width, frameTheme) => info.renderMmrSkillLines([], width, frameTheme), 80, 24, info.MMR_SKILLS_WIDTH));
    expectFixture("ampi-tui-info-dialogs", "skills-empty-80", render(info.mmrSkillsTitle(0), (width, frameTheme) => info.renderMmrSkillLines([], width, frameTheme), 80, 24, info.MMR_SKILLS_WIDTH));
    assert.match(empty[0], /^╭─ Skills \(0\) ─+╮$/);
    assert.match(empty[2], /^│ Pi has loaded no skills\. +│$/);
    assert.match(empty[4], /^│ Pi looks for skills/);
  });
});

const ampiPath = (name) => `${AMPI}/src/extensions/${name}/index.ts`;
const extensionCommand = (name, path, origin = "top-level", source = "local") => ({
  name,
  description: "",
  source: "extension",
  sourceInfo: info_(path, source, "user", origin),
});
const tool = (name, path, origin = "top-level", source = "local") => ({ name, sourceInfo: info_(path, source, "user", origin) });

describe("Extensions dialog", () => {
  it("groups commands and tools by the file that registered them, Pi's built-ins last, with the counts", () => {
    const list = info.buildMmrExtensionList(
      [
        extensionCommand("ampi-status", ampiPath("ampi-core")),
        extensionCommand("mmr-status", ampiPath("ampi-core")),
        extensionCommand("mmr-other", "/ignored", "top-level"),
        extensionCommand("skill:pdf-tools", "/ignored", "top-level"),
        extensionCommand("mcp", "builtin:mcp", "top-level", "builtin"),
        extensionCommand("todo", `${HOME}/.pi/agent/extensions/todo/index.ts`),
        { name: "skill:pdf-tools", source: "skill", sourceInfo: SKILL_SOURCES.user },
        { name: "review", source: "prompt", sourceInfo: SKILL_SOURCES.user },
      ],
      [tool("read", "builtin:read", "top-level", "builtin"), tool("web_search", `${HOME}/x/node_modules/pi-web/index.ts`, "package", "npm:pi-web")],
    );
    assert.deepEqual(
      list.groups.map((group) => [group.label, group.commands, group.tools]),
      [
        ["ampi-core", ["/ampi-status"], []],
        ["ignored", ["/mmr-other", "/skill:pdf-tools"], []],
        ["todo/index.ts", ["/todo"], []],
        ["npm:pi-web", [], ["web_search"]],
        ["Pi built-in", ["/mcp"], ["read"]],
      ],
    );
    assert.equal(list.commandCount, 5, "ampi's legacy /mmr-* aliases are left out, other extensions' commands are not");
    assert.equal(list.toolCount, 2);
  });

  it("draws ampi's own extensions with their commands and tools at 140 and 80 columns", () => {
    const list = info.buildMmrExtensionList(
      [
        extensionCommand("ampi-status", ampiPath("ampi-core")),
        extensionCommand("ampi-changelog", ampiPath("ampi-core")),
        extensionCommand("ampi-config", ampiPath("ampi-core")),
        extensionCommand("mode", ampiPath("ampi-core")),
        extensionCommand("ampi-thread", ampiPath("ampi-threads")),
        extensionCommand("ampi-edit-message", ampiPath("ampi-tui")),
      ],
      [
        tool("read", "builtin:read", "top-level", "builtin"),
        tool("bash", "builtin:bash", "top-level", "builtin"),
        tool("apply_patch", ampiPath("ampi-patch")),
        tool("web_search", ampiPath("ampi-web")),
        tool("read_web_page", ampiPath("ampi-web")),
        tool("oracle", ampiPath("ampi-workers")),
        tool("finder", ampiPath("ampi-workers")),
        tool("Task", ampiPath("ampi-workers")),
      ],
    );
    const lines = (width, frameTheme) => info.renderMmrExtensionLines(list, width, frameTheme, HOME);
    expectFixture("ampi-tui-info-dialogs", "extensions-140", render(info.MMR_EXTENSIONS_TITLE, lines, 140, 44, info.MMR_EXTENSIONS_WIDTH));
    expectFixture("ampi-tui-info-dialogs", "extensions-80", render(info.MMR_EXTENSIONS_TITLE, lines, 80, 24, info.MMR_EXTENSIONS_WIDTH));
    const text = plain(render(info.MMR_EXTENSIONS_TITLE, lines, 80, 44, info.MMR_EXTENSIONS_WIDTH));
    assert.match(text[0], /^╭─ Extensions ─+╮$/);
    assert.match(text[2], /^│ 7 extensions \(6 commands, 8 tools\) +│$/);
    assert.match(text[4], /^│ ampi-core {2}~\/projects\/ampi\/src\/extensions\/ampi-core\/index\.ts +│$/);
    assert.match(text[5], /^│ {3}Commands: \/ampi-status, \/ampi-changelog, \/ampi-config, \/mode +│$/);
    assert.ok(text.some((line) => /^│ {3}Tools: oracle, finder, Task +│$/.test(line)));
    assert.match(text.at(-3), /^│ Pi built-in +│$/);
    assert.match(text.at(-2), /^│ {3}Tools: read, bash +│$/);
    const short = plain(render(info.MMR_EXTENSIONS_TITLE, lines, 80, 24, info.MMR_EXTENSIONS_WIDTH));
    assert.match(short.at(-1), / Esc close · ↑↓\/j\/k scroll ─╯$/, "scrolls on a short screen");
  });

  it("writes singular counts and wraps a long command list under its first name", () => {
    const names = Array.from({ length: 12 }, (_, index) => `command-number-${index}`);
    const list = info.buildMmrExtensionList(names.map((name) => extensionCommand(name, "/opt/one.ts")), [tool("only", "/opt/one.ts")]);
    const lines = plain(info.renderMmrExtensionLines(list, 60, theme, HOME));
    assert.equal(lines[0], "1 extension (12 commands, 1 tool)");
    assert.equal(lines[2], "one.ts  /opt/one.ts");
    assert.match(lines[3], /^ {2}Commands: \/command-number-0, \/command-number-1,/);
    assert.match(lines[4], /^ {12}\/command-number-/);
    assert.ok(lines.every((line) => line.length <= 60));
    assert.equal(info.tildeMmrPath(`${HOME}/a`, HOME), "~/a");
    assert.equal(info.tildeMmrPath(`${HOME}er/a`, HOME), `${HOME}er/a`);
  });
});

describe("Version dialog", () => {
  it("reads the release date from both changelog heading forms, and none when the heading has no date", () => {
    const markdown = [
      "# Changelog",
      "## [0.4.0](https://github.com/example/ampi/compare/v0.3.1...v0.4.0) (2026-10-20)",
      "### Features",
      "## 0.3.1 — 2026-07-15",
      "## [0.3.0] - 2026-07-14",
      "## 0.2.0",
    ].join("\n");
    assert.equal(changelog.findMmrChangelogReleaseDate(markdown, "0.4.0"), "2026-10-20");
    assert.equal(changelog.findMmrChangelogReleaseDate(markdown, "0.3.1"), "2026-07-15");
    assert.equal(changelog.findMmrChangelogReleaseDate(markdown, "0.3.0"), "2026-07-14");
    assert.equal(changelog.findMmrChangelogReleaseDate(markdown, "0.2.0"), undefined);
    assert.equal(changelog.findMmrChangelogReleaseDate(markdown, "0.1.0"), undefined);
  });

  it("shows ampi with its release date, Pi, Node and the package root at 140 and 80 columns", () => {
    const version = { ampi: "0.3.1", released: "2026-07-15", pi: "1.3.0", node: "v24.11.1", root: `${HOME}/.pi/agent/npm/node_modules/@skippermissions/ampi` };
    const lines = (width, frameTheme) => info.renderMmrVersionLines(version, width, frameTheme, HOME);
    expectFixture("ampi-tui-info-dialogs", "version-140", render(info.MMR_VERSION_TITLE, lines, 140, 44, info.MMR_VERSION_WIDTH));
    expectFixture("ampi-tui-info-dialogs", "version-80", render(info.MMR_VERSION_TITLE, lines, 80, 24, info.MMR_VERSION_WIDTH));
    const text = plain(render(info.MMR_VERSION_TITLE, lines, 80, 24, info.MMR_VERSION_WIDTH));
    assert.deepEqual(
      text.slice(2, -1).map((line) => line.slice(2, -1).trimEnd()),
      ["ampi 0.3.1, released 2026-07-15", "Pi 1.3.0", "Node v24.11.1", "", "~/.pi/agent/npm/node_modules/@skippermissions/ampi"],
    );
    assert.match(text.at(-1), /^╰─+ Esc close ─╯$/);
    const unknown = plain(info.renderMmrVersionLines({ pi: "1.3.0", node: "v24.0.0" }, 60, theme, HOME));
    assert.deepEqual(unknown, ["ampi (unknown version)", "Pi 1.3.0", "Node v24.0.0"]);
  });

  it("reads ampi's own version and changelog date", () => {
    const read = info.readMmrVersionInfo();
    assert.match(read.ampi, /^\d+\.\d+\.\d+/);
    assert.equal(read.node, process.version);
    assert.match(read.pi, /^\d+\.\d+\.\d+/);
  });
});

/** A TUI handle whose focused component is Pi's editor, recording what Enter submits. */
function fakeTui() {
  const submitted = [];
  const editor = { actionHandlers: new Map(), onSubmit: (text) => submitted.push(text) };
  return { tui: { getFocusedComponent: () => editor, requestRender() {} }, submitted };
}

describe("info dialog commands", () => {
  const opened = [];
  let tui = fakeTui();
  const host = {
    getTui: () => tui.tui,
    pi: { getCommands: () => [], getSettings: () => ({}), sendUserMessage() {} },
    openSkills: () => opened.push("skills"),
    openExtensions: () => opened.push("extensions"),
    openVersion: () => opened.push("version"),
  };
  const find = (id) => createMmrTuiCommands(host).find((command) => command.id === id);

  it("open the dialogs only in the terminal UI, under the extensions and skills categories", () => {
    const { ctx } = createMockExtensionContext({ hasUI: true });
    const print = createMockExtensionContext({ hasUI: false }).ctx;
    for (const id of ["skills.list", "plugins.list", "plugins.reload"]) {
      assert.deepEqual(find(id).availability(print), { state: "unavailable", reason: "only in Pi's terminal UI" });
      assert.deepEqual(find(id).availability(ctx), { state: "available" });
    }
    assert.deepEqual(
      ["skills.list", "plugins.list", "plugins.reload"].map((id) => `${find(id).noun} ${find(id).verb}`),
      ["skills list", "extensions list", "extensions reload"],
    );
    find("skills.list").run(ctx);
    find("plugins.list").run(ctx);
    find("ampi.showVersion").run(ctx);
    assert.deepEqual(opened, ["skills", "extensions", "version"]);
  });

  it("reload submits /reload through the prompt, and is unavailable with text in it or without focus", () => {
    const typed = createMockExtensionContext({ hasUI: true, editorText: "half a prompt" }).ctx;
    assert.deepEqual(find("plugins.reload").availability(typed), { state: "unavailable", reason: "the prompt has text" });
    const { ctx } = createMockExtensionContext({ hasUI: true });
    find("plugins.reload").run(ctx);
    assert.deepEqual(tui.submitted, ["/reload"]);
    tui = { tui: { getFocusedComponent: () => ({ value: "a selector" }) }, submitted: [] };
    assert.deepEqual(find("plugins.reload").availability(ctx), { state: "unavailable", reason: "the prompt is not focused" });
    assert.throws(() => find("plugins.reload").run(ctx), /the prompt is not focused/);
  });

  it("show version keeps the notification outside the terminal UI", () => {
    const before = opened.length;
    const { ctx, notifications } = createMockExtensionContext({ hasUI: false });
    find("ampi.showVersion").run(ctx);
    assert.equal(opened.length, before);
    assert.match(notifications.at(-1).message, /^ampi \d+\.\d+\.\d+\S* on Pi \d+\.\d+\.\d+/);
  });
});

describe("info dialogs in a session", () => {
  beforeEach(() => registry.__resetMmrCommandsForTests());
  afterEach(() => registry.__resetMmrCommandsForTests());

  it("list the skills of the last turn and Pi's commands and tools, in boxes that dim the prompt", async () => {
    const mock = createMockPi({ allTools: [{ name: "read", sourceInfo: info_("builtin:read", "builtin", "user") }] });
    mock.pi.events = { emit() {}, on: () => () => {} };
    mock.pi.getCommands = () => [
      skillCommand("pdf-tools", "Extract text from PDFs", SKILL_SOURCES.user),
      extensionCommand("ampi-status", ampiPath("ampi-core")),
    ];
    const dims = [];
    const context = createMockExtensionContext({ hasUI: true });
    const keys = createMmrTuiKeys(mock.pi, { onPaletteOpen: (open) => dims.push(open) });
    keys.start(context.ctx, () => undefined);
    await mock.handlers.get("before_agent_start")({
      type: "before_agent_start",
      systemPromptOptions: { skills: [eventSkill("triage", "Sort new issues", SKILL_SOURCES.projectAgents)] },
    });

    registry.getMmrCommand("skills.list").run(context.ctx);
    const skills = plain(context.overlays.at(-1).component.render(76));
    assert.match(skills[0], /^╭─ Skills \(2\) ─+╮$/);
    assert.ok(skills.some((line) => /triage agents +Sort new issues/.test(line)));
    assert.deepEqual(dims, [true]);
    context.overlays.at(-1).component.handleInput("\x1b");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(dims, [true, false]);

    registry.getMmrCommand("plugins.list").run(context.ctx);
    const extensions = plain(context.overlays.at(-1).component.render(76));
    assert.match(extensions[2], /^│ 2 extensions \(1 command, 1 tool\) +│$/);

    registry.getMmrCommand("ampi.showVersion").run(context.ctx);
    const version = plain(context.overlays.at(-1).component.render(76));
    assert.match(version[0], /^╭─ Version ─+╮$/);
    assert.match(version[2], /^│ ampi \d+\.\d+\.\d+/);
    keys.stop();
  });
});
