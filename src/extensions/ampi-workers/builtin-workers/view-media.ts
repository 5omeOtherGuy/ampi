import { stat } from "node:fs/promises";
import path from "node:path";
import {
  detectSupportedImageMimeTypeFromFile,
  type AgentToolResult,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { checkMmrToolParams } from "../../ampi-core/tool-params.js";
import { registerAmpiOwnedTool } from "../../ampi-core/owned-tools.js";
import {
  assembleMmrSubagentSurface,
  getMmrSubagentPromptBuilder,
  registerMmrSubagentPromptBuilder,
  unregisterMmrSubagentPromptBuilder,
} from "../../ampi-core/subagent-prompt-assembly.js";
import {
  expandMmrModelPreferencesToStrings,
  getMmrSubagentProfile,
} from "../../ampi-core/subagent-profiles.js";
import {
  resolveMmrSubagentInvocation,
  type MmrSubagentInvocation,
} from "../../ampi-core/subagent-resolver.js";
import { loadMmrCoreSettings, type LoadedMmrCoreSettings } from "../../ampi-core/settings.js";
import type { MmrModelCandidateResolution, MmrModelPreference } from "../../ampi-core/types.js";
import type { MmrSubagentDetailsStatus } from "../../ampi-core/worker-outcome.js";
import { buildMediaWorkerSystemPrompt as buildMediaWorkerSystemPromptFromPrompts } from "../profiles/prompts.js";
import { resolveEffectiveRunner } from "../framework/worker-fallback-run.js";
import {
  clipMmrWorkerDescription,
  createWorkerRunPreparer,
  createWorkerTool,
  resolveWorkerModelPreferencesOverride,
  type MmrBlockingWorkerRunPreparer,
  type MmrWorkerToolFactoryDeps,
  type MmrWorkerToolResolveInput,
  type MmrWorkerToolRunContext,
  type MmrWorkerToolSpec,
} from "../framework/worker-tool-factory.js";
import { resolveWorkerCwd } from "../framework/worker-host.js";
import {
  resolveCtxMmrModelRegistry,
  resolveMmrWorkerModelContextWindowFromCtx,
} from "../worker-model-metadata.js";
import {
  classifyMmrWorkerOutcomeForProfile,
  emptyMmrWorkerUsageStats,
  type MmrSpawnedSubagentWorkerDetailsBase,
  type MmrWorkerResult,
} from "../framework/runner.js";
import {
  buildSpawnedFinalDetailsBase,
  buildSpawnedProgressDetailsBase,
} from "../worker-result-shaping.js";

export const VIEW_MEDIA_TOOL_NAME = "view_media";

export const VIEW_MEDIA_SUBAGENT_PROFILE = "media";

/** Most files one call may hand to the worker. */
export const VIEW_MEDIA_MAX_PATHS = 4;

/** The setting that picks the worker's routes; `/ampi-config` writes it. */
export const VIEW_MEDIA_MODEL_PREFERENCES_SETTING = "ampiCore.subagentModelPreferences.media";

function requireMediaProfile() {
  const profile = getMmrSubagentProfile(VIEW_MEDIA_SUBAGENT_PROFILE);
  if (!profile) {
    throw new Error(
      `ampi-core does not expose a "${VIEW_MEDIA_SUBAGENT_PROFILE}" subagent profile; view_media cannot run without it.`,
    );
  }
  return profile;
}

/**
 * Worker tool allowlist passed through `pi --tools` to the media child:
 * Pi's `read` alone, which sends image files to the model as attachments.
 *
 * Source of truth: the `media` subagent profile in ampi-core. This export
 * is a derived constant for callers and tests; the profile remains
 * authoritative at runtime.
 */
export const VIEW_MEDIA_WORKER_TOOLS: readonly string[] = Object.freeze([
  ...requireMediaProfile().tools,
]);

/**
 * The `media` profile's routes as `provider/id` and bare-id strings, for
 * display and tests. The resolver reads the profile itself and also drops
 * every route whose model has no image input.
 */
export const VIEW_MEDIA_DEFAULT_MODEL_PREFERENCES: readonly string[] = Object.freeze([
  ...expandMmrModelPreferencesToStrings(requireMediaProfile().modelPreferences),
]);

export const VIEW_MEDIA_PROMPT_SNIPPET =
  "Have a worker on an image-capable model look at image files and answer a question about them";

/**
 * Single routing guideline for Pi's `<rules>` section. The full when/how
 * guidance lives only in {@link VIEW_MEDIA_DESCRIPTION}; cross-worker policy
 * renders once in the `## Using workers` block
 * (`ampi-core/worker-tool-guidance.ts`).
 */
export const VIEW_MEDIA_PROMPT_GUIDELINES: readonly string[] = [
  "Use view_media to learn what image files show (screenshots, diagrams, photos) when you cannot see images yourself or need only an answer about them: pass the paths and an objective that says what to report.",
];

export const VIEW_MEDIA_DESCRIPTION = [
  "Look at one to four image files through a worker on a model that accepts images, and get back a text answer to an objective. The worker reads the files itself; you receive only its answer.",
  "",
  "view_media is always blocking: it returns the answer inline and cannot run in the background.",
  "",
  "Images only for now: PNG, JPEG, GIF, WebP and BMP, recognised by their content rather than their file name. Other files are refused before any worker starts.",
  "",
  "WHEN TO USE THIS TOOL:",
  "- Your model cannot see images, and you need to know what a screenshot, diagram, chart or photo shows",
  "- You need only a description of an image or an answer about it, not the image itself in your context",
  "- You want two or more images compared (before and after screenshots, two versions of a diagram)",
  "",
  "WHEN NOT TO USE THIS TOOL:",
  "- For text files, source code, logs or data files: use read",
  "- For PDFs, audio, video or other non-image files: they are refused",
  "- For an image you can already see in the conversation",
  "",
  "USAGE GUIDELINES:",
  "1. Write the objective as a question or task the worker can finish and stop on.",
  "   ✓ \"Quote the error message in the dialog and name the button that is highlighted.\"",
  "   ✗ \"Look at this.\"",
  "2. Name the details you need: exact text, colours, layout, values in a chart, differences between images.",
  "3. Say what to report when it is not there, for example \"say if no error is visible\".",
  "4. Pass all images for one question in one call, so the worker can compare them.",
].join("\n");

export const VIEW_MEDIA_PARAMETERS_SCHEMA = Type.Object(
  {
    paths: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: VIEW_MEDIA_MAX_PATHS,
      description:
        "One to four image files to look at, each relative to the working directory or absolute. PNG, JPEG, GIF, WebP or BMP, recognised by content.",
    }),
    objective: Type.String({
      description:
        "What the worker should find out from the images or describe, written so it knows when it is done (e.g. \"Quote the error text in the dialog\" or \"List what differs between the two screenshots\").",
    }),
  },
  { additionalProperties: false },
);

