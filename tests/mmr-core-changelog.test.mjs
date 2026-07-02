import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

const MODELS = [
  { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000 },
  { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000 },
  { provider: "claude-subscription", id: "claude-haiku-4-5" },
  { provider: "google", id: "gemini-3.5-flash" },
];

after(cleanupLoadedSource);

async function importChangelogModule() {
  const url = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/changelog.ts")).href;
  return import(`${url}?${Date.now()}-${Math.random()}`);
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(runtimeUrl);
}

function writePackage(root, { version = "0.0.0", isPrivate = true, changelog }) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "ampi", version, private: isPrivate }, null, 2));
  writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
}

function writePreparedPackage({ version = "0.0.0", isPrivate = true, changelog }) {
  const packageRoot = path.dirname(getPreparedSourceRoot());
  writePackage(packageRoot, { version, isPrivate, changelog });
  return packageRoot;
}

function makeVersionedChangelog(entries) {
  return [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "### Added",
    "",
    "- Pending work.",
    "",
    ...entries.flatMap(({ version, body }) => [
      `## [${version}] - 2026-05-25`,
      "",
      "### Added",
      "",
      body,
      "",
    ]),
  ].join("\n");
}

function makeUnreleasedChangelog(bullets) {
  return [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "### Added",
    "",
    ...bullets.map((bullet) => `- ${bullet}`),
    "",
  ].join("\n");
}

function captureStderr(fn) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") cb();
    return true;
  };
  try {
    return { result: fn(), stderr: captured.join("") };
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function captureStderrAsync(fn) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") cb();
    return true;
  };
  try {
    const result = await fn();
    return { result, stderr: captured.join("") };
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function withChangelogDebugEnvAsync(value, fn) {
  const previous = process.env.PI_MMR_CHANGELOG_DEBUG;
  if (value === undefined) delete process.env.PI_MMR_CHANGELOG_DEBUG;
  else process.env.PI_MMR_CHANGELOG_DEBUG = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PI_MMR_CHANGELOG_DEBUG;
    else process.env.PI_MMR_CHANGELOG_DEBUG = previous;
  }
}

function withChangelogDebugEnv(value, fn) {
  const previous = process.env.PI_MMR_CHANGELOG_DEBUG;
  if (value === undefined) delete process.env.PI_MMR_CHANGELOG_DEBUG;
  else process.env.PI_MMR_CHANGELOG_DEBUG = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PI_MMR_CHANGELOG_DEBUG;
    else process.env.PI_MMR_CHANGELOG_DEBUG = previous;
  }
}

