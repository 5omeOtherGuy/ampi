// ampi-permissions guarded files: which paths are guarded and why, the patch
// path reader, and the gate's guarded file dialog, allowlist, refusals and
// how it combines with rules.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { loadPermissionModules, removeTempDirs, setEnv, setupPermissions, tempDir } from "./helpers/permissions-gate.mjs";

after(cleanupLoadedSource);
after(removeTempDirs);

let modules;
let guarded;
let activity;
let patchParser;
before(async () => {
  modules = await loadPermissionModules();
  guarded = await importSource("extensions/ampi-core/guarded-files.ts");
  activity = await importSource("extensions/ampi-core/tool-activity.ts");
  patchParser = await importSource("extensions/ampi-patch/apply-patch.ts");
});
afterEach(() => {
  modules.rules.setMmrPermissionsSessionAllowAll(false);
  modules.rules.setMmrPermissionsProjectTrusted(false);
  modules.runtime.setMmrSubagentState(undefined);
});

/** A realpath for paths that never exist: every form is the lexical one. */
function nothingExists() {
  throw Object.assign(new Error("no such file"), { code: "ENOENT" });
}

/**
 * A realpath over a made-up tree: `dirs` exist, `links` map a directory to
 * its target, and anything else does not exist.
 */
function fakeRealpath(dirs, links) {
  const existing = new Set(dirs);
  return (target) => {
    let out = "";
    for (const name of target.split("/").filter(Boolean)) {
      out = `${out}/${name}`;
      if (links[out]) out = links[out];
      if (!existing.has(out)) nothingExists();
    }
    return out || "/";
  };
}

const LINUX = {
  platform: "linux",
  homeDir: "/home/u",
  tempDir: "/tmp",
  cwd: "/home/u/projects/app",
  agentDir: "/data/agent",
  env: {},
  realpath: nothingExists,
  readlink: nothingExists,
};

const MACOS = {
  platform: "darwin",
  homeDir: "/Users/u",
  tempDir: "/var/folders/xx/T",
  cwd: "/Users/u/app",
  agentDir: "/Users/u/.pi/agent",
  env: {},
  realpath: fakeRealpath(
    ["/private", "/private/var", "/private/var/folders", "/private/var/folders/xx", "/private/var/folders/xx/T", "/private/var/db", "/private/etc", "/Users", "/Users/u"],
    { "/var": "/private/var", "/etc": "/private/etc" },
  ),
  readlink: nothingExists,
};