export const viewMediaParameters = VIEW_MEDIA_PARAMETERS_SCHEMA;

export type ViewMediaParams = Static<typeof VIEW_MEDIA_PARAMETERS_SCHEMA>;

/** One file that passed the content check. */
export interface ViewMediaImage {
  /** The path as the caller gave it. */
  path: string;
  absolutePath: string;
  /** The image type Pi detected from the file's content. */
  mimeType: string;
}

export interface ViewMediaDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: "ampi-workers.view_media";
  status?: MmrSubagentDetailsStatus;
  objective: string;
  /** The paths as the caller gave them. */
  paths: readonly string[];
  /** The checked images with their detected types; absent when a path was refused. */
  images?: readonly ViewMediaImage[];
}

/** Compact status shown to the model while the worker runs. */
export const VIEW_MEDIA_PROGRESS_PLACEHOLDER = "view_media: looking at the images…";

/**
 * Build the media worker system prompt. Re-exported for callers of this
 * module; the canonical owner is `ampi-workers/profiles/prompts.ts`, which
 * also registers the builder against ampi-core's prompt-assembly registry.
 */
export function buildMediaWorkerSystemPrompt(cwd: string): string {
  return buildMediaWorkerSystemPromptFromPrompts(cwd);
}

/** The worker's task text: the objective, then each image with its detected type. */
export function buildViewMediaUserPrompt(objective: string, images: readonly ViewMediaImage[]): string {
  return [
    `Objective: ${objective}`,
    "",
    "Images to read (absolute paths, with the type detected from their content):",
    ...images.map((image, index) => `${index + 1}. ${image.absolutePath} (${image.mimeType})`),
  ].join("\n");
}

