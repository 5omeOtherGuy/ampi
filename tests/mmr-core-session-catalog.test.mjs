import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const CATALOG_MODULE = "extensions/ampi-core/session-catalog.ts";

function writeSession(cwd, userText) {
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: userText, timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `Answer to ${userText}` }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 2,
  });
  return { id: manager.getSessionId(), path: manager.getSessionFile() };
}

describe("ampi-core session catalogue: Pi session source", () => {
  let agentDir;
  let previousAgentDir;

  beforeEach(() => {
    agentDir = mkdtempSync(path.join(os.tmpdir(), "ampi-session-catalog-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("lists sessions from every project cwd and opens one by path", async () => {
    const { createMmrPiSessionSource } = await importSource(CATALOG_MODULE);
    const alpha = writeSession(path.join(agentDir, "work", "alpha"), "plan the alpha release");
    const beta = writeSession(path.join(agentDir, "work", "beta"), "fix the beta parser");

    const source = createMmrPiSessionSource();
    const sessions = await source.listSessions();

    assert.deepEqual(sessions.map((session) => session.id).sort(), [alpha.id, beta.id].sort());
    const listedBeta = sessions.find((session) => session.id === beta.id);
    assert.equal(listedBeta.cwd, path.join(agentDir, "work", "beta"));
    assert.equal(listedBeta.firstMessage, "fix the beta parser");

    const entries = source.openSession(alpha.path).getEntries();
    const userTexts = entries
      .filter((entry) => entry.type === "message" && entry.message.role === "user")
      .map((entry) => entry.message.content);
    assert.deepEqual(userTexts, ["plan the alpha release"]);
  });

  it("lists one workspace's sessions or every session, in Pi's default layout and in a custom session directory", async () => {
    const { listMmrSessionsInScope } = await importSource(CATALOG_MODULE);
    const alphaCwd = path.join(agentDir, "work", "alpha");
    const alpha = writeSession(alphaCwd, "plan the alpha release");
    const beta = writeSession(path.join(agentDir, "work", "beta"), "fix the beta parser");
    const ids = async (manager, scope) => (await listMmrSessionsInScope(manager, scope)).map((session) => session.id).sort();

    const inAlpha = { getCwd: () => alphaCwd, getSessionDir: () => path.dirname(alpha.path) };
    assert.deepEqual(await ids(inAlpha, "workspace"), [alpha.id]);
    assert.deepEqual(await ids(inAlpha, "all"), [alpha.id, beta.id].sort());

    // A custom directory holds every workspace's sessions side by side; `all` lists that directory only.
    const custom = path.join(agentDir, "custom-sessions");
    const gamma = SessionManager.create(alphaCwd, custom);
    gamma.appendMessage({ role: "user", content: "gamma", timestamp: 1 });
    const delta = SessionManager.create(path.join(agentDir, "work", "delta"), custom);
    delta.appendMessage({ role: "user", content: "delta", timestamp: 1 });
    const inCustom = { getCwd: () => alphaCwd, getSessionDir: () => custom };
    assert.deepEqual(await ids(inCustom, "workspace"), [gamma.getSessionId()]);
    assert.deepEqual(await ids(inCustom, "all"), [gamma.getSessionId(), delta.getSessionId()].sort());
  });

  it("returns an empty list when no session has been written", async () => {
    const { createMmrPiSessionSource } = await importSource(CATALOG_MODULE);
    assert.deepEqual(await createMmrPiSessionSource().listSessions(), []);
  });

  it("resolves a written session by id prefix through the source", async () => {
    const { createMmrPiSessionSource, resolveMmrSessionById } = await importSource(CATALOG_MODULE);
    const written = writeSession(path.join(agentDir, "work", "gamma"), "gamma notes");

    const resolved = await resolveMmrSessionById(createMmrPiSessionSource(), `@${written.id.slice(0, 8)}`);

    assert.ok(resolved);
    assert.equal(resolved.info.id, written.id);
    assert.equal(resolved.ambiguous, false);
  });
});

describe("ampi-core session catalogue: package root", () => {
  it("keeps the ampi-history names bound to the core catalogue", async () => {
    const root = await importSource("index.ts");
    assert.equal(typeof root.createMmrPiSessionSource, "function");
    assert.equal(typeof root.dedupeMmrSessionsById, "function");
    assert.equal(root.createSessionIndex, root.createMmrSessionIndex);
    assert.equal(root.resolveSessionById, root.resolveMmrSessionById);
  });
});