const WINDOWS = {
  platform: "win32",
  homeDir: "C:\\Users\\u",
  tempDir: "C:\\Users\\u\\AppData\\Local\\Temp",
  cwd: "C:\\work\\app",
  agentDir: "C:\\Users\\u\\.pi\\agent",
  env: { SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\u\\AppData\\Roaming", localappdata: "D:\\Local" },
  realpath: nothingExists,
  readlink: nothingExists,
};

/** [path as the tool gets it, path style, environment, expected category key or null]. */
const TABLE = [
  // Environment files.
  [".env", "plain", LINUX, "env-file"],
  [".env.local", "plain", LINUX, "env-file"],
  ["config/.env.production", "plain", LINUX, "env-file"],
  [".env.example", "plain", LINUX, null],
  [".env.sample", "plain", LINUX, null],
  [".envrc", "plain", LINUX, null],
  // SSH and GnuPG.
  ["/home/u/.ssh", "plain", LINUX, "ssh"],
  ["/home/u/.ssh/config", "plain", LINUX, "ssh"],
  ["/home/u/.ssh/.env", "plain", LINUX, "ssh"],
  ["/home/u/.gnupg/pubring.kbx", "plain", LINUX, "gnupg"],
  // Credentials.
  ["/home/u/.aws/credentials", "plain", LINUX, "cloud-credentials"],
  ["/home/u/.kube/config", "plain", LINUX, "cloud-credentials"],
  ["/home/u/.docker/config.json", "plain", LINUX, "cloud-credentials"],
  ["/home/u/.netrc", "plain", LINUX, "cloud-credentials"],
  // Git internals.
  [".git/hooks/pre-commit", "plain", LINUX, "git"],
  ["vendor/lib/.git", "plain", LINUX, "git"],
  ["scripts/git", "plain", LINUX, null],
  [".gitignore", "plain", LINUX, null],
  // Agent configuration.
  [".pi/settings.json", "plain", LINUX, "agent-config"],
  ["/srv/other/.pi/extensions/x.ts", "plain", LINUX, "agent-config"],
  ["/data/agent/settings.json", "plain", LINUX, "agent-config"],
  ["/data/agent", "plain", LINUX, "agent-config"],
  ["/home/u/.claude/settings.json", "plain", LINUX, "agent-config"],
  ["/home/u/.codex/config.toml", "plain", LINUX, "agent-config"],
  // Databases.
  ["data.sqlite", "plain", LINUX, "database"],
  ["data.sqlite3", "plain", LINUX, "database"],
  ["cache.db", "plain", LINUX, "database"],
  ["data.sql", "plain", LINUX, null],
  // Home configuration.
  ["/home/u/.bashrc", "plain", LINUX, "home-config"],
  ["/home/u/.npmrc", "plain", LINUX, "home-config"],
  ["/home/u/.config/fish/config.fish", "plain", LINUX, "home-config"],
  ["/home/u/projects/app/.eslintrc", "plain", LINUX, null],
  ["/home/u/notes.txt", "plain", LINUX, null],
  ["/home/u/Library/x", "plain", LINUX, null],
  // System directories.
  ["/etc/hosts", "plain", LINUX, "system"],
  ["/usr/local/bin/tool", "plain", LINUX, "system"],
  ["/opt/app/config.yml", "plain", LINUX, "system"],
  ["/etcetera/notes.txt", "plain", LINUX, null],
  ["src/index.ts", "plain", LINUX, null],
  // macOS: /private forms, the temp directory, case.
  ["/private/etc/hosts", "plain", MACOS, "system"],
  ["/var/db/x", "plain", MACOS, "system"],
  ["/var/folders/xx/T/out.txt", "plain", MACOS, null],
  ["/private/var/folders/xx/T/out.txt", "plain", MACOS, null],
  ["/var/folders/xx/T/.env", "plain", MACOS, "env-file"],
  ["/var/folders/yy/other.txt", "plain", MACOS, "system"],
  ["/ETC/hosts", "plain", MACOS, "system"],
  ["/Users/U/.SSH/config", "plain", MACOS, "ssh"],
  ["/Users/u/Library/Preferences/x.plist", "plain", MACOS, "home-config"],
  ["/Applications/App.app/Contents/Info.plist", "plain", MACOS, "system"],
  ["/Users/u/app/README.md", "plain", MACOS, null],
  // Case folds through upper case, as the filesystems compare names.
  ["/Users/u/.\u017Fsh/config", "plain", MACOS, "ssh"],
  ["/Users/u/.\u212Aube/config", "plain", MACOS, "cloud-credentials"],
  ["/home/u/.\u017Fsh/config", "plain", LINUX, null],
  // A project inside a system directory.
  ["/var/www/site/index.html", "plain", { ...LINUX, cwd: "/var/www/site" }, null],
  ["/var/www/site/.env", "plain", { ...LINUX, cwd: "/var/www/site" }, "env-file"],
  ["/var/www/site/.git/config", "plain", { ...LINUX, cwd: "/var/www/site" }, "git"],
  ["/var/log/x", "plain", { ...LINUX, cwd: "/var/www/site" }, "system"],
  ["/etc/hosts", "plain", { ...LINUX, cwd: "/" }, "system"],
  ["/var/log/x", "plain", { ...LINUX, cwd: "/var" }, "system"],
  ["/var/tmp/out.txt", "plain", { ...LINUX, tempDir: "/var/tmp" }, null],
  ["/var/tmp/.env", "plain", { ...LINUX, tempDir: "/var/tmp" }, "env-file"],
  ["/etc/hosts", "plain", { ...LINUX, tempDir: "/etc" }, "system"],
  // Windows.
  ["C:\\Windows\\System32\\drivers\\etc\\hosts", "plain", WINDOWS, "system"],
  ["c:\\windows\\x", "plain", WINDOWS, "system"],
  ["C:\\Program Files\\App\\app.dll", "plain", WINDOWS, "system"],
  ["C:\\Program Files (x86)\\App\\app.dll", "plain", WINDOWS, "system"],
  ["C:\\Users\\u\\AppData\\Roaming\\Code\\settings.json", "plain", WINDOWS, "system"],
  ["D:\\Local\\Thing\\x", "plain", WINDOWS, "system"],
  ["C:\\Users\\u\\AppData\\Local\\Temp\\out.txt", "plain", WINDOWS, null],
  ["C:\\Users\\u\\.ssh\\config", "plain", WINDOWS, "ssh"],
  ["C:\\Users\\u\\.gitconfig", "plain", WINDOWS, "home-config"],
  [".ENV", "plain", WINDOWS, "env-file"],
  [".git.\\config", "plain", WINDOWS, "git"],
  ["src\\main.ts", "plain", WINDOWS, null],
  ["/c/Windows/x", "pi", WINDOWS, "system"],
  ["C:\\Users\\u\\.\u017Fsh\\config", "plain", WINDOWS, "ssh"],
  // Device prefixes name the same files.
  ["\\\\?\\C:\\Windows\\System32\\x", "plain", WINDOWS, "system"],
  ["//?/c:/windows/x", "plain", WINDOWS, "system"],
  ["\\\\.\\C:\\Users\\u\\.ssh\\config", "plain", WINDOWS, "ssh"],
  ["\\\\?\\UNC\\srv\\home\\u\\.ssh\\config", "plain", { ...WINDOWS, homeDir: "\\\\srv\\home\\u" }, "ssh"],
  ["C:\\Windows\\x", "plain", { ...WINDOWS, env: {} }, "system"],
  ["E:\\Windows\\x", "plain", { ...WINDOWS, env: { windir: "E:\\Windows" } }, "system"],
  // Pi's own path rules for edit and write.
  ["@.env", "pi", LINUX, "env-file"],
  ["@.env", "plain", LINUX, null],
  ["~/.ssh/config", "pi", LINUX, "ssh"],
  ["~/.ssh/config", "plain", LINUX, null],
  ["file:///home/u/.netrc", "pi", LINUX, "cloud-credentials"],
  ["\u00A0.env", "pi", LINUX, null],
];

describe("ampi-permissions guarded files: classification", () => {
  for (const [raw, style, env, expected] of TABLE) {
    it(`${env.platform} ${style} ${JSON.stringify(raw)}${env.cwd !== LINUX.cwd && env.platform === "linux" ? ` (cwd ${env.cwd})` : ""} → ${expected ?? "not guarded"}`, () => {
      const file = guarded.classifyMmrGuardedFile(raw, style, env);
      assert.equal(file?.category.key ?? null, expected);
    });
  }

  it("compares allowlist entries with the same case folding and without device prefixes", () => {
    const write = (filePath) => ["write", { path: filePath }];
    assert.deepEqual(guarded.findMmrGuardedFiles(...write("/Users/u/.ssh/config"), [{ path: "/Users/u/.\u017FSH/CONFIG" }], MACOS), []);
    assert.deepEqual(guarded.findMmrGuardedFiles(...write("C:\\Users\\u\\.ssh\\config"), [{ path: "\\\\?\\C:\\Users\\u\\.ssh\\config" }], WINDOWS), []);
    assert.deepEqual(guarded.findMmrGuardedFiles(...write("C:\\Users\\u\\.ssh\\config"), ["//./c:/users/u/.ssh/**"], WINDOWS), []);
    assert.equal(guarded.findMmrGuardedFiles(...write("C:\\Users\\u\\.ssh\\config"), ["//./c:/users/u/.git/**"], WINDOWS).length, 1);
  });

  it("resolves edit and write paths as Pi does, and patch and painter paths plainly", () => {
    assert.equal(guarded.resolveMmrToolPath("@.env", "pi", LINUX), "/home/u/projects/app/.env");
    assert.equal(guarded.resolveMmrToolPath("@.env", "plain", LINUX), "/home/u/projects/app/@.env");
    assert.equal(guarded.resolveMmrToolPath("~", "pi", LINUX), "/home/u");
    assert.equal(guarded.resolveMmrToolPath("~/.ssh/config", "pi", LINUX), "/home/u/.ssh/config");
    assert.equal(guarded.resolveMmrToolPath("a\u2003b.txt", "pi", LINUX), "/home/u/projects/app/a b.txt");
    assert.equal(guarded.resolveMmrToolPath("../lib/x.ts", "plain", LINUX), "/home/u/projects/lib/x.ts");
    assert.equal(guarded.resolveMmrToolPath("/c/Users/u/x.txt", "pi", WINDOWS), "C:\\Users\\u\\x.txt");
    assert.equal(guarded.resolveMmrToolPath("~\\.ssh\\config", "pi", WINDOWS), "C:\\Users\\u\\.ssh\\config");
  });

  it("catches a write through a symbolic link into the home directory's .ssh", () => {
    const root = tempDir("ampi-guarded-");
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    mkdirSync(path.join(home, ".ssh"), { recursive: true });
    mkdirSync(project);
    symlinkSync(path.join(home, ".ssh"), path.join(project, "keys"));
    const env = { platform: "linux", homeDir: home, cwd: project, tempDir: path.join(root, "tmp"), agentDir: path.join(root, "agent"), env: {} };
    const file = guarded.classifyMmrGuardedFile("keys/config", "pi", env);
    assert.equal(file?.category.key, "ssh");
    assert.equal(file.path, path.join(project, "keys", "config"));
    assert.equal(file.realPath, path.join(realpathSync(home), ".ssh", "config"));
    assert.deepEqual(file.guardedForms, [file.realPath]);
    assert.equal(guarded.classifyMmrGuardedFile("notes.txt", "pi", env), undefined);
  });

  it("follows a dangling link to the file a write through it would create", () => {
    const root = realpathSync(tempDir("ampi-guarded-"));
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    mkdirSync(path.join(home, ".ssh"), { recursive: true });
    mkdirSync(path.join(project, ".git", "hooks"), { recursive: true });
    mkdirSync(path.join(project, "sub"));
    symlinkSync(path.join(".git", "hooks", "pre-commit"), path.join(project, "notes.txt"));
    symlinkSync(path.join(home, ".ssh", "authorized_keys"), path.join(project, "keys.txt"));
    symlinkSync("notes.txt", path.join(project, "chain.txt"));
    symlinkSync(path.join(home, ".ssh", "new"), path.join(project, "later"));
    // Relative to the folder the link really is in, not to the path it was reached by.
    symlinkSync(path.join("..", "..", "home", ".ssh", "rc"), path.join(project, "sub", "hook"));
    symlinkSync(path.join(project, "sub"), path.join(root, "view"));
    const env = { platform: "linux", homeDir: home, cwd: project, tempDir: path.join(root, "tmp"), agentDir: path.join(root, "agent"), env: {} };
    const cases = [
      ["notes.txt", "git", path.join(project, ".git", "hooks", "pre-commit")],
      ["keys.txt", "ssh", path.join(home, ".ssh", "authorized_keys")],
      ["chain.txt", "git", path.join(project, ".git", "hooks", "pre-commit")],
      ["later/id_ed25519", "ssh", path.join(home, ".ssh", "new", "id_ed25519")],
      [path.join(root, "view", "hook"), "ssh", path.join(home, ".ssh", "rc")],
    ];
    for (const [raw, category, real] of cases) {
      const file = guarded.classifyMmrGuardedFile(raw, "pi", env);
      assert.equal(file?.category.key, category, raw);
      assert.equal(file.realPath, real, raw);
      assert.deepEqual(file.guardedForms, [real], raw);
    }
  });

  it("follows a dangling link's target one name at a time, as the system does", () => {
    const root = realpathSync(tempDir("ampi-guarded-"));
    const home = path.join(root, "home");
    const project = path.join(home, "work", "repo");
    const hook = path.join(project, ".git", "hooks", "pre-commit");
    mkdirSync(path.join(home, ".ssh"), { recursive: true });
    mkdirSync(path.join(project, ".git", "hooks"), { recursive: true });
    const link = (target, name) => symlinkSync(target, path.join(project, name));
    link(".git/hooks", "d");
    link("..", "up");
    link("d", "e");
    // Targets are written out, since `path.join` would drop the `..`. The
    // `..` applies to the folder `d` leads to, not to the project.
    link("d/../hooks/pre-commit", "notes.txt");
    link("up/../.ssh/authorized_keys", "notes.md");
    link("./d/./../hooks/./pre-commit", "dots.txt");
    link(`${project}/d/../hooks/pre-commit`, "absolute.txt");
    link("e/../hooks/pre-commit", "twice.txt");
    link("notes.txt", "chain.txt");
    link("e/../hooks", "hooks2");
    link("hooks2/../hooks/pre-commit", "nested.txt");
    link("missing/../../../.ssh/rc", "gone.txt");
    link("chain.txt/../../../../../.ssh/rc", "through.txt");
    const env = { platform: "linux", homeDir: home, cwd: project, tempDir: path.join(root, "tmp"), agentDir: path.join(root, "agent"), env: {} };
    const cases = [
      ["notes.txt", "git", hook],
      ["notes.md", "ssh", path.join(home, ".ssh", "authorized_keys")],
      ["dots.txt", "git", hook],
      ["absolute.txt", "git", hook],
      ["twice.txt", "git", hook],
      ["chain.txt", "git", hook],
      ["nested.txt", "git", hook],
      ["gone.txt", "ssh", path.join(home, ".ssh", "rc")],
      ["through.txt", "ssh", path.join(home, ".ssh", "rc")],
    ];
    for (const [raw, category, real] of cases) {
      const file = guarded.classifyMmrGuardedFile(raw, "pi", env);
      assert.equal(file?.category.key, category, raw);
      assert.equal(file.realPath, real, raw);
      assert.deepEqual(file.guardedForms, [real], raw);
    }
  });

  it("counts every dangling link followed for one path against the limit", () => {
    const project = realpathSync(tempDir("ampi-guarded-"));
    // Each link names the next twice, so following them all would take 2^30 steps.
    for (let i = 0; i < 30; i += 1) symlinkSync(`l${i + 1}/../l${i + 1}`, path.join(project, `l${i}`));
    symlinkSync("missing", path.join(project, "l30"));
    const env = { ...LINUX, cwd: project, realpath: undefined, readlink: undefined };
    assert.equal(guarded.classifyMmrGuardedFile("l0/x", "plain", env)?.category.key, "unresolved-link");
  });

  it("guards a link that cannot be followed", () => {
    const project = realpathSync(tempDir("ampi-guarded-"));
    symlinkSync("loop", path.join(project, "loop"));
    symlinkSync("b", path.join(project, "a"));
    symlinkSync("a", path.join(project, "b"));
    const env = { ...LINUX, cwd: project, realpath: undefined, readlink: undefined };
    for (const raw of ["loop", "loop/x", "a"]) {
      const file = guarded.classifyMmrGuardedFile(raw, "plain", env);
      assert.equal(file?.category.key, "unresolved-link", raw);
      assert.equal(file.realPath, undefined, raw);
      assert.deepEqual(file.guardedForms, [path.join(project, raw)], raw);
    }
    const chain = { ...LINUX, cwd: "/p", realpath: (p) => (p === "/p" ? p : nothingExists()), readlink: (p) => `${p}x` };
    assert.equal(guarded.classifyMmrGuardedFile("l", "plain", chain)?.category.key, "unresolved-link", "too many links in a row");
  });
});

describe("ampi-permissions guarded files: patch paths", () => {
  const patches = {
    add: "*** Begin Patch\n*** Add File: docs/new.md\n+hello\n*** End Patch\n",
    update: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch\n",
    delete: "*** Begin Patch\n*** Delete File: .env\n*** End Patch\n",
    move: "*** Begin Patch\n*** Update File: .pi/prompt.md\n*** Move to: docs/prompt.md\n@@\n-a\n+b\n*** End Patch\n",
    crlf: "*** Begin Patch\r\n*** Update File: src/b.ts\r\n*** Move to: src/c.ts\r\n@@\r\n-x\r\n+y\r\n*** Delete File: .git/hooks/post-merge\r\n*** End Patch\r\n",
    spaces: "*** Begin Patch\n*** Add File:    spaced name.txt   \n+x\n*** Delete File: \t.env.local \n*** End Patch\n",
  };

  for (const [name, text] of Object.entries(patches)) {
    it(`finds every path the patch parser finds: ${name}`, () => {
      const parsed = patchParser.parseCodexPatch(text).flatMap((op) => [op.rawPath, ...(op.movePath ? [op.movePath] : [])]);
      assert.ok(parsed.length > 0);
      const found = activity.patchTextPaths(text);
      for (const entry of parsed) assert.ok(found.includes(entry), `${JSON.stringify(entry)} in ${JSON.stringify(found)}`);
    });
  }

  it("lists a move's source and target, trimmed", () => {
    assert.deepEqual(activity.patchTextPaths(patches.move), [".pi/prompt.md", "docs/prompt.md"]);
    assert.deepEqual(activity.patchTextPaths(patches.crlf), ["src/b.ts", "src/c.ts", ".git/hooks/post-merge"]);
    assert.deepEqual(activity.patchTextPaths(patches.spaces), ["spaced name.txt", ".env.local"]);
  });
});

const ON = { ampi: { permissions: [] } };
const NO_SEAMS = { AMPI_PERMISSIONS_ALLOW_ALL: undefined, AMPI_PERMISSIONS_PROJECT_RULES: undefined };
const GUARDED_OPTIONS = ["Allow Once", "Always Allow This Path", "Reject"];

function settingsOf(t) {
  return JSON.parse(readFileSync(path.join(t.agentDir, "settings.json"), "utf8"));
}

/** The forms an "Always Allow This Path" answer saves for a file in a temporary directory. */
function savedForms(filePath) {
  const real = path.join(realpathSync(path.dirname(filePath)), path.basename(filePath));
  return [...new Set([filePath, real])];
}

/** The exact allowlist entries "Always Allow This Path" saves for those forms. */
function exact(forms) {
  return forms.map((form) => ({ path: form }));
}

describe("ampi-permissions guarded files: the dialog", () => {
  it("asks before write changes .env, with the tool, the path and its category", async () => {
    const t = await setupPermissions(modules, { user: ON, answers: ["Allow Once"] });
    assert.equal(await t.call("write", { path: ".env", content: "A=1\n" }), undefined);
    assert.equal(t.selects.length, 1);
    assert.deepEqual(t.selects[0].choices, GUARDED_OPTIONS);
    assert.deepEqual(t.selects[0].title.split("\n"), ["Guarded File Modification", "Tool: write", ".env (environment file)"]);
    const events = t.bus.emitted.filter((entry) => entry.name === modules.runtime.MMR_EVENT_APPROVAL).map((entry) => entry.data.phase);
    assert.deepEqual(events, ["request", "answer"]);
  });

  it("asks before write follows a dangling link into .git, naming where it leads", async () => {
    const cwd = realpathSync(tempDir());
    mkdirSync(path.join(cwd, ".git", "hooks"), { recursive: true });
    symlinkSync(path.join(".git", "hooks", "pre-commit"), path.join(cwd, "notes.txt"));
    const t = await setupPermissions(modules, { user: ON, cwd, answers: ["Reject"] });
    assert.equal((await t.call("write", { path: "notes.txt", content: "#!/bin/sh\n" })).block, true);
    assert.equal(t.selects[0].title.split("\n")[2], `notes.txt → ${path.join(".git", "hooks", "pre-commit")} (Git internals)`);
  });

  it("blocks with the category and the path on Reject, and when the dialog is closed", async () => {
    const t = await setupPermissions(modules, { user: ON, answers: ["Reject", undefined] });
    const envFile = path.join(t.cwd, ".env");
    const rejected = await t.call("write", { path: ".env", content: "" });
    assert.equal(rejected.block, true);
    assert.equal(rejected.reason, `The user rejected the write call, which changes a guarded file: ${envFile} (environment file).`);
    const closed = await t.call("edit", { path: "@.env", edits: [] });
    assert.equal(closed.block, true);
    assert.match(closed.reason, /closed without an answer, so the edit call did not run/);
    assert.ok(closed.reason.includes(`${envFile} (environment file)`), closed.reason);
  });

  it("blocks an interrupted turn with the usual reason", async () => {
    const t = await setupPermissions(modules, { user: ON, answers: ["Allow Once"] });
    t.controller.abort();
    const { MMR_PERMISSIONS_ABORTED_REASON } = await importSource("extensions/ampi-permissions/gate.ts");
    assert.deepEqual(await t.call("write", { path: ".env", content: "" }), { block: true, reason: MMR_PERMISSIONS_ABORTED_REASON });
    assert.equal(t.selects.length, 0);
  });

  it("saves Always Allow This Path to the user settings, keeping every other key and entry", async () => {
    const cwd = tempDir();
    const user = { theme: "dark", ampi: { permissions: [{ tool: "read", action: "allow" }], guardedFiles: { allowlist: ["/srv/keep/**"] } } };
    const t = await setupPermissions(modules, { user, cwd, answers: ["Always Allow This Path"] });
    assert.equal(await t.call("write", { path: ".env", content: "" }), undefined);
    const forms = savedForms(path.join(cwd, ".env"));
    assert.deepEqual(settingsOf(t), {
      theme: "dark",
      ampi: { permissions: [{ tool: "read", action: "allow" }], guardedFiles: { allowlist: ["/srv/keep/**", ...exact(forms)] } },
    });
    assert.ok(t.notifications.some((n) => n.level === "info" && n.message.includes("ampi.guardedFiles.allowlist")));
    assert.equal(await t.call("write", { path: ".env", content: "B=2\n" }), undefined);
    assert.equal(t.selects.length, 1, "the saved path runs without asking");
    assert.equal((await t.call("write", { path: ".env.local", content: "" })).block, true, "another guarded path still asks");
  });

  it("asks until every guarded form is allowed, and saves the missing one without repeats", async () => {
    const cwd = tempDir();
    const elsewhere = tempDir();
    symlinkSync(elsewhere, path.join(cwd, "linked"));
    const lexical = path.join(cwd, "linked", ".env");
    const real = path.join(realpathSync(elsewhere), ".env");
    const t = await setupPermissions(modules, { user: { ampi: { guardedFiles: { allowlist: [{ path: lexical }] } } }, cwd, answers: ["Always Allow This Path"] });
    assert.equal(await t.call("write", { path: "linked/.env", content: "" }), undefined);
    assert.equal(t.selects.length, 1, "the real path behind the link is not on the allowlist");
    assert.deepEqual(settingsOf(t).ampi.guardedFiles.allowlist, exact([lexical, real]));
    assert.equal(await t.call("write", { path: "linked/.env", content: "" }), undefined);
    assert.equal(t.selects.length, 1);
  });

  it("saves a path with glob characters so it covers only itself", async () => {
    const cwd = tempDir();
    const t = await setupPermissions(modules, { user: ON, cwd, answers: ["Always Allow This Path", "Reject", "Always Allow This Path"] });
    assert.equal(await t.call("write", { path: ".env.?", content: "" }), undefined);
    assert.equal((await t.call("write", { path: ".env.x", content: "" })).block, true, "a ? in the saved path is no wildcard");
    const slug = path.join("app", "[[...slug]]", ".env");
    mkdirSync(path.join(cwd, path.dirname(slug)), { recursive: true });
    assert.equal(await t.call("write", { path: slug, content: "" }), undefined);
    assert.equal(t.selects.length, 3);
    assert.deepEqual(settingsOf(t).ampi.guardedFiles.allowlist, exact([...savedForms(path.join(cwd, ".env.?")), ...savedForms(path.join(cwd, slug))]));
    assert.equal(t.notifications.filter((n) => n.level === "warning").length, 0, "no saved entry is skipped");
    assert.equal(await t.call("write", { path: slug, content: "" }), undefined);
    assert.equal(await t.call("write", { path: ".env.?", content: "" }), undefined);
    assert.equal(t.selects.length, 3, "both saved paths run without asking");
  });

  it("allows once with an error when the user settings file holds no JSON object", async () => {
    const t = await setupPermissions(modules, { userText: "[1, 2]\n", project: ON, answers: ["Always Allow This Path", undefined] });
    assert.equal(await t.call("write", { path: ".env", content: "" }), undefined);
    assert.ok(t.notifications.some((n) => n.level === "error" && /Could not save .*does not hold a JSON object/s.test(n.message)));
    assert.equal(readFileSync(path.join(t.agentDir, "settings.json"), "utf8"), "[1, 2]\n");
    assert.equal((await t.call("write", { path: ".env", content: "" })).block, true, "the next change asks again");
    assert.equal(t.selects.length, 2);
  });
});

describe("ampi-permissions guarded files: the allowlist", () => {
  it("lets an exact path and a glob through, and nothing else", async () => {
    const cwd = tempDir();
    const allowlist = [...exact(savedForms(path.join(cwd, ".env"))), `${realpathSync(cwd)}/config/**/.env*`, `${cwd}/config/**/.env*`];
    const t = await setupPermissions(modules, { user: { ampi: { guardedFiles: { allowlist } } }, cwd });
    assert.equal(await t.call("write", { path: ".env", content: "" }), undefined);
    assert.equal(await t.call("write", { path: "config/staging/.env.local", content: "" }), undefined);
    assert.equal(t.selects.length, 0);
    assert.equal((await t.call("write", { path: ".env.local", content: "" })).block, true);
    assert.equal(t.selects.length, 1);
  });

  it("turns the gate on alone, with ampi's default rules", async () => {
    const t = await setupPermissions(modules, { user: { ampi: { guardedFiles: { allowlist: [] } } } });
    const status = modules.runtime.resolveMmrFeatureGates(["ampi-permissions"])[0];
    assert.equal(status.status, "enabled");
    assert.match(status.reason, /, 0 guarded file allowlist entries$/);
    assert.equal((await t.call("write", { path: ".env", content: "" })).block, true);
    assert.equal((await t.call("bash", { command: "rm -rf build" })).block, true);
    assert.equal(t.selects.length, 2);
  });

  it("counts the entries, and says how to turn the gate on when it is off", async () => {
    await setupPermissions(modules, { user: { ampi: { guardedFiles: { allowlist: ["/a/**", "~/b"] } } } });
    assert.match(modules.runtime.resolveMmrFeatureGates(["ampi-permissions"])[0].reason, /, 2 guarded file allowlist entries$/);
    await setupPermissions(modules, { user: {} });
    assert.match(modules.runtime.resolveMmrFeatureGates(["ampi-permissions"])[0].reason, /ampi\.guardedFiles\.allowlist/);
  });

  it("skips entries that are not strings, not absolute or not valid globs, naming their index", async () => {
    const cwd = tempDir();
    const allowlist = [3, "relative/.env", "/srv/[z-a]/x", { glob: "/srv/**" }, { path: "relative/.env" }, ...exact(savedForms(path.join(cwd, ".env")))];
    const t = await setupPermissions(modules, { user: { ampi: { guardedFiles: { allowlist } } }, cwd });
    const warning = t.notifications.find((n) => n.level === "warning")?.message ?? "";
    for (const index of [0, 1, 2, 3, 4]) assert.match(warning, new RegExp(`ampi\\.guardedFiles\\.allowlist\\[${index}\\]`));
    assert.doesNotMatch(warning, /allowlist\[5\]/);
    assert.equal(await t.call("write", { path: ".env", content: "" }), undefined);
  });

  it("ignores a project's allowlist with one warning, and a project's allowlist does not turn the gate on", async () => {
    const cwd = tempDir();
    const project = { ampi: { guardedFiles: { allowlist: exact(savedForms(path.join(cwd, ".env"))) } } };
    const t = await setupPermissions(modules, { user: ON, project, cwd });
    const warnings = t.notifications.filter((n) => n.level === "warning" && n.message.includes("ampi.guardedFiles"));
    assert.equal(warnings.length, 1);
    assert.equal((await t.call("write", { path: ".env", content: "" })).block, true);
    assert.equal(t.selects.length, 1);

    const off = await setupPermissions(modules, { user: {}, project });
    assert.equal(modules.runtime.resolveMmrFeatureGates(["ampi-permissions"])[0].status, "disabled");
    assert.equal(await off.call("write", { path: ".env", content: "" }), undefined);
    assert.equal(off.selects.length, 0);
  });
});

describe("ampi-permissions guarded files: tools", () => {
  const patch = (...lines) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

  it("asks once for apply_patch and lists only its guarded paths", async () => {
    const t = await setupPermissions(modules, { user: ON, answers: ["Allow Once", "Allow Once"] });
    const one = patch("*** Add File: src/new.ts", "+x", "*** Update File: .env", "@@", "-A=1", "+A=2");
    assert.equal(await t.call("apply_patch", { patchText: one }), undefined);
    assert.deepEqual(t.selects[0].title.split("\n").slice(1), ["Tool: apply_patch", ".env (environment file)"]);
    const two = patch("*** Delete File: data/app.sqlite", "*** Add File: .git/hooks/pre-push", "+exit 0");
    assert.equal(await t.call("apply_patch", { patchText: two }), undefined);
    assert.equal(t.selects.length, 2);
    assert.deepEqual(t.selects[1].title.split("\n").slice(2), [
      `${path.join("data", "app.sqlite")} (database file)`,
      `${path.join(".git", "hooks", "pre-push")} (Git internals)`,
    ]);
  });

  it("asks for a patch that moves a file out of .pi", async () => {
    const t = await setupPermissions(modules, { user: ON });
    const move = patch("*** Update File: .pi/prompts/review.md", "*** Move to: docs/review.md", "@@", "-a", "+b");
    assert.equal((await t.call("apply_patch", { patchText: move })).block, true);
    assert.deepEqual(t.selects[0].title.split("\n").slice(2), [`${path.join(".pi", "prompts", "review.md")} (agent configuration)`]);
  });

  it("asks for painter with an output_path into .git, and not without one", async () => {
    const t = await setupPermissions(modules, { user: ON });
    assert.equal((await t.call("painter", { prompt: "a cat", output_path: ".git/cat.png" })).block, true);
    assert.equal(t.selects.length, 1);
    assert.equal(await t.call("painter", { prompt: "a cat" }), undefined);
    assert.equal(await t.call("painter", { prompt: "a cat", output_path: "images/cat.png" }), undefined);
    assert.equal(t.selects.length, 1);
  });

  it("leaves shell tools to the rules", async () => {
    const t = await setupPermissions(modules, { user: ON });
    assert.equal((await t.call("bash", { command: "echo x > .env" })).block, true);
    assert.equal(t.selects.length, 1);
    assert.equal(t.selects[0].title.split("\n")[0], "Approval Required");
    const allowed = await setupPermissions(modules, { user: { ampi: { permissions: [{ tool: "bash", action: "allow" }] } } });
    assert.equal(await allowed.call("bash", { command: "echo x > .env" }), undefined);
    assert.equal(allowed.selects.length, 0);
  });

  it("does not check other tools or inputs without a string path", async () => {
    const t = await setupPermissions(modules, { user: ON });
    assert.equal(await t.call("read", { path: ".env" }), undefined);
    assert.equal(await t.call("write", { path: 7, content: "" }), undefined);
    assert.equal(await t.call("apply_patch", {}), undefined);
    assert.equal(t.selects.length, 0);
  });
});

describe("ampi-permissions guarded files: rules, runs without UI and subagents", () => {
  it("still asks when an allow rule covers the tool", async () => {
    const t = await setupPermissions(modules, { user: { ampi: { permissions: [{ tool: "write", action: "allow" }] } } });
    assert.equal((await t.call("write", { path: ".env", content: "" })).block, true);
    assert.equal(t.selects[0].title.split("\n")[0], "Guarded File Modification");
    assert.equal(await t.call("write", { path: "notes.txt", content: "" }), undefined);
    assert.equal(t.selects.length, 1);
  });

  it("lets a reject rule block without the guarded dialog", async () => {
    const rule = { tool: "write", action: "reject", message: "No writes here." };
    const t = await setupPermissions(modules, { user: { ampi: { permissions: [rule] } } });
    assert.deepEqual(await t.call("write", { path: ".env", content: "" }), { block: true, reason: "No writes here." });
    assert.equal(t.selects.length, 0);
  });

  it("opens one dialog when an ask rule and a guarded path both ask", async () => {
    const t = await setupPermissions(modules, { user: { ampi: { permissions: [{ tool: "write", action: "ask" }] } }, answers: ["Allow Once"] });
    assert.equal(await t.call("write", { path: ".env", content: "" }), undefined);
    assert.equal(t.selects.length, 1);
    assert.equal(t.selects[0].title.split("\n")[0], "Guarded File Modification");
  });

  it("blocks without UI with the guarded reason", async () => {
    const t = await setupPermissions(modules, { user: ON, hasUI: false });
    const result = await t.call("write", { path: ".git/config", content: "" });
    assert.equal(result.block, true);
    assert.equal(
      result.reason,
      `The write call changes a guarded file: ${path.join(t.cwd, ".git", "config")} (Git internals). Changes to guarded files need the user's approval, even when a rule allows the tool, and this run cannot ask for it. A path in ampi.guardedFiles.allowlist in the user settings lets such calls run without asking.`,
    );
  });

  it("names where a link leads in the reason", async () => {
    const cwd = realpathSync(tempDir());
    mkdirSync(path.join(cwd, ".git", "hooks"), { recursive: true });
    symlinkSync(path.join(".git", "hooks", "pre-commit"), path.join(cwd, "notes.txt"));
    const t = await setupPermissions(modules, { user: ON, cwd, hasUI: false });
    const { reason } = await t.call("write", { path: "notes.txt", content: "" });
    const expected = `The write call changes a guarded file: ${path.join(cwd, "notes.txt")}, which leads to ${path.join(cwd, ".git", "hooks", "pre-commit")} (Git internals). `;
    assert.ok(reason.startsWith(expected), reason);
  });

  it("refuses in a subagent child with the guarded reason and no dialog", async () => {
    const restore = setEnv(NO_SEAMS);
    try {
      const t = await setupPermissions(modules, { user: { ampi: { permissions: [{ tool: "write", action: "allow" }] } }, subagent: true });
      const result = await t.call("write", { path: ".pi/settings.json", content: "{}" });
      assert.equal(result.block, true);
      assert.match(result.reason, /\(agent configuration\)\. Changes to guarded files need the user's approval, even when a rule allows the tool, and a subagent cannot ask/);
      assert.match(result.reason, /Tell the main session/);
      assert.equal(t.selects.length, 0);
    } finally {
      restore();
    }
  });

  it("skips the check under ampi.dangerouslyAllowAll and Allow All for This Session", async () => {
    const all = await setupPermissions(modules, { user: { ampi: { dangerouslyAllowAll: true, guardedFiles: { allowlist: [] } } } });
    assert.equal(await all.call("write", { path: ".env", content: "" }), undefined);
    assert.equal(all.selects.length, 0);

    const t = await setupPermissions(modules, { user: ON, answers: ["Allow All for This Session"] });
    assert.equal(await t.call("bash", { command: "rm -rf build" }), undefined);
    assert.equal(await t.call("write", { path: ".env", content: "" }), undefined);
    assert.equal(t.selects.length, 1);
  });
});