function coerceViewMediaParams(raw: unknown): ViewMediaParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("view_media expects an object with `paths` and `objective` fields.");
  }
  const params = checkMmrToolParams(VIEW_MEDIA_TOOL_NAME, VIEW_MEDIA_PARAMETERS_SCHEMA, raw);
  const objective = params.objective.trim();
  if (objective.length === 0) {
    throw new Error("view_media.objective is required and must be a non-empty string.");
  }
  const blank = params.paths.findIndex((entry) => entry.trim().length === 0);
  if (blank >= 0) {
    throw new Error(`view_media.paths[${blank}] must be a non-empty path.`);
  }
  return { paths: [...params.paths], objective };
}

const IMAGES_ONLY_NOTE =
  "view_media reads images only for now (PNG, JPEG, GIF, WebP or BMP, judged by content); PDF, audio, video and other files are not supported.";

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Check each path in order before anything spawns: it must exist, be a
 * regular file and hold an image Pi recognises by content (the file name is
 * never consulted). The first path that fails ends the check with a message
 * naming it as given.
 */
export async function inspectViewMediaPaths(
  paths: readonly string[],
  cwd: string,
): Promise<{ ok: true; images: ViewMediaImage[] } | { ok: false; message: string }> {
  const images: ViewMediaImage[] = [];
  for (const given of paths) {
    const absolutePath = path.resolve(cwd, given);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolutePath);
    } catch (err) {
      if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") {
        return { ok: false, message: `view_media: ${given} does not exist.` };
      }
      return { ok: false, message: `view_media: could not read ${given}: ${errorText(err)}` };
    }
    if (info.isDirectory()) {
      return { ok: false, message: `view_media: ${given} is a directory, not an image file.` };
    }
    if (!info.isFile()) {
      return { ok: false, message: `view_media: ${given} is not a regular file.` };
    }
    let mimeType: string | null;
    try {
      mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
    } catch (err) {
      return { ok: false, message: `view_media: could not read ${given}: ${errorText(err)}` };
    }
    if (!mimeType) {
      return { ok: false, message: `view_media: ${given} is not an image it can read. ${IMAGES_ONLY_NOTE}` };
    }
    images.push({ path: given, absolutePath, mimeType });
  }
  return { ok: true, images };
}

export interface ViewMediaToolDeps extends MmrWorkerToolFactoryDeps {
  /**
   * Override the ordered worker-model preferences. Wins over the
   * settings-driven `subagentModelPreferences.media` block and the profile
   * defaults; the resolver still skips routes without image input.
   */
  modelPreferences?: readonly MmrModelPreference[];
  /** Settings-driven override; loses to {@link ViewMediaToolDeps.modelPreferences}. */
  subagentModelPreferencesOverride?: readonly MmrModelPreference[];
  /**
   * Settings loader seam. Defaults to `loadMmrCoreSettings(cwd)`, read on
   * every call so a `/ampi-config` change applies to the next one.
   */
  loadSubagentModelPreferences?: (cwd: string) =>
    | Pick<LoadedMmrCoreSettings["settings"], "subagentModelPreferences">
    | undefined;
  /** Override prompt text while still flowing through the subagent surface API. */
  buildSystemPrompt?: (cwd: string) => string;
}

interface ViewMediaDetailsContext {
  objective: string;
  paths: readonly string[];
  images?: readonly ViewMediaImage[];
  cwd: string;
  workerTools: readonly string[];
}

function makeFailureResult(
  ctx: ViewMediaDetailsContext,
  failure: {
    status: MmrSubagentDetailsStatus;
    content: string;
    errorMessage: string;
    subagentActivationError?: string;
    spawnError?: string;
    resolvedModel?: string;
  },
): AgentToolResult<ViewMediaDetails> {
  const details: ViewMediaDetails = {
    worker: "ampi-workers.view_media",
    status: failure.status,
    objective: ctx.objective,
    paths: ctx.paths,
    ...(ctx.images !== undefined ? { images: ctx.images } : {}),
    exitCode: null,
    signal: null,
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    usage: emptyMmrWorkerUsageStats(),
    stderr: "",
    command: "",
    args: [],
    cwd: ctx.cwd,
    workerTools: ctx.workerTools,
    trail: [],
    errorMessage: failure.errorMessage,
    ...(failure.subagentActivationError !== undefined
      ? { subagentActivationError: failure.subagentActivationError }
      : {}),
    ...(failure.spawnError !== undefined ? { spawnError: failure.spawnError } : {}),
    ...(failure.resolvedModel !== undefined ? { model: failure.resolvedModel } : {}),
  };
  return { content: [{ type: "text", text: failure.content }], details };
}

function rawField(raw: unknown, key: string): unknown {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
}

