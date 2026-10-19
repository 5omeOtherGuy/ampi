// The `view_media` worker tool (ampi-workers/builtin-workers/view-media.ts).
//
// Pinned here:
//   1. The definition: name, an images-only and always-blocking description,
//      and a `{ paths (1 to 4), objective }` schema without background fields.
//   2. Every refusal (bad parameters, a missing path, a directory, a file
//      that is not an image by content) returns a structured error naming
//      the path as given, and nothing spawns.
//   3. A run goes through the injected runner on the `media` profile with
//      mirrored `--tools read`, a task text carrying the objective and the
//      absolute paths with their detected types, and returns the worker's
//      final answer as the tool result.
//   4. With no image-capable route, the error names the setting to
//      configure and the routes that were tried.
//
// Image files are written from short byte literals into a temporary
// directory: Pi's detector needs only the PNG signature and an IHDR chunk.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const VIEW_MEDIA_MODULE = "extensions/ampi-workers/builtin-workers/view-media.ts";
const PROMPTS_MODULE = "extensions/ampi-workers/profiles/prompts.ts";
const PROMPT_ASSEMBLY_MODULE = "extensions/ampi-core/subagent-prompt-assembly.ts";
const GUIDANCE_MODULE = "extensions/ampi-core/worker-tool-guidance.ts";

// PNG signature, then an IHDR chunk for a 1x1 RGBA image (CRC left zero).
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");

let workDir;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "ampi-view-media-"));
  writeFileSync(path.join(workDir, "dot.png"), PNG_BYTES);
  writeFileSync(path.join(workDir, "shot.txt"), PNG_BYTES);
  writeFileSync(path.join(workDir, "x.png"), PDF_BYTES);
  mkdirSync(path.join(workDir, "screens"));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
  const { registerMmrSubagentsPromptBuilders } = await importSource(PROMPTS_MODULE);
  clearMmrSubagentPromptBuilders();
  registerMmrSubagentsPromptBuilders();
});

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "The dialog says \"Disk full\".",
    truncatedFinalOutput: "The dialog says \"Disk full\".",
    usage: { input: 900, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 2 },
    model: "claude-haiku-4-5",
    stopReason: "stop",
    prompt: "",
    cwd: workDir,
    command: "pi",
    args: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    trail: [],
    ...overrides,
  };
}

function makeRunnerSpy(result = makeWorkerResult()) {
  const calls = [];
  return {
    calls,
    runner: {
      run: async (options) => {
        calls.push(options);
        return result;
      },
    },
  };
}

function makeRegistry(models) {
  return {
    getAll: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
  };
}

const IMAGE_REGISTRY = () =>
  makeRegistry([
    { provider: "openai", id: "gpt-5.4-mini", input: ["text"] },
    { provider: "anthropic", id: "claude-haiku-4-5", input: ["text", "image"] },
  ]);

async function execute(tool, params, registry = IMAGE_REGISTRY()) {
  return tool.execute("call-1", params, undefined, undefined, { cwd: workDir, modelRegistry: registry });
}

describe("view_media tool definition", () => {
  it("declares the name, an images-only blocking description and a paths/objective schema", async () => {
    const { createViewMediaTool, VIEW_MEDIA_TOOL_NAME, VIEW_MEDIA_PROMPT_SNIPPET } = await importSource(VIEW_MEDIA_MODULE);
    assert.equal(VIEW_MEDIA_TOOL_NAME, "view_media");
    const tool = createViewMediaTool();
    assert.equal(tool.name, "view_media");
    assert.equal(tool.promptSnippet, VIEW_MEDIA_PROMPT_SNIPPET);
    assert.match(tool.description, /always blocking/);
    assert.match(tool.description, /cannot run in the background/);
    assert.match(tool.description, /PNG, JPEG, GIF, WebP and BMP/);
    assert.match(tool.description, /WHEN TO USE THIS TOOL/);
    assert.match(tool.description, /WHEN NOT TO USE THIS TOOL/);
    assert.match(tool.description, /PDFs, audio, video/);
    assert.equal(tool.promptGuidelines.length, 1);
    assert.match(tool.promptGuidelines[0], /^Use view_media /);

    const params = tool.parameters;
    assert.deepEqual([...params.required].sort(), ["objective", "paths"]);
    assert.deepEqual(Object.keys(params.properties).sort(), ["objective", "paths"], "no background, group or notify");
    assert.equal(params.properties.paths.type, "array");
    assert.equal(params.properties.paths.minItems, 1);
    assert.equal(params.properties.paths.maxItems, 4);
    assert.equal(params.properties.paths.items.type, "string");
    assert.equal(params.properties.objective.type, "string");
    assert.equal(params.additionalProperties, false);
  });
});

