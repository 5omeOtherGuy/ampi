// The session builder every SDK user of the `ampi` command shares
// (packages/ampi-cli/src/sdk-session.js), run against the installed Pi with
// this checkout's ampi in a temporary home and agent directory. A Pi upgrade
// that changes how the builder hands Pi its extensions fails here instead of
// in every `ampi app` worker.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { AMPI_GUI_HOST_GLOBAL_KEY, registerAmpiGuiHost } from "../packages/ampi-cli/src/app-worker.js";
import { createAmpiSdkSession } from "../packages/ampi-cli/src/sdk-session.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const TOKEN = ["sdk", "session", "token"].join("-");

/** The status of GET / on a fresh connection, or the connection error's code. */
function status(port) {
  return new Promise((resolve) => {
    request({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    })
      .on("error", (error) => resolve(error.code))
      .end();
  });
}

describe("ampi SDK session", () => {
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME, offline: process.env.PI_OFFLINE, cwd: process.cwd() };
  const dir = mkdtempSync(path.join(tmpdir(), "ampi-cli-sdk-session-"));
  const project = path.join(dir, "project");

  before(() => {
    process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
    process.env.HOME = path.join(dir, "home");
    process.env.PI_OFFLINE = "1";
    mkdirSync(project, { recursive: true });
    mkdirSync(process.env.HOME, { recursive: true });
    // As the worker does: ampi's extensions read settings relative to the working directory.
    process.chdir(project);
  });

  after(() => {
    process.chdir(saved.cwd);
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", saved.agentDir],
      ["HOME", saved.home],
      ["PI_OFFLINE", saved.offline],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete globalThis[AMPI_GUI_HOST_GLOBAL_KEY];
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads ampi and Pi's codemode, tool_search and MCP built-ins, serves the hosted GUI, and closes it on dispose", async () => {
    const ports = [];
    registerAmpiGuiHost({ token: TOKEN, ownerPid: process.pid, ready: (info) => ports.push(info.port) });
    const runtime = await createAmpiSdkSession({ cwd: project, sessionManager: pi.SessionManager.inMemory(project), mode: "rpc", connectMcp: true, pi });
    try {
      const loaded = runtime.services.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
      assert.ok(loaded.includes(path.join(repoRoot, "src", "extensions", "ampi-core", "index.ts")), loaded.join("\n"));
      assert.ok(loaded.includes(path.join(repoRoot, "src", "extensions", "ampi-gui", "index.ts")), loaded.join("\n"));
      for (const builtin of ["builtin:codemode", "builtin:tool-search", "builtin:mcp"]) assert.ok(loaded.includes(builtin), builtin);
      assert.deepEqual(
        runtime.diagnostics.filter((diagnostic) => diagnostic.type === "error"),
        [],
      );

      // ampi-gui saw RPC mode with the host registered: it started and reported its port once.
      assert.equal(ports.length, 1);
      assert.equal(await status(ports[0]), 401, "the GUI answers and wants the token");
    } finally {
      await runtime.dispose();
    }
    assert.equal(await status(ports[0]), "ECONNREFUSED", "dispose closes the GUI server");
  });
});