function paramsFailureResult(message: string, raw: unknown, cwd: string): AgentToolResult<ViewMediaDetails> {
  const objective = rawField(raw, "objective");
  const paths = rawField(raw, "paths");
  return makeFailureResult(
    {
      objective: typeof objective === "string" ? objective.trim() : "",
      paths: Array.isArray(paths) ? paths.filter((entry): entry is string => typeof entry === "string") : [],
      cwd,
      workerTools: VIEW_MEDIA_WORKER_TOOLS,
    },
    { status: "validation-error", content: message, errorMessage: message },
  );
}

function describeTriedRoutes(candidates: readonly MmrModelCandidateResolution[]): string {
  return candidates
    .map((candidate) => `${candidate.provider}/${candidate.model}: ${candidate.reason ?? (candidate.registered ? "registered" : "not registered")}`)
    .join("; ");
}

/**
 * The error for a call whose invocation did not resolve. With no route, it
 * names the setting to configure and then the routes that were tried.
 */
export function describeViewMediaResolutionFailure(invocation: MmrSubagentInvocation & { ok: false }): string {
  if (invocation.code !== "model.no-route") {
    return `view_media: could not prepare the image worker: ${invocation.message}`;
  }
  const tried = invocation.candidates.length > 0
    ? `Tried: ${describeTriedRoutes(invocation.candidates)}.`
    : invocation.message;
  return `view_media: no model with image input is available. Set ${VIEW_MEDIA_MODEL_PREFERENCES_SETTING} to a model that accepts images (/ampi-config can set it). ${tried}`;
}

function buildFinalContent(result: MmrWorkerResult): string {
  // Failure precedence comes from the shared outcome classifier under the
  // media profile's nonzero-exit policy, as in finder.
  const outcome = classifyMmrWorkerOutcomeForProfile(result, requireMediaProfile());
  if (outcome === "spawn-error") {
    const reason = result.spawnError ?? result.errorMessage ?? "unknown spawn error";
    return `view_media: worker spawn failed: ${reason}`;
  }
  if (outcome === "activation-error") {
    return `view_media: subagent activation failed: ${result.subagentActivationError}`;
  }
  if (outcome === "aborted") {
    return "view_media: viewing was cancelled before producing a result.";
  }
  if (outcome === "worker-error") {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detailText = tail.length > 0 ? tail : (result.errorMessage ?? "");
    const detail = detailText.length > 0 ? `\n\n${detailText}` : "";
    return `view_media: worker exited with code ${result.exitCode ?? "null"}.${detail}`;
  }
  if (outcome === "no-agent-start") {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    const detail = tail.length > 0 ? `\n\n${tail}` : "";
    return `view_media: worker exited before the agent loop started. The images were not shown to the worker model; another Pi extension's input handler likely consumed the prompt. Check stderr for extension diagnostics.${detail}`;
  }
  if (outcome === "success") {
    return result.truncatedFinalOutput || result.finalOutput;
  }
  // empty-output
  if (result.errorMessage && result.errorMessage.length > 0) {
    return `view_media: worker reported an error: ${result.errorMessage}`;
  }
  return "view_media: the worker returned no answer. Try a more specific objective.";
}

function assembleMediaSystemPrompt(
  cwd: string,
  buildSystemPrompt: ((cwd: string) => string) | undefined,
): string {
  const profile = requireMediaProfile();
  if (!buildSystemPrompt) {
    return assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd,
    }).systemPrompt;
  }

  const previous = getMmrSubagentPromptBuilder(profile.promptBuilder);
  registerMmrSubagentPromptBuilder(profile.promptBuilder, ({ cwd: builderCwd }) => buildSystemPrompt(builderCwd));
  try {
    return assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd,
    }).systemPrompt;
  } finally {
    if (previous) registerMmrSubagentPromptBuilder(profile.promptBuilder, previous);
    else unregisterMmrSubagentPromptBuilder(profile.promptBuilder);
  }
}

/**
 * Parent-side invocation: the shared resolver against `ctx.modelRegistry`,
 * which honours the profile's `requiredInput`. Without a registry it
 * reports `model.no-route`; the tool fails closed on either.
 */
