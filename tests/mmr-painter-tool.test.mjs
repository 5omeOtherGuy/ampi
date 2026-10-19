// ampi-painter: settings, model choice and gating, reference images, the
// prompt sent to the image model, saving and the result. The image model is a
// fake registry; files live in temporary directories; the clock is injected.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const PIXEL_PATH = path.resolve(import.meta.dirname, "fixtures/ampi-painter/pixel.png");
const PIXEL = readFileSync(PIXEL_PATH);
const TEN_MIB = 10 * 1024 * 1024;
// 2026-10-19 08:30:00.005 UTC
const NOW = Date.UTC(2026, 9, 19, 8, 30, 0, 5);
const STAMP = "2026-10-19T08-30-00-005Z";

const TRANSPARENT = "Give the image a transparent background: only the subject is drawn, with nothing behind it.";
const OPAQUE = "Give the image a solid, opaque background that fills the whole picture, with no transparent areas.";

async function importRuntime() {
  return import(pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/ampi-core/runtime.ts")).href);
}

function imageModel(provider, id) {
  return {
    type: "image",
    id,
    name: id,
    api: `${provider}-images`,
    provider,
    baseUrl: "http://127.0.0.1:9",
    input: ["text", "image"],
    output: ["image", "text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

const USAGE = {
  input: 12,
  output: 1290,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1302,
  cost: { input: 0.001, output: 0.039, cacheRead: 0, cacheWrite: 0, total: 0.04 },
};

/**
 * A stand-in for Pi's model registry. `available` is what has credentials,
 * `known` adds models Pi knows without credentials, `answer(model, context,
 * options)` makes the result.
 */
function fakeRegistry({ available = [], known = [], answer } = {}) {
  const calls = [];
  const registry = {
    available,
    async getAvailableOfType(type) {
      assert.equal(type, "image");
      return registry.available;
    },
    getModelOfType(type, provider, id) {
      assert.equal(type, "image");
      return [...registry.available, ...known].find((model) => model.provider === provider && model.id === id);
    },
    async generateImages(model, context, options) {
      calls.push({ model, context, options });
      if (answer) return answer(model, context, options);
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [{ type: "image", data: PIXEL.toString("base64"), mimeType: "image/png" }],
        stopReason: "stop",
        timestamp: NOW,
      };
    },
  };
  return { registry, calls };
}

let root;
let cwd;
let dataDir;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "ampi-painter-test-"));
  cwd = path.join(root, "project");
  dataDir = path.join(root, "agent", "data", "ampi", "painter");
  mkdirSync(cwd, { recursive: true });
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
  runtime.setMmrSubagentState(undefined);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Load ampi-painter into a mocked Pi; `start()` runs its session_start, `call()` the tool. */
async function load({ enabled = true, model, registry = fakeRegistry({ available: [imageModel("fakeimg", "img-1")] }).registry, sessionId = "session-1" } = {}) {
  const { createMmrPainterExtension } = await importSource("extensions/ampi-painter/index.ts");
  const { pi, tools, handlers } = createMockPi();
  createMmrPainterExtension({
    loadSettings: () => ({ enabled, ...(model ? { model } : {}) }),
    modelRegistry: () => registry,
    store: { baseDir: dataDir, now: () => NOW, randomId: () => "r" },
  })(pi);
  const { ctx } = createMockExtensionContext({ cwd, sessionId });
  const start = () => handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  const call = (params, signal) => tools.get("painter").execute("painter-call", params, signal, undefined, ctx);
  return { pi, tools, handlers, start, call };
}

async function painterDecision() {
  const runtime = await importRuntime();
  return runtime.getMmrToolRegistry().resolve(["painter"], ["painter"]).decisions[0];
}

const text = (result) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

function writeSettings(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

describe("ampi-painter settings", () => {
  it("is off with no model unless a settings file or the environment turns it on", async () => {
    const { loadMmrPainterSettings } = await importSource("extensions/ampi-painter/config.ts");
    const home = path.join(root, "home");
    assert.deepEqual(loadMmrPainterSettings(cwd, { homeDirectory: home, env: {} }), { enabled: false });

    writeSettings(path.join(home, ".pi/agent/settings.json"), {
      ampiPainter: { enabled: true, model: "openrouter/google/gemini-2.5-flash-image" },
    });
    assert.deepEqual(loadMmrPainterSettings(cwd, { homeDirectory: home, env: {} }), {
      enabled: true,
      model: "openrouter/google/gemini-2.5-flash-image",
    });

    // The project's nested form wins over the user's flat form.
    writeSettings(path.join(cwd, ".pi/settings.json"), { ampi: { painter: { enabled: false, model: "fakeimg/img-2" } } });
    assert.deepEqual(loadMmrPainterSettings(cwd, { homeDirectory: home, env: {} }), { enabled: false, model: "fakeimg/img-2" });

    // The environment wins over both files; the legacy name counts when the new one is unset.
    assert.equal(loadMmrPainterSettings(cwd, { homeDirectory: home, env: { AMPI_PAINTER_ENABLE: "1" } }).enabled, true);
    assert.equal(loadMmrPainterSettings(cwd, { homeDirectory: home, env: { MMR_PAINTER_ENABLE: "1" } }).enabled, true);
    assert.equal(
      loadMmrPainterSettings(cwd, { homeDirectory: home, env: { AMPI_PAINTER_ENABLE: "0", MMR_PAINTER_ENABLE: "1" } }).enabled,
      false,
    );
  });

  it("splits ampiPainter.model at the first slash only", async () => {
    const { parseMmrPainterModelRef } = await importSource("extensions/ampi-painter/config.ts");
    assert.deepEqual(parseMmrPainterModelRef("openrouter/google/gemini-2.5-flash-image"), {
      provider: "openrouter",
      id: "google/gemini-2.5-flash-image",
    });
    assert.deepEqual(parseMmrPainterModelRef("fakeimg/img-1"), { provider: "fakeimg", id: "img-1" });
    for (const bad of ["img-1", "/img-1", "fakeimg/", ""]) assert.equal(parseMmrPainterModelRef(bad), undefined, bad);
  });
});

describe("ampi-painter model choice and gating", () => {
  it("uses the configured model over one that sorts first", async () => {
    const { registry, calls } = fakeRegistry({
      available: [imageModel("openrouter", "google/gemini-2.5-flash-image"), imageModel("aaa", "first")],
    });
    const { start, call } = await load({ model: "openrouter/google/gemini-2.5-flash-image", registry });
    await start();
    const decision = await painterDecision();
    assert.equal(decision.status, "active");
    assert.equal(decision.owner, "ampi-painter");
    const runtime = await importRuntime();
    assert.equal(
      runtime.resolveMmrFeatureGates(["mmr-painter"])[0].reason,
      "painter uses openrouter/google/gemini-2.5-flash-image, set in ampiPainter.model",
    );
    await call({ prompt: "a red square" });
    assert.equal(calls[0].model.provider, "openrouter");
    assert.equal(calls[0].model.id, "google/gemini-2.5-flash-image");
  });

  it("gates on a configured model without credentials and never falls back to another", async () => {
    const { registry, calls } = fakeRegistry({
      available: [imageModel("fakeimg", "img-1")],
      known: [imageModel("openrouter", "google/gemini-2.5-flash-image")],
    });
    const { start, call } = await load({ model: "openrouter/google/gemini-2.5-flash-image", registry });
    await start();
    const reason = 'ampiPainter.model "openrouter/google/gemini-2.5-flash-image" is not usable: its provider has no working credentials';
    const decision = await painterDecision();
    assert.equal(decision.status, "gated");
    assert.equal(decision.diagnostic, `painter: gated behind ampi-painter (${reason})`);
    await assert.rejects(call({ prompt: "a red square" }), { message: `painter has no image model: ${reason}.` });
    assert.equal(calls.length, 0);
  });

  it("names a configured model Pi does not know", async () => {
    const { start } = await load({ model: "fakeimg/img-9" });
    await start();
    assert.match((await painterDecision()).diagnostic, /ampiPainter\.model "fakeimg\/img-9" is not an image model Pi knows/);
  });

  it("picks the first usable model by provider, then id, whatever order the registry lists them in", async () => {
    const { registry, calls } = fakeRegistry({
      available: [imageModel("openrouter", "a-model"), imageModel("fakeimg", "zeta"), imageModel("fakeimg", "beta")],
    });
    const { start, call } = await load({ registry });
    await start();
    const runtime = await importRuntime();
    const [gate] = runtime.resolveMmrFeatureGates(["ampi-painter"]);
    assert.deepEqual(gate, {
      gate: "ampi-painter",
      status: "enabled",
      reason: "painter uses fakeimg/beta, the first usable image model; ampiPainter.model chooses another",
      source: "ampi-painter",
    });
    await call({ prompt: "a red square" });
    assert.equal(`${calls[0].model.provider}/${calls[0].model.id}`, "fakeimg/beta");
  });

  it("gates with a reason naming ampiPainter.model when no image model is usable, and says so on a call", async () => {
    const { registry, calls } = fakeRegistry({ available: [imageModel("fakeimg", "img-1")] });
    const { start, call } = await load({ registry });
    await start();
    assert.equal((await painterDecision()).status, "active");
    // The credentials went away after session start: the call checks again.
    registry.available = [];
    const reason =
      "no image model is usable: sign in to a provider with image models, such as OpenRouter, or set ampiPainter.model to provider/id";
    await assert.rejects(call({ prompt: "a red square" }), { message: `painter has no image model: ${reason}.` });
    assert.equal(calls.length, 0);
    assert.equal((await painterDecision()).diagnostic, `painter: gated behind ampi-painter (${reason})`);
  });

  it("registers no tool and gates painter with the feature-gate reason while off", async () => {
    const { tools, handlers } = await load({ enabled: false });
    assert.equal(tools.size, 0);
    assert.equal(handlers.size, 0);
    const reason = "ampi-painter is off (set ampiPainter.enabled: true or AMPI_PAINTER_ENABLE=1, then restart Pi)";
    assert.equal((await painterDecision()).diagnostic, `painter: gated behind ampi-painter (${reason})`);
    const runtime = await importRuntime();
    const gates = runtime.resolveMmrFeatureGates(["ampi-painter", "mmr-painter", "ampi-painter.extra"]);
    assert.deepEqual(
      gates.map(({ gate, status, source }) => ({ gate, status, source })),
      [
        { gate: "ampi-painter", status: "disabled", source: "ampi-painter" },
        { gate: "mmr-painter", status: "disabled", source: "ampi-painter" },
        { gate: "ampi-painter.extra", status: "missing", source: "ampi-core.unknown" },
      ],
    );
    assert.equal(gates[0].reason, reason);
  });
});

describe("ampi-painter with ampi-core: the first turn's tools", () => {
  const CODEX_SOL = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 400000 };
  let previousHome;
  let previousAgentDir;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = path.join(root, "home");
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  /** ampi-core, then ampi-painter, on one Pi with an event bus; returns the tools set last and the status text. */
  async function startSession(available) {
    const core = (await importSource("extensions/ampi-core/index.ts")).default;
    const { createMmrPainterExtension } = await importSource("extensions/ampi-painter/index.ts");
    const { formatMmrStatus } = await importSource("extensions/ampi-core/status.ts");
    const runtime = await importRuntime();
    const { pi, calls, handlers } = createMockPi({ allTools: ["read", "bash", "write", "apply_patch", "painter"].map((name) => ({ name })) });
    const listeners = new Map();
    pi.events = {
      emit: (name, data) => {
        for (const listener of [...(listeners.get(name) ?? [])]) listener(data);
      },
      on: (name, listener) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
        return () => {};
      },
    };
    const { registry } = fakeRegistry({ available });
    core(pi);
    createMmrPainterExtension({ loadSettings: () => ({ enabled: true }), modelRegistry: () => registry, store: { baseDir: dataDir } })(pi);
    const { ctx } = createMockExtensionContext({ cwd, models: [CODEX_SOL], authenticated: true });
    // Pi runs the handlers in load order, each awaited: ampi-core applies the mode first.
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    const state = runtime.getMmrModeState();
    return { active: calls.setActiveTools.at(-1), state, status: formatMmrStatus(state) };
  }

  it("makes painter active before the first turn once the image model is found", async () => {
    const { active, state, status } = await startSession([imageModel("fakeimg", "img-1")]);
    assert.equal(state.mode, "medium");
    assert.ok(active.includes("painter"), active.join(", "));
    assert.ok(state.activeTools.includes("painter"));
    assert.equal(state.gatedTools.includes("painter"), false);
    assert.match(
      status,
      /^ {2}- ampi-painter: enabled via ampi-painter \(painter uses fakeimg\/img-1, the first usable image model; ampiPainter\.model chooses another\)$/m,
    );
  });

  it("applies an answer that changes while a mode is being applied once the apply ends", async () => {
    const core = (await importSource("extensions/ampi-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, calls, handlers } = createMockPi({ allTools: ["read", "bash", "write", "apply_patch", "painter"].map((name) => ({ name })) });
    const listeners = new Map();
    pi.events = {
      emit: (name, data) => {
        for (const listener of [...(listeners.get(name) ?? [])]) listener(data);
      },
      on: (name, listener) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
        return () => {};
      },
    };
    let ready = false;
    runtime.registerMmrToolProvider({
      name: "test-painter",
      resolve: (name) => (name === "painter" ? (ready ? { kind: "active" } : { kind: "gated", gate: "ampi-painter", reason: "not yet" }) : undefined),
    });
    // The answer changes right after ampi-core set the mode's tools, before its apply ends.
    const setActiveTools = pi.setActiveTools;
    pi.setActiveTools = (tools) => {
      setActiveTools(tools);
      if (!ready) {
        ready = true;
        runtime.notifyMmrToolRulesChanged(pi);
      }
    };
    core(pi);
    const { ctx } = createMockExtensionContext({ cwd, models: [CODEX_SOL], authenticated: true });
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(calls.setActiveTools.length, 2);
    assert.equal(calls.setActiveTools[0].includes("painter"), false);
    assert.equal(calls.setActiveTools[1].includes("painter"), true);
    assert.ok(runtime.getMmrModeState().activeTools.includes("painter"));
  });

  it("keeps painter gated when no image model is usable", async () => {
    const { active, state, status } = await startSession([]);
    assert.equal(active.includes("painter"), false);
    assert.deepEqual(state.gatedTools, ["painter"]);
    assert.match(status, /^Gated tools: painter$/m);
    assert.match(status, /painter: gated behind ampi-painter \(no image model is usable: .*ampiPainter\.model/);
  });
});

describe("ampi-painter reference images", () => {
  function file(name, bytes) {
    const target = path.join(cwd, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return name;
  }

  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
  const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
  function bmp() {
    const header = Buffer.alloc(58);
    header.write("BM", 0, "latin1");
    header.writeUInt32LE(58, 2);
    header.writeUInt32LE(54, 10);
    header.writeUInt32LE(40, 14);
    header.writeInt32LE(1, 18);
    header.writeInt32LE(1, 22);
    header.writeUInt16LE(1, 26);
    header.writeUInt16LE(24, 28);
    return header;
  }

  it("takes zero to three references and refuses a fourth before calling the model", async () => {
    const { registry, calls } = fakeRegistry({ available: [imageModel("fakeimg", "img-1")] });
    const { call } = await load({ registry });
    const refs = ["a.png", "b.png", "c.png", "d.png"].map((name) => file(name, PIXEL));
    for (let count = 0; count <= 3; count += 1) {
      await call({ prompt: "a red square", reference_images: refs.slice(0, count) });
      assert.equal(calls.at(-1).context.input.length, 1 + count);
    }
    await assert.rejects(call({ prompt: "a red square", reference_images: refs }), {
      message: "reference_images takes at most 3 images; this call gave 4.",
    });
    assert.equal(calls.length, 4);
  });

  it("takes a reference of exactly 10 MiB and refuses one byte more", async () => {
    const { registry, calls } = fakeRegistry({ available: [imageModel("fakeimg", "img-1")] });
    const { call } = await load({ registry });
    const exact = file("exact.png", PIXEL);
    truncateSync(path.join(cwd, exact), TEN_MIB);
    const over = file("over.png", PIXEL);
    truncateSync(path.join(cwd, over), TEN_MIB + 1);
    await call({ prompt: "x", reference_images: [exact] });
    assert.equal(Buffer.from(calls[0].context.input[1].data, "base64").length, TEN_MIB);
    await assert.rejects(call({ prompt: "x", reference_images: [over] }), {
      message: "Reference image over.png is 10485761 bytes; the limit is 10 MiB (10485760 bytes).",
    });
    assert.equal(calls.length, 1);
  });

  it("takes PNG, JPEG, WebP and GIF by content and sends them in order after the prompt", async () => {
    const { registry, calls } = fakeRegistry({ available: [imageModel("fakeimg", "img-1")] });
    const { call } = await load({ registry });
    // The names say nothing true about the formats.
    const refs = [file("one.gif", WEBP), file("two.bin", JPEG), file("three", GIF)];
    await call({ prompt: "combine these", reference_images: refs });
    await call({ prompt: "and this", reference_images: [file("four.jpg", PIXEL)] });
    assert.deepEqual(
      calls[0].context.input.map((block) => (block.type === "text" ? "text" : block.mimeType)),
      ["text", "image/webp", "image/jpeg", "image/gif"],
    );
    assert.equal(calls[0].context.input[2].data, JPEG.toString("base64"));
    assert.equal(calls[1].context.input[1].mimeType, "image/png");
    assert.equal(calls[1].context.input[1].data, PIXEL.toString("base64"));
  });

  it("refuses a BMP, a text file named x.png and a missing file, naming each", async () => {
    const { registry, calls } = fakeRegistry({ available: [imageModel("fakeimg", "img-1")] });
    const { call } = await load({ registry });
    const picture = file("picture.bmp", bmp());
    assert.equal(await detectSupportedImageMimeTypeFromFile(path.join(cwd, picture)), "image/bmp", "Pi knows the BMP");
    const textFile = file("x.png", "not an image\n");
    const rule = "is not a PNG, JPEG, WebP or GIF image (painter goes by the file's content, not its name).";
    await assert.rejects(call({ prompt: "x", reference_images: [picture] }), { message: `Reference image picture.bmp ${rule}` });
    await assert.rejects(call({ prompt: "x", reference_images: [textFile] }), { message: `Reference image x.png ${rule}` });
    await assert.rejects(call({ prompt: "x", reference_images: ["missing.png"] }), {
      message: "Reference image missing.png does not exist.",
    });
    assert.equal(calls.length, 0);
  });
});

describe("ampi-painter prompt", () => {
  it("adds the background sentence for transparent and opaque, and nothing for auto", async () => {
    const { registry, calls } = fakeRegistry({ available: [imageModel("fakeimg", "img-1")] });
    const { call } = await load({ registry });
    await call({ prompt: "a fox", background: "transparent" });
    await call({ prompt: "a fox", background: "opaque" });
    await call({ prompt: "a fox", background: "auto" });
    await call({ prompt: "a fox" });
    assert.deepEqual(
      calls.map((entry) => entry.context.input),
      [
        [{ type: "text", text: `a fox\n\n${TRANSPARENT}` }],
        [{ type: "text", text: `a fox\n\n${OPAQUE}` }],
        [{ type: "text", text: "a fox" }],
        [{ type: "text", text: "a fox" }],
      ],
    );
  });

  it("refuses an empty prompt", async () => {
    const { registry, calls } = fakeRegistry({ available: [imageModel("fakeimg", "img-1")] });
    const { call } = await load({ registry });
    await assert.rejects(call({ prompt: "  " }), { message: "prompt must not be empty." });
    assert.equal(calls.length, 0);
  });
});

describe("ampi-painter saving", () => {
  it("saves to the session's folder in the data directory, numbering the images from 1", async () => {
    const { call } = await load({ sessionId: "session-1" });
    const first = await call({ prompt: "one" });
    const second = await call({ prompt: "two" });
    const folder = path.join(dataDir, "session-1");
    assert.equal(first.details.path, path.join(folder, `${STAMP}-1.png`));
    assert.equal(second.details.path, path.join(folder, `${STAMP}-2.png`));
    assert.deepEqual(readdirSync(folder).sort(), [`${STAMP}-1.png`, `${STAMP}-2.png`], "no temporary file is left");
    assert.deepEqual(readFileSync(first.details.path), PIXEL);
    assert.deepEqual(readFileSync(second.details.path), PIXEL);
  });

  it("saves to output_path inside the working directory", async () => {
    mkdirSync(path.join(cwd, "out"));
    const { call } = await load();
    const result = await call({ prompt: "a red square", output_path: "out/sq.png" });
    const target = path.join(cwd, "out/sq.png");
    assert.equal(result.details.path, target);
    assert.deepEqual(readFileSync(target), PIXEL);
    assert.equal(existsSync(dataDir), false, "nothing goes to the data directory");
  });

  it("refuses an existing file and an existing symlink at output_path and leaves both alone", async () => {
    const { registry, calls } = fakeRegistry({ available: [imageModel("fakeimg", "img-1")] });
    const { call } = await load({ registry });
    writeFileSync(path.join(cwd, "taken.png"), "keep me");
    writeFileSync(path.join(root, "elsewhere.txt"), "keep me too");
    symlinkSync(path.join(root, "elsewhere.txt"), path.join(cwd, "link.png"));
    symlinkSync(path.join(root, "nowhere.png"), path.join(cwd, "dangling.png"));
    for (const name of ["taken.png", "link.png", "dangling.png"]) {
      await assert.rejects(call({ prompt: "x", output_path: name }), {
        message: `output_path ${name} already exists; painter never overwrites a file.`,
      });
    }
    assert.equal(readFileSync(path.join(cwd, "taken.png"), "utf8"), "keep me");
    assert.equal(readFileSync(path.join(root, "elsewhere.txt"), "utf8"), "keep me too");
    assert.equal(existsSync(path.join(root, "nowhere.png")), false);
    assert.equal(calls.length, 0);
  });

  it("refuses a path outside the working directory, through a symlinked folder too, and a missing folder", async () => {
    const { registry, calls } = fakeRegistry({ available: [imageModel("fakeimg", "img-1")] });
    const { call } = await load({ registry });
    mkdirSync(path.join(root, "outside"));
    symlinkSync(path.join(root, "outside"), path.join(cwd, "escape"));
    const outside = (given) => `output_path ${given} is outside the working directory ${cwd}; painter saves only inside it.`;
    await assert.rejects(call({ prompt: "x", output_path: "../x.png" }), { message: outside("../x.png") });
    await assert.rejects(call({ prompt: "x", output_path: "escape/x.png" }), { message: outside("escape/x.png") });
    await assert.rejects(call({ prompt: "x", output_path: "escape/deeper/x.png" }), { message: outside("escape/deeper/x.png") });
    await assert.rejects(call({ prompt: "x", output_path: "missing/x.png" }), {
      message: `output_path missing/x.png: the folder ${path.join(cwd, "missing")} does not exist; painter does not create folders.`,
    });
    assert.deepEqual(readdirSync(path.join(root, "outside")), []);
    assert.equal(existsSync(path.join(root, "x.png")), false);
    assert.equal(calls.length, 0);
  });

  it("keeps the given name when the format differs and says which format it is", async () => {
    const { registry } = fakeRegistry({
      available: [imageModel("fakeimg", "img-1")],
      answer: (model) => ({
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [{ type: "image", data: PIXEL.toString("base64"), mimeType: "image/webp" }],
        stopReason: "stop",
        timestamp: NOW,
      }),
    });
    const { call } = await load({ registry });
    const result = await call({ prompt: "x", output_path: "art.png" });
    assert.equal(result.details.path, path.join(cwd, "art.png"));
    assert.match(text(result), /The image is WebP, although its name ends in "\.png"\./);
    const unnamed = await call({ prompt: "x" });
    assert.equal(path.extname(unnamed.details.path), ".webp");
  });
});

describe("ampi-painter result", () => {
  it("names the saved file and the model, then shows the image and the model's own text", async () => {
    const { registry } = fakeRegistry({
      available: [imageModel("fakeimg", "img-1")],
      answer: (model) => ({
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [
          { type: "text", text: "Here is your square." },
          { type: "image", data: PIXEL.toString("base64"), mimeType: "image/png" },
          { type: "image", data: "aWdub3JlZA==", mimeType: "image/png" },
          { type: "text", text: "A second note." },
        ],
        usage: USAGE,
        stopReason: "stop",
        timestamp: NOW,
      }),
    });
    const { call } = await load({ registry });
    const result = await call({ prompt: "a red square" });
    const saved = path.join(dataDir, "session-1", `${STAMP}-1.png`);
    assert.deepEqual(result.content, [
      { type: "text", text: `Saved the image to ${saved} (made with fakeimg/img-1).` },
      { type: "image", data: PIXEL.toString("base64"), mimeType: "image/png" },
      { type: "text", text: "Here is your square." },
      { type: "text", text: "A second note." },
    ]);
    assert.deepEqual(result.details, { path: saved, model: "fakeimg/img-1", usage: USAGE });
    assert.deepEqual(result.usage, USAGE, "the image's cost counts toward the session's");
    assert.equal(result.isError, undefined);
  });
});

describe("ampi-painter failures", () => {
  function answering(result) {
    return fakeRegistry({
      available: [imageModel("fakeimg", "img-1")],
      answer: (model, _context, options) => ({ api: model.api, provider: model.provider, model: model.id, output: [], timestamp: NOW, ...result(options) }),
    });
  }

  it("turns a provider error into a tool error with its message and saves nothing", async () => {
    const { registry } = answering(() => ({ stopReason: "error", errorMessage: "402 Payment Required: out of credits" }));
    const { call } = await load({ registry });
    await assert.rejects(call({ prompt: "x" }), { message: "fakeimg/img-1 could not make the image: 402 Payment Required: out of credits" });
    assert.equal(existsSync(dataDir), false);
  });

  it("passes the tool's abort signal to the model and reports a cancelled call", async () => {
    const seen = [];
    const { registry } = answering((options) => {
      seen.push(options?.signal);
      return { stopReason: "aborted", errorMessage: "Request was aborted" };
    });
    const { call } = await load({ registry });
    const controller = new AbortController();
    await assert.rejects(call({ prompt: "x" }, controller.signal), { message: "The painter call was cancelled; no image was saved." });
    assert.equal(seen[0], controller.signal);
    assert.equal(existsSync(dataDir), false);
  });

  it("reports a result without an image, with whatever the model said", async () => {
    const { registry } = answering(() => ({ stopReason: "stop", output: [{ type: "text", text: "I cannot draw that." }] }));
    const { call } = await load({ registry });
    await assert.rejects(call({ prompt: "x" }), { message: "fakeimg/img-1 returned no image. It said: I cannot draw that." });
    assert.equal(existsSync(dataDir), false);
  });
});
