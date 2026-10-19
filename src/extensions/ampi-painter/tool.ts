import path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  checkMmrPainterOutputPath,
  MMR_PAINTER_MAX_REFERENCES,
  type MmrPainterStore,
  mmrPainterFormatName,
  mmrPainterNameMatchesFormat,
  readMmrPainterReferences,
  writeMmrPainterOutput,
} from "./files.js";
import { formatMmrPainterModel, type MmrPainterModelChoice, type MmrPainterModelRegistry } from "./model.js";

export const MMR_PAINTER_TOOL_NAME = "painter";

export const PAINTER_PARAMS = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      description: "What to draw, or for an edit what to change and what to keep. Name the style, layout, colours and any text the image must show.",
    }),
    reference_images: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: MMR_PAINTER_MAX_REFERENCES,
        description:
          "Up to 3 image files, relative to the working directory or absolute, that the model edits or takes after. PNG, JPEG, WebP or GIF, 10 MiB each.",
      }),
    ),
    background: Type.Optional(
      Type.Union([Type.Literal("transparent"), Type.Literal("opaque"), Type.Literal("auto")], {
        description: "transparent for a cut-out subject, opaque for a filled background, auto (the default) to leave it to the model.",
      }),
    ),
    output_path: Type.Optional(
      Type.String({
        description:
          "Where to save the image, relative to the working directory and inside it. Its folder must exist and the file must not; leave it out to save under Pi's agent directory.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const PAINTER_DESCRIPTION = `Generate one image from a text prompt, or edit one, with the user's image model. Use it when the user asks for a picture, an illustration, an icon, a logo, a UI mock-up, or a change to an image they point to.

Every call makes exactly one image. reference_images (at most 3 PNG, JPEG, WebP or GIF files of up to 10 MiB each) go to the model with the prompt: it edits them or takes their style, layout or content, as the prompt asks, so say what to keep and what to change. background asks for a transparent or an opaque background; with auto the model decides. How closely the result follows the prompt and the background depends on the model.

The image is saved to output_path when one is given: a new file inside the working directory, in a folder that already exists; painter never overwrites a file. Without output_path it is saved under Pi's agent directory, in data/ampi/painter/<session id>/. The result names the saved file and shows the image.`;

export const PAINTER_PROMPT_SNIPPET = "Generate or edit one image from a prompt, guided by up to three reference images";

export const PAINTER_PROMPT_GUIDELINES = [
  "Use painter when the user asks for an image or an edit of one. Diagrams that read well as text stay text.",
  "painter makes one image per call: for several images, call it once for each. To revise an image painter made, pass its saved path in reference_images.",
  "Set output_path only when the user wants the image in the project, and pick a new file name: painter refuses to replace a file.",
] as const;

/** Added to the prompt for each background choice; `auto` adds nothing. */
export const PAINTER_BACKGROUND_SENTENCES: Readonly<Record<"transparent" | "opaque", string>> = {
  transparent: "Give the image a transparent background: only the subject is drawn, with nothing behind it.",
  opaque: "Give the image a solid, opaque background that fills the whole picture, with no transparent areas.",
};

type PainterParams = Static<typeof PAINTER_PARAMS>;

export interface MmrPainterToolDeps {
  /** Pi's model registry for this call. */
  registry: (ctx: ExtensionContext) => MmrPainterModelRegistry;
  /** Check for the image model again; the answer the tool provider gives from now on. */
  chooseModel: (ctx: ExtensionContext) => Promise<MmrPainterModelChoice>;
  store: MmrPainterStore;
}

/** The text block painter sends: the prompt, then the background sentence. */
export function buildMmrPainterPromptText(prompt: string, background: PainterParams["background"]): string {
  const sentence = background === "transparent" || background === "opaque" ? PAINTER_BACKGROUND_SENTENCES[background] : undefined;
  return sentence ? `${prompt}\n\n${sentence}` : prompt;
}

function cancelled(): Error {
  return new Error("The painter call was cancelled; no image was saved.");
}

export function createMmrPainterTool(deps: MmrPainterToolDeps): ToolDefinition {
  return {
    name: MMR_PAINTER_TOOL_NAME,
    label: MMR_PAINTER_TOOL_NAME,
    description: PAINTER_DESCRIPTION,
    promptSnippet: PAINTER_PROMPT_SNIPPET,
    promptGuidelines: [...PAINTER_PROMPT_GUIDELINES],
    parameters: PAINTER_PARAMS,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as PainterParams;
      const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
      if (prompt === "") throw new Error("prompt must not be empty.");
      const background = params.background ?? "auto";
      if (background !== "transparent" && background !== "opaque" && background !== "auto") {
        throw new Error('background must be "transparent", "opaque" or "auto".');
      }

      // Everything that can refuse the call runs before the model does.
      const references = await readMmrPainterReferences(params.reference_images ?? [], ctx.cwd);
      const outputPath = params.output_path;
      const target = outputPath !== undefined ? await checkMmrPainterOutputPath(outputPath, ctx.cwd) : undefined;
      const choice = await deps.chooseModel(ctx);
      const model = choice.model;
      if (!model) throw new Error(`painter has no image model: ${choice.reason}.`);
      if (signal?.aborted) throw cancelled();

      const input: (TextContent | ImageContent)[] = [{ type: "text", text: buildMmrPainterPromptText(prompt, background) }, ...references];
      const result = await deps.registry(ctx).generateImages(model, { input }, { signal });
      const modelName = formatMmrPainterModel(model);
      if (result.stopReason === "aborted" || signal?.aborted) throw cancelled();
      if (result.stopReason === "error") {
        throw new Error(`${modelName} could not make the image: ${result.errorMessage || "the provider gave no reason"}`);
      }
      const texts = result.output.filter((block): block is TextContent => block.type === "text" && block.text.trim() !== "");
      const image = result.output.find((block): block is ImageContent => block.type === "image");
      if (!image) {
        const said = texts.map((block) => block.text.trim()).join("\n");
        throw new Error(`${modelName} returned no image.${said ? ` It said: ${said}` : ""}`);
      }

      const data = Buffer.from(image.data, "base64");
      let saved: string;
      if (target !== undefined && outputPath !== undefined) {
        // The folder may have changed while the image was made: check again before writing.
        await checkMmrPainterOutputPath(outputPath, ctx.cwd);
        await writeMmrPainterOutput(target, data, outputPath);
        saved = target;
      } else {
        saved = await deps.store.save(ctx.sessionManager.getSessionId(), data, image.mimeType);
      }

      const formatNote = mmrPainterNameMatchesFormat(saved, image.mimeType)
        ? ""
        : ` The image is ${mmrPainterFormatName(image.mimeType)}, although its name ends in "${path.extname(saved) || "no extension"}".`;
      return {
        content: [{ type: "text", text: `Saved the image to ${saved} (made with ${modelName}).${formatNote}` }, image, ...texts],
        details: { path: saved, model: modelName, ...(result.usage ? { usage: result.usage } : {}) },
        // Pi adds a tool result's usage to the session's totals.
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  };
}