describe("view_media refusals before any worker starts", () => {
  const cases = [
    { label: "no paths", params: { paths: [], objective: "Describe it." }, text: /^view_media: invalid parameters: .*\/paths/ },
    {
      label: "five paths",
      params: { paths: ["dot.png", "dot.png", "dot.png", "dot.png", "dot.png"], objective: "Describe them." },
      text: /^view_media: invalid parameters: .*\/paths/,
    },
    { label: "a blank objective", params: { paths: ["dot.png"], objective: "   " }, text: /^view_media\.objective is required/ },
    { label: "a blank path", params: { paths: ["dot.png", " "], objective: "Describe it." }, text: /^view_media\.paths\[1\] must be a non-empty path\.$/ },
    { label: "an extra field", params: { paths: ["dot.png"], objective: "Describe it.", background: true }, text: /additional properties/i },
    { label: "a missing file", params: { paths: ["missing.png"], objective: "Describe it." }, text: /^view_media: missing\.png does not exist\.$/ },
    { label: "a directory", params: { paths: ["screens"], objective: "Describe it." }, text: /^view_media: screens is a directory, not an image file\.$/ },
    {
      label: "a PDF named x.png",
      params: { paths: ["x.png"], objective: "Describe it." },
      text: /^view_media: x\.png is not an image it can read\. view_media reads images only for now \(PNG, JPEG, GIF, WebP or BMP, judged by content\)/,
    },
    {
      label: "a valid image followed by a PDF",
      params: { paths: ["dot.png", "./x.png"], objective: "Compare them." },
      text: /^view_media: \.\/x\.png is not an image it can read\./,
    },
  ];

  for (const c of cases) {
    it(`refuses ${c.label} with a structured error and spawns nothing`, async () => {
      const { createViewMediaTool } = await importSource(VIEW_MEDIA_MODULE);
      const { runner, calls } = makeRunnerSpy();
      const result = await execute(createViewMediaTool({ runner }), c.params);
      assert.match(result.content[0].text, c.text);
      assert.equal(result.details.status, "validation-error");
      assert.equal(result.details.worker, "ampi-workers.view_media");
      assert.equal(result.details.errorMessage, result.content[0].text);
      assert.equal(calls.length, 0, "the runner must not be invoked");
    });
  }
});