function resolveViewMediaInvocation(input: MmrWorkerToolResolveInput): MmrSubagentInvocation {
  const profile = requireMediaProfile();
  const registry = resolveCtxMmrModelRegistry(input.ctx);
  if (!registry) {
    return {
      ok: false,
      profile,
      code: "model.no-route",
      message: "view_media could not resolve a model registry from the extension context; expected ctx.modelRegistry to expose getAll/find.",
      tools: profile.tools,
      promptRoute: profile.promptRoute,
      candidates: [],
      diagnostics: [],
      workerTools: [],
      toolResolution: {
        intendedTools: [...profile.tools],
        deniedTools: profile.denyTools ?? [],
        omittedTools: [],
      },
    };
  }
  return resolveMmrSubagentInvocation({
    profile,
    registry,
    ...(input.registeredTools !== undefined ? { registeredTools: input.registeredTools } : {}),
    ...(input.modelPreferencesOverride !== undefined
      ? { modelPreferencesOverride: input.modelPreferencesOverride }
      : {}),
  });
}

type ViewMediaRunContext = MmrWorkerToolRunContext<ViewMediaParams, readonly ViewMediaImage[]>;

function detailsContextOf(runCtx: ViewMediaRunContext): ViewMediaDetailsContext {
  return {
    objective: runCtx.params.objective,
    paths: runCtx.params.paths,
    images: runCtx.runData,
    cwd: runCtx.cwd,
    workerTools: runCtx.workerTools,
  };
}

/**
 * The spec for one call, whose images already passed the content check:
 * they are the run data the worker's task text lists.
 */
function viewMediaToolBlueprint(deps: ViewMediaToolDeps, images: readonly ViewMediaImage[]): {
  spec: MmrWorkerToolSpec<ViewMediaParams, ViewMediaDetails, readonly ViewMediaImage[]>;
  factoryOptions: Parameters<typeof createWorkerRunPreparer<ViewMediaParams, ViewMediaDetails, readonly ViewMediaImage[]>>[2];
} {
  const effectiveRunner = resolveEffectiveRunner(deps, "createViewMediaTool");
  return {
    spec: {
      toolName: VIEW_MEDIA_TOOL_NAME,
      profileName: VIEW_MEDIA_SUBAGENT_PROFILE,
      description: VIEW_MEDIA_DESCRIPTION,
      promptSnippet: VIEW_MEDIA_PROMPT_SNIPPET,
      promptGuidelines: VIEW_MEDIA_PROMPT_GUIDELINES,
      parameters: viewMediaParameters,
      progressPlaceholder: VIEW_MEDIA_PROGRESS_PLACEHOLDER,
      // The `strict-delegated` contract: structured parameter failures,
      // fail-closed resolution, mirrored worker tools, invocation tools in
      // details and structured run errors, so an unusable route never
      // spawns a child that would only fail.
      coerceParams: coerceViewMediaParams,
      paramsFailure: paramsFailureResult,
      computeRunData: () => images,
      resolveInvocation: (input) => resolveViewMediaInvocation(input),
      resolutionFailure: "fail-closed",
      resolutionFailureResult: (invocation, params, cwd) => {
        const content = describeViewMediaResolutionFailure(invocation);
        return makeFailureResult(
          {
            objective: params.objective,
            paths: params.paths,
            images,
            cwd,
            workerTools: invocation.workerTools.length > 0 ? invocation.workerTools : VIEW_MEDIA_WORKER_TOOLS,
          },
          { status: "activation-error", content, errorMessage: content, subagentActivationError: content },
        );
      },
      mirrorWorkerTools: true,
      detailsWorkerTools: "invocation",
      workerToolsConstant: VIEW_MEDIA_WORKER_TOOLS,
      progressModelBinding: "initial",
      buildUserPrompt: (params, runData) => buildViewMediaUserPrompt(params.objective, runData),
      assembleSystemPrompt: (cwd) => assembleMediaSystemPrompt(cwd, deps.buildSystemPrompt),
      resolveContextWindow: (ctx, model) => resolveMmrWorkerModelContextWindowFromCtx(ctx, model),
      candidatePreferences: () => requireMediaProfile().modelPreferences,
      buildProgressDetails: (snapshot, runCtx) => {
        const base = buildSpawnedProgressDetailsBase({
          snapshot,
          cwd: runCtx.cwd,
          workerTools: runCtx.workerTools,
          ...(runCtx.resolvedModel !== undefined ? { resolvedModel: runCtx.resolvedModel } : {}),
          ...(runCtx.contextWindow !== undefined ? { contextWindow: runCtx.contextWindow } : {}),
        });
        return {
          worker: "ampi-workers.view_media",
          objective: runCtx.params.objective,
          paths: runCtx.params.paths,
          images: runCtx.runData,
          ...base,
        };
      },
      buildFinalDetails: (result, runCtx) => {
        const base = buildSpawnedFinalDetailsBase({
          result,
          cwd: runCtx.cwd,
          workerTools: runCtx.workerTools,
          ...(runCtx.resolvedModel !== undefined ? { resolvedModel: runCtx.resolvedModel } : {}),
          ...(runCtx.contextWindow !== undefined ? { contextWindow: runCtx.contextWindow } : {}),
        });
        const status = classifyMmrWorkerOutcomeForProfile(result, requireMediaProfile());
        return {
          worker: "ampi-workers.view_media",
          status,
          objective: runCtx.params.objective,
          paths: runCtx.params.paths,
          images: runCtx.runData,
          ...base,
        };
      },
      buildFinalContent: (result) => buildFinalContent(result),
      mapRunError: (err, runCtx) => {
        const message = errorText(err);
        return makeFailureResult(detailsContextOf(runCtx), {
          status: "spawn-error",
          content: `view_media: worker spawn failed: ${message}`,
          errorMessage: message,
          spawnError: message,
          ...(runCtx.resolvedModel !== undefined ? { resolvedModel: runCtx.resolvedModel } : {}),
        });
      },
      describeRun: (params) => ({
        description: `view_media: ${clipMmrWorkerDescription(params.objective)}`,
        displayPrompt: params.objective,
      }),
    },
    factoryOptions: {
      effectiveRunner,
      resolveModelPreferencesOverride: (cwd) =>
        resolveWorkerModelPreferencesOverride({
          profileName: VIEW_MEDIA_SUBAGENT_PROFILE,
          cwd,
          ...(deps.modelPreferences !== undefined ? { explicit: deps.modelPreferences } : {}),
          ...(deps.subagentModelPreferencesOverride !== undefined
            ? { settingsOverride: deps.subagentModelPreferencesOverride }
            : {}),
          loadSettings: (loadCwd) =>
            (deps.loadSubagentModelPreferences
              ? deps.loadSubagentModelPreferences(loadCwd)
              : loadMmrCoreSettings(loadCwd).settings
            )?.subagentModelPreferences,
        }),
    },
  };
}

