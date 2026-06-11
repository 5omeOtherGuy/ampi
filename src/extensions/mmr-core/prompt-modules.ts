/**
 * Compatibility shim. The shared tool guidance and coding-guidance fragments
 * now live in `prompt-content.ts`, the single authoring file for all static
 * MMR prompt prose.
 */
export {
  SHARED_TOOL_GUIDANCE,
  SHARED_CODING_GUIDANCE_FRAGMENT_IDS,
  SHARED_CODING_GUIDANCE_FRAGMENTS,
  SHARED_CODING_GUIDANCE,
  type SharedCodingGuidanceFragmentId,
} from "./prompt-content.js";