describe("view_media runs", () => {
  it("runs the media profile with mirrored read and the objective plus absolute typed paths", async () => {
    const { createViewMediaTool, buildViewMediaUserPrompt } = await importSource(VIEW_MEDIA_MODULE);
    const { runner, calls } = makeRunnerSpy();
    const tool = createViewMediaTool({ runner, buildSystemPrompt: (cwd) => `media prompt for ${cwd}` });
    // The PNG named shot.txt passes: the content decides, not the name.
    const result = await execute(tool, { paths: ["shot.txt", path.join(workDir, "dot.png")], objective: "  What does the dialog say?  " });

    assert.equal(calls.length, 1);
    const options = calls[0];
    assert.equal(options.profileName, "media");
    assert.deepEqual([...options.tools], ["read"]);
    assert.equal(options.model, "anthropic/claude-haiku-4-5", "the text-only route listed first is skipped");
    assert.equal(options.cwd, workDir);
    assert.equal(options.systemPrompt, `media prompt for ${workDir}`);
    assert.equal(
      options.prompt,
      [
        "Objective: What does the dialog say?",
        "",
        "Images to read (absolute paths, with the type detected from their content):",
        `1. ${path.join(workDir, "shot.txt")} (image/png)`,
        `2. ${path.join(workDir, "dot.png")} (image/png)`,
      ].join("\n"),
    );
    assert.equal(
      buildViewMediaUserPrompt("Q", [{ path: "a.gif", absolutePath: "/w/a.gif", mimeType: "image/gif" }]),
      "Objective: Q\n\nImages to read (absolute paths, with the type detected from their content):\n1. /w/a.gif (image/gif)",
    );

    assert.equal(result.content[0].text, "The dialog says \"Disk full\".");
    assert.equal(result.details.worker, "ampi-workers.view_media");
    assert.equal(result.details.status, "success");
    assert.equal(result.details.objective, "What does the dialog say?");
    assert.deepEqual([...result.details.paths], ["shot.txt", path.join(workDir, "dot.png")]);
    assert.deepEqual(
      result.details.images.map((image) => [image.path, image.mimeType]),
      [["shot.txt", "image/png"], [path.join(workDir, "dot.png"), "image/png"]],
    );
    assert.deepEqual([...result.details.workerTools], ["read"]);
  });

  it("words worker failures for view_media", async () => {
    const { createViewMediaTool } = await importSource(VIEW_MEDIA_MODULE);
    const failures = [
      [{ finalOutput: "", truncatedFinalOutput: "", exitCode: 1, stderr: "boom" }, "view_media: worker exited with code 1.\n\nboom"],
      [{ finalOutput: "", truncatedFinalOutput: "", aborted: true }, "view_media: viewing was cancelled before producing a result."],
      [{ finalOutput: "", truncatedFinalOutput: "" }, "view_media: the worker returned no answer. Try a more specific objective."],
      [{ finalOutput: "", truncatedFinalOutput: "", subagentActivationError: "no route" }, "view_media: subagent activation failed: no route"],
    ];
    for (const [overrides, expected] of failures) {
      const { runner } = makeRunnerSpy(makeWorkerResult(overrides));
      const result = await execute(createViewMediaTool({ runner }), { paths: ["dot.png"], objective: "Describe it." });
      assert.equal(result.content[0].text, expected);
    }
  });

  it("names the media model setting when no route has image input, and spawns nothing", async () => {
    const { createViewMediaTool } = await importSource(VIEW_MEDIA_MODULE);
    const { runner, calls } = makeRunnerSpy();
    const result = await execute(
      createViewMediaTool({ runner, modelPreferences: [{ model: "faux-1", providers: ["faux"] }] }),
      { paths: ["dot.png"], objective: "Describe it." },
      makeRegistry([{ provider: "faux", id: "faux-1", input: ["text"] }]),
    );
    assert.equal(
      result.content[0].text,
      "view_media: no model with image input is available. Set ampiCore.subagentModelPreferences.media to a model that accepts images (/ampi-config can set it). Tried: faux/faux-1: no image input.",
    );
    assert.equal(result.details.status, "activation-error");
    assert.equal(calls.length, 0);
  });
});

describe("view_media prompt and cross-worker wiring", () => {
  it("registers the media prompt builder, which reads every file and quotes text exactly", async () => {
    const { getMmrSubagentPromptBuilder } = await importSource(PROMPT_ASSEMBLY_MODULE);
    const builder = getMmrSubagentPromptBuilder("media");
    assert.equal(typeof builder, "function");
    const prompt = builder({ cwd: "/work" });
    assert.match(prompt, /Read every listed file with the read tool/);
    assert.match(prompt, /Quote visible text exactly/);
    assert.match(prompt, /cannot be read, or does not show what the objective asks about, say so plainly/);
    assert.match(prompt, /only thing the caller sees/);
    assert.match(prompt, /Working directory: \/work/);
  });

  it("joins the Using workers block as a delegation tool without the background paragraphs", async () => {
    const { buildUsingWorkersGuidance, WORKER_BACKGROUND_SELECTION_GUIDANCE } = await importSource(GUIDANCE_MODULE);
    const block = buildUsingWorkersGuidance(["view_media"]);
    assert.ok(block, "view_media alone renders the Using workers block");
    assert.match(block, /Do not start a worker/);
    assert.ok(!block.includes(WORKER_BACKGROUND_SELECTION_GUIDANCE));
    assert.doesNotMatch(block, /background: true/);
  });
});