/**
 * The blocking call's preparer. The content check reads the files, and Pi
 * exports only the async detector, so it runs here, before the factory's
 * synchronous preparer is built for the checked images. Nothing is
 * registered or spawned when a parameter or a path fails.
 */
function createViewMediaCallPreparer(deps: ViewMediaToolDeps): MmrBlockingWorkerRunPreparer<ViewMediaDetails> {
  return async (rawParams, ctx, opts) => {
    const cwd = resolveWorkerCwd(ctx);
    let params: ViewMediaParams;
    try {
      params = coerceViewMediaParams(rawParams);
    } catch (err) {
      return { ok: false, result: paramsFailureResult(errorText(err), rawParams, cwd) };
    }
    const inspected = await inspectViewMediaPaths(params.paths, cwd);
    if (!inspected.ok) {
      return {
        ok: false,
        result: makeFailureResult(
          { objective: params.objective, paths: params.paths, cwd, workerTools: VIEW_MEDIA_WORKER_TOOLS },
          { status: "validation-error", content: inspected.message, errorMessage: inspected.message },
        ),
      };
    }
    const { spec, factoryOptions } = viewMediaToolBlueprint(deps, inspected.images);
    return createWorkerRunPreparer(spec, deps, factoryOptions)(rawParams, ctx, opts);
  };
}

export function createViewMediaTool(deps: ViewMediaToolDeps = {}): ToolDefinition {
  // The definition's metadata and renderers come from a spec without images;
  // every call runs through the preparer above, which builds its own.
  const { spec, factoryOptions } = viewMediaToolBlueprint(deps, []);
  return createWorkerTool(spec, deps, { ...factoryOptions, prepareRun: createViewMediaCallPreparer(deps) });
}

/**
 * Register the view_media Pi tool on the supplied extension API and record
 * it as ampi-owned so Free mode strips it like every other ampi-authored tool.
 */
export function registerViewMediaTool(pi: ExtensionAPI, deps: ViewMediaToolDeps = {}): ToolDefinition {
  const definition = createViewMediaTool({ ...deps, pi });
  registerAmpiOwnedTool(VIEW_MEDIA_TOOL_NAME);
  pi.registerTool(definition);
  return definition;
}
