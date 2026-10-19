// The read-only guard for imported sessions
// (src/extensions/ampi-core/imported-session.ts): the predicate, ampi-core's
// input, user_bash and session_before_compact handlers on the stub Pi with
// and without a UI, and a real Pi SDK
// session opened on an imported session file, in which a prompt reaches
// neither the model nor the file. Print mode's exit code is covered by the
// spawn test in tests/mmr-cli-import.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const NOTICE =
  "This session was imported from another coding agent and is read-only. To continue the work, start a new session and mention this one with @@, or ask the agent to use find_session and read_session.";
const importEntry = { type: "custom", id: "c1", parentId: null, customType: "ampi-import", data: { agent: "claude-code", sourceId: "s-1" } };
const userEntry = { type: "message", id: "m1", parentId: "c1", message: { role: "user", content: "Fix the parser", timestamp: 1 } };

const savedExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe("isMmrImportedSession", () => {
  it("is true only for a session holding the ampi-import custom entry", async () => {
    const { isMmrImportedSession } = await importSource("extensions/ampi-core/imported-session.ts");
    assert.equal(isMmrImportedSession([userEntry, importEntry]), true);
    assert.equal(isMmrImportedSession([]), false);
    assert.equal(isMmrImportedSession([userEntry]), false);
    assert.equal(isMmrImportedSession([{ ...importEntry, customType: "ampi-imported" }]), false);
    assert.equal(isMmrImportedSession([{ type: "custom_message", customType: "ampi-import", content: "x" }]), false, "a custom message is not the entry");
    assert.equal(isMmrImportedSession([null, "text", 3]), false);
  });
});

describe("ampi-core's input handler", () => {
  async function inputHandler() {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const mock = createMockPi();
    extension(mock.pi);
    return mock.handlers.get("input");
  }

  it("refuses a prompt in an imported session with the notice, whatever its source", async () => {
    const input = await inputHandler();
    for (const source of ["interactive", "rpc", "extension"]) {
      const { ctx, notifications } = createMockExtensionContext({ entries: [importEntry, userEntry] });
      assert.deepEqual(await input({ type: "input", text: "continue", source }, ctx), { action: "handled" }, source);
      assert.deepEqual(notifications, [{ message: NOTICE, level: "warning" }]);
    }
    assert.equal(process.exitCode, savedExitCode, "with a UI the exit code is left alone");

    // Pi sends a prompt whose input handler threw, so a failing notice must not undo the refusal.
    const { ctx } = createMockExtensionContext({ entries: [importEntry] });
    ctx.ui.notify = () => {
      throw new Error("no notice here");
    };
    assert.deepEqual(await input({ type: "input", text: "continue", source: "rpc" }, ctx), { action: "handled" });
  });

  it("lets a prompt through in an ordinary session", async () => {
    const input = await inputHandler();
    const { ctx, notifications } = createMockExtensionContext({ entries: [userEntry] });
    assert.equal(await input({ type: "input", text: "continue", source: "interactive" }, ctx), undefined);
    assert.deepEqual(notifications, []);
  });

  /** Every handler ampi-core registers for `event`, in order (the stub's combined handler drops their results). */
  async function handlersFor(event) {
    const extension = (await importSource("extensions/ampi-core/index.ts")).default;
    const mock = createMockPi();
    const found = [];
    const on = mock.pi.on;
    mock.pi.on = (name, handler) => {
      if (name === event) found.push(handler);
      return on(name, handler);
    };
    extension(mock.pi);
    return found;
  }

  it("blocks a ! command and RPC bash in an imported session by failing, and lets them run in an ordinary one", async () => {
    const [userBash, ...rest] = await handlersFor("user_bash");
    assert.equal(rest.length, 0);
    const event = { type: "user_bash", command: "echo appended", excludeFromContext: false, cwd: "/work" };
    const imported = createMockExtensionContext({ entries: [importEntry, userEntry] });
    // Pi runs no command whose user_bash handler threw, records nothing and shows the error's message.
    assert.throws(() => userBash(event, imported.ctx), (error) => error.message === NOTICE && error.stack === NOTICE);
    const ordinary = createMockExtensionContext({ entries: [userEntry] });
    assert.equal(userBash(event, ordinary.ctx), undefined, "undefined runs the command");
  });

  it("cancels compaction in an imported session with the notice, before any other handler, and leaves an ordinary one alone", async () => {
    const [guard] = await handlersFor("session_before_compact");
    const imported = createMockExtensionContext({ entries: [importEntry, userEntry] });
    // Pi stops at the first handler that cancels, so the thread status never shows a compaction.
    assert.deepEqual(await guard({ type: "session_before_compact", reason: "manual" }, imported.ctx), { cancel: true });
    assert.deepEqual(imported.notifications, [{ message: NOTICE, level: "warning" }]);
    const ordinary = createMockExtensionContext({ entries: [userEntry] });
    assert.equal(await guard({ type: "session_before_compact", reason: "manual" }, ordinary.ctx), undefined);
    assert.deepEqual(ordinary.notifications, []);
  });

  it("writes the notice to stderr and sets exit code 1 without a UI", async () => {
    const { refuseMmrImportedSessionInput } = await importSource("extensions/ampi-core/imported-session.ts");
    const written = [];
    const { ctx, notifications } = createMockExtensionContext({ hasUI: false, entries: [importEntry] });
    assert.equal(refuseMmrImportedSessionInput(ctx, { write: (text) => written.push(text) }), true);
    assert.deepEqual(written, [`ampi: ${NOTICE}\n`]);
    assert.deepEqual(notifications, []);
    assert.equal(process.exitCode, 1);
  });
});

describe("an imported session in Pi's SDK", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-core-imported-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("calls no model and appends no entry when prompted, as RPC and SDK hosts prompt", async () => {
    const cwd = path.join(dir, "project");
    const agentDir = path.join(dir, "agent");
    const writer = SessionManager.create(cwd, path.join(dir, "sessions"));
    writer.appendCustomEntry("ampi-import", { agent: "claude-code", sourceId: "s-1" });
    writer.appendMessage({ role: "user", content: "Fix the parser", timestamp: 1 });
    const file = writer.getSessionFile();

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    faux.setResponses([fauxAssistantMessage("This answer must never be requested.")]);
    const ampiCore = (await importSource("extensions/ampi-core/index.ts")).default;
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      extensionFactories: [(pi) => pi.registerProvider(faux.provider), ampiCore],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.open(file),
      model: faux.getModel(),
    });
    const notices = [];
    await session.bindExtensions({ uiContext: { notify: (message) => notices.push(message) }, mode: "rpc", onError: () => {} });
    // Opening the session records the model and thinking level it runs with; the prompt adds nothing.
    const before = readFileSync(file, "utf8");

    await session.prompt("Carry on with the fix", { source: "rpc" });

    assert.equal(faux.state.callCount, 0, "no model call");
    assert.ok(notices.includes(NOTICE), JSON.stringify(notices));
    assert.equal(readFileSync(file, "utf8"), before, "no entry is appended");
    session.dispose();
  });
});
