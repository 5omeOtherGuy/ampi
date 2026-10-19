import type { AssistantImages, ImageApi, ImageModel, ImagesContext } from "@earendil-works/pi-ai";
import { type MmrPainterSettings, parseMmrPainterModelRef } from "./config.js";

export type MmrPainterImageModel = ImageModel<ImageApi>;

/** The part of Pi's model registry (`ctx.modelRegistry`) painter uses. */
export interface MmrPainterModelRegistry {
  getAvailableOfType(type: "image"): Promise<readonly MmrPainterImageModel[]>;
  getModelOfType(type: "image", provider: string, modelId: string): MmrPainterImageModel | undefined;
  generateImages(model: MmrPainterImageModel, context: ImagesContext, options?: { signal?: AbortSignal }): Promise<AssistantImages>;
}

/** The outcome of a model check: the model painter uses, or why there is none. */
export interface MmrPainterModelChoice {
  model?: MmrPainterImageModel;
  /** Shown in `/ampi-status`; for no model, also the tool error. */
  reason: string;
}

/** Before the first check, which runs at session start. */
export const MMR_PAINTER_UNCHECKED: Readonly<MmrPainterModelChoice> = Object.freeze({
  reason: "ampi-painter looks for an image model when the session starts",
});

export function formatMmrPainterModel(model: Pick<MmrPainterImageModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function byProviderThenId(a: MmrPainterImageModel, b: MmrPainterImageModel): number {
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Choose painter's image model. With `ampiPainter.model` set, that model,
 * if Pi knows it and lists it among the image models whose provider has
 * working credentials; otherwise none, never another model. Without the
 * setting, the first usable image model by provider, then id.
 */
export async function selectMmrPainterModel(
  registry: MmrPainterModelRegistry,
  settings: Pick<MmrPainterSettings, "model">,
): Promise<MmrPainterModelChoice> {
  let available: readonly MmrPainterImageModel[];
  try {
    available = await registry.getAvailableOfType("image");
  } catch (error) {
    return { reason: `ampi-painter could not list image models: ${error instanceof Error ? error.message : String(error)}` };
  }

  const configured = settings.model;
  if (configured !== undefined) {
    const ref = parseMmrPainterModelRef(configured);
    if (!ref) return { reason: `ampiPainter.model "${configured}" is not a provider/id pair` };
    const model = registry.getModelOfType("image", ref.provider, ref.id);
    if (!model) return { reason: `ampiPainter.model "${configured}" is not an image model Pi knows` };
    if (!available.some((entry) => entry.provider === model.provider && entry.id === model.id)) {
      return { reason: `ampiPainter.model "${configured}" is not usable: its provider has no working credentials` };
    }
    return { model, reason: `painter uses ${formatMmrPainterModel(model)}, set in ampiPainter.model` };
  }

  const [first] = [...available].sort(byProviderThenId);
  if (!first) {
    return {
      reason:
        "no image model is usable: sign in to a provider with image models, such as OpenRouter, or set ampiPainter.model to provider/id",
    };
  }
  return {
    model: first,
    reason: `painter uses ${formatMmrPainterModel(first)}, the first usable image model; ampiPainter.model chooses another`,
  };
}

export function sameMmrPainterChoice(a: MmrPainterModelChoice, b: MmrPainterModelChoice): boolean {
  const left = a.model ? formatMmrPainterModel(a.model) : undefined;
  const right = b.model ? formatMmrPainterModel(b.model) : undefined;
  return left === right && a.reason === b.reason;
}