describe("mmr-core changelog parsing and update display", () => {
  it("parses Pi-style version sections and selects every version newer than the last seen update", async () => {
    const { getNewVersionedMmrChangelogEntries, parseMmrChangelog } = await importChangelogModule();
    const parsed = parseMmrChangelog([
      "# Changelog",
      "",
      "## [0.3.0] - 2026-05-25",
      "",
      "### Added",
      "",
      "- Third update.",
      "",
      "## 0.2.0",
      "",
      "### Fixed",
      "",
      "- Second update.",
      "",
      "## Internal Notes",
      "",
      "- ignored",
    ].join("\n"));

    assert.deepEqual(parsed.versionedEntries.map((entry) => entry.version), ["0.3.0", "0.2.0"]);
    const newer = getNewVersionedMmrChangelogEntries(parsed.versionedEntries, "0.1.0", "0.3.0");
    assert.deepEqual(newer.map((entry) => entry.version), ["0.3.0", "0.2.0"]);
  });

  it("shows current version notes on first observation, then only versioned entries newer than the user's last update", async () => {
    const { evaluateMmrChangelogForDisplay } = await importChangelogModule();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-changelog-"));
    try {
      const packageRoot = path.join(tempRoot, "pkg");
      const statePath = path.join(tempRoot, "state.json");

      writePackage(packageRoot, {
        version: "0.2.0",
        changelog: makeVersionedChangelog([
          { version: "0.2.0", body: "- Second update." },
          { version: "0.1.0", body: "- First update." },
        ]),
      });
      const firstSeen = evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-05-25T00:00:00.000Z" });
      assert.ok(firstSeen, "expected current release notes on first observation");
      assert.match(firstSeen.markdown, /Second update/);
      assert.doesNotMatch(firstSeen.markdown, /First update/);

      writePackage(packageRoot, {
        version: "0.4.0",
        changelog: makeVersionedChangelog([
          { version: "0.4.0", body: "- Fourth update." },
          { version: "0.3.0", body: "- Third update." },
          { version: "0.2.0", body: "- Second update." },
          { version: "0.1.0", body: "- First update." },
        ]),
      });

      const update = evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-05-25T00:01:00.000Z" });
      assert.ok(update, "expected a changelog after package version advanced");
      assert.equal(update.displayVersion, "0.4.0");
      assert.match(update.markdown, /## \[0\.4\.0\]/);
      assert.match(update.markdown, /Fourth update/);
      assert.match(update.markdown, /## \[0\.3\.0\]/);
      assert.match(update.markdown, /Third update/);
      assert.doesNotMatch(update.markdown, /Second update/);
      assert.doesNotMatch(update.markdown, /First update/);

      assert.equal(evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-05-25T00:02:00.000Z" }), undefined);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("tracks 0.0.0 Unreleased bullets incrementally so repeated git-style updates show only new additions", async () => {
    const { evaluateMmrChangelogForDisplay } = await importChangelogModule();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-unreleased-"));
    try {
      const packageRoot = path.join(tempRoot, "pkg");
      const statePath = path.join(tempRoot, "state.json");

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog(["First installed change.", "Second installed change."]),
      });
      const initial = evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-05-25T00:00:00.000Z" });
      assert.ok(initial, "expected current Unreleased bullets on first observation");
      assert.match(initial.markdown, /First installed change/);
      assert.match(initial.markdown, /Second installed change/);

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog([
          "First installed change.",
          "Second installed change.",
          "Third update change.",
          "Fourth update change.",
        ]),
      });
      const firstUpdate = evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-05-25T00:01:00.000Z" });
      assert.ok(firstUpdate, "expected new Unreleased bullets to be displayed");
      assert.match(firstUpdate.markdown, /Third update change/);
      assert.match(firstUpdate.markdown, /Fourth update change/);
      assert.doesNotMatch(firstUpdate.markdown, /First installed change/);
      assert.doesNotMatch(firstUpdate.markdown, /Second installed change/);
      assert.equal(evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-05-25T00:02:00.000Z" }), undefined);

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog([
          "First installed change.",
          "Second installed change.",
          "Third update change.",
          "Fourth update change.",
          "Fifth update change.",
        ]),
      });
      const secondUpdate = evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-05-25T00:03:00.000Z" });
      assert.ok(secondUpdate, "expected only the newly added Unreleased bullet on the next update");
      assert.match(secondUpdate.markdown, /Fifth update change/);
      assert.doesNotMatch(secondUpdate.markdown, /Third update change/);
      assert.doesNotMatch(secondUpdate.markdown, /Fourth update change/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not consume a pending changelog on resumed sessions", async () => {
    const { maybeShowMmrChangelogOnSessionStart } = await importChangelogModule();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-resume-"));
    try {
      const packageRoot = path.join(tempRoot, "pkg");
      const statePath = path.join(tempRoot, "state.json");
      const { ctx, notifications } = createMockExtensionContext({ models: MODELS });

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog(["Already installed."]),
      });
      await maybeShowMmrChangelogOnSessionStart({ type: "session_start", reason: "new" }, ctx, { packageRoot, statePath, now: "2026-05-25T00:00:00.000Z" });
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].message, /Already installed/);
      notifications.length = 0;

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog(["Already installed.", "Pending update."]),
      });
      await maybeShowMmrChangelogOnSessionStart({ type: "session_start", reason: "resume" }, ctx, { packageRoot, statePath, now: "2026-05-25T00:01:00.000Z" });
      assert.deepEqual(notifications, []);

      await maybeShowMmrChangelogOnSessionStart({ type: "session_start", reason: "new" }, ctx, { packageRoot, statePath, now: "2026-05-25T00:02:00.000Z" });
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].message, /Pending update/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips reload, fork, non-UI, and existing-entry sessions without consuming the pending changelog", async () => {
    const { maybeShowMmrChangelogOnSessionStart } = await importChangelogModule();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-skip-"));
    try {
      const packageRoot = path.join(tempRoot, "pkg");
      const statePath = path.join(tempRoot, "state.json");
      const first = createMockExtensionContext({ models: MODELS });

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog(["Already installed."]),
      });
      await maybeShowMmrChangelogOnSessionStart({ type: "session_start", reason: "new" }, first.ctx, { packageRoot, statePath, now: "2026-05-25T00:00:00.000Z" });
      assert.equal(first.notifications.length, 1);

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog(["Already installed.", "Pending fresh-start update."]),
      });

      for (const event of [
        { type: "session_start", reason: "reload" },
        { type: "session_start", reason: "fork" },
      ]) {
        const skipped = createMockExtensionContext({ models: MODELS });
        await maybeShowMmrChangelogOnSessionStart(event, skipped.ctx, { packageRoot, statePath, now: "2026-05-25T00:01:00.000Z" });
        assert.deepEqual(skipped.notifications, []);
      }

      const noUi = createMockExtensionContext({ models: MODELS, hasUI: false });
      await maybeShowMmrChangelogOnSessionStart({ type: "session_start", reason: "new" }, noUi.ctx, { packageRoot, statePath, now: "2026-05-25T00:02:00.000Z" });
      assert.deepEqual(noUi.notifications, []);

      const withEntries = createMockExtensionContext({ models: MODELS, entries: [{ type: "message" }] });
      await maybeShowMmrChangelogOnSessionStart({ type: "session_start", reason: "new" }, withEntries.ctx, { packageRoot, statePath, now: "2026-05-25T00:03:00.000Z" });
      assert.deepEqual(withEntries.notifications, []);

      const fresh = createMockExtensionContext({ models: MODELS });
      await maybeShowMmrChangelogOnSessionStart({ type: "session_start", reason: "new" }, fresh.ctx, { packageRoot, statePath, now: "2026-05-25T00:04:00.000Z" });
      assert.equal(fresh.notifications.length, 1);
      assert.match(fresh.notifications[0].message, /Pending fresh-start update/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses Pi's persistent warning notify level for the fresh-session ampi update notice", async () => {
    const { maybeShowMmrChangelogOnSessionStart } = await importChangelogModule();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-notify-level-"));
    try {
      const packageRoot = path.join(tempRoot, "pkg");
      const statePath = path.join(tempRoot, "state.json");
      const { ctx, notifications } = createMockExtensionContext({ models: MODELS });

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog(["Installed change."]),
      });
      await maybeShowMmrChangelogOnSessionStart(
        { type: "session_start", reason: "new" },
        ctx,
        { packageRoot, statePath, now: "2026-05-25T00:00:00.000Z" },
      );
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, "warning");
      assert.match(notifications[0].message, /ampi What's New/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits an env-gated stderr diagnostic when evaluateMmrChangelogForDisplay throws", async () => {
    const { evaluateMmrChangelogForDisplay } = await importChangelogModule();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-debug-eval-"));
    try {
      const packageRoot = path.join(tempRoot, "pkg");
      const statePath = path.join(tempRoot, "state.json");

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog(["x"]),
      });
      // Corrupt the state path to force an injected failure during read.
      // The state path resolves to a directory rather than a file, which makes
      // readFileSync throw EISDIR from inside readMmrChangelogState.
      mkdirSync(statePath, { recursive: true });

      const silent = withChangelogDebugEnv(undefined, () =>
        captureStderr(() =>
          evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-05-25T00:00:00.000Z" }),
        ),
      );
      assert.equal(silent.result, undefined);
      assert.equal(silent.stderr, "");

      const debug = withChangelogDebugEnv("1", () =>
        captureStderr(() =>
          evaluateMmrChangelogForDisplay({ packageRoot, statePath, now: "2026-05-25T00:00:00.000Z" }),
        ),
      );
      assert.equal(debug.result, undefined);
      assert.match(debug.stderr, /\[ampi changelog\] evaluateMmrChangelogForDisplay failed:/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits an env-gated stderr diagnostic when maybeShowMmrChangelogOnSessionStart is skipped by the fresh-session gate", async () => {
    const { maybeShowMmrChangelogOnSessionStart } = await importChangelogModule();
    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-debug-skip-"));
    try {
      const packageRoot = path.join(tempRoot, "pkg");
      const statePath = path.join(tempRoot, "state.json");
      const { ctx, notifications } = createMockExtensionContext({ models: MODELS });

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog(["Pending change."]),
      });

      const silent = await captureStderrAsync(() =>
        withChangelogDebugEnvAsync(undefined, () =>
          maybeShowMmrChangelogOnSessionStart(
            { type: "session_start", reason: "resume" },
            ctx,
            { packageRoot, statePath, now: "2026-05-25T00:00:00.000Z" },
          ),
        ),
      );
      assert.deepEqual(notifications, []);
      assert.equal(silent.stderr, "");

      const debug = await captureStderrAsync(() =>
        withChangelogDebugEnvAsync("1", () =>
          maybeShowMmrChangelogOnSessionStart(
            { type: "session_start", reason: "resume" },
            ctx,
            { packageRoot, statePath, now: "2026-05-25T00:01:00.000Z" },
          ),
        ),
      );
      assert.deepEqual(notifications, []);
      assert.match(debug.stderr, /\[ampi changelog\] session_start skipped: event\.reason=resume/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("registers /mmr-changelog and shows a ampi update notice on the next fresh session without touching Pi's changelog state", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "ampi-session-changelog-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    try {
      const home = path.join(tempRoot, "home");
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const packageRoot = writePreparedPackage({
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog(["Already installed."]),
      });

      const extension = (await importSource("extensions/mmr-core/index.ts")).default;
      const runtime = await importRuntime();
      runtime.setMmrModeState(undefined);
      runtime.setMmrSessionIdentity(undefined);

      const first = createMockExtensionContext({ models: MODELS });
      const { pi, commands, handlers } = createMockPi({
        activeTools: ["read", "bash", "grep"],
        allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      });
      extension(pi);
      assert.equal(commands.has("mmr-changelog"), true);

      await handlers.get("session_start")({ type: "session_start", reason: "new" }, first.ctx);
      const initialNotice = first.notifications.find((entry) => entry.message.includes("ampi What's New"));
      assert.ok(initialNotice, "expected current ampi changelog on first observed startup");
      assert.match(initialNotice.message, /Already installed/);

      writePackage(packageRoot, {
        version: "0.0.0",
        isPrivate: true,
        changelog: makeUnreleasedChangelog(["Already installed.", "New update after install."]),
      });

      const second = createMockExtensionContext({ models: MODELS });
      await handlers.get("session_start")({ type: "session_start", reason: "new" }, second.ctx);
      const updateNotice = second.notifications.find((entry) => entry.message.includes("ampi What's New"));
      assert.ok(updateNotice, "expected a ampi changelog notification on the next fresh session");
      assert.equal(updateNotice.level, "warning");
      assert.match(updateNotice.message, /New update after install/);
      assert.doesNotMatch(updateNotice.message, /Already installed/);

      const third = createMockExtensionContext({ models: MODELS });
      await handlers.get("session_start")({ type: "session_start", reason: "new" }, third.ctx);
      assert.equal(third.notifications.some((entry) => entry.message.includes("ampi What's New")), false);

      await commands.get("mmr-changelog").handler("", second.ctx);
      assert.match(second.notifications.at(-1)?.message ?? "", /ampi Changelog/);
      assert.match(second.notifications.at(-1)?.message ?? "", /Already installed/);
      assert.match(second.notifications.at(-1)?.message ?? "", /New update after install/);

      assert.equal(existsSync(path.join(home, ".pi/agent/settings.json")), false, "ampi must not write Pi's lastChangelogVersion setting");
      const state = JSON.parse(readFileSync(path.join(home, ".pi/agent/data/ampi/changelog/state.json"), "utf8"));
      assert.equal(state.version, 1);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
