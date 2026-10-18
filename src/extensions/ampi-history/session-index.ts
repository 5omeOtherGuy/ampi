// The session index lives in `ampi-core/session-catalog.ts`. These are the
// names `ampi-history` has always exported for it.
export {
  collectToolCallPaths,
  createMmrSessionIndex as createSessionIndex,
  extractSessionMetadataFromEntries,
  extractTouchedFilesFromEntries,
  normalizeTouchedPath,
} from "../ampi-core/session-catalog.js";
export type {
  MmrSessionIndexOptions as CreateSessionIndexOptions,
  MmrSessionIndex as SessionIndex,
  MmrSessionIndexDeps as SessionIndexDeps,
  MmrSessionMetadata as SessionMetadata,
} from "../ampi-core/session-catalog.js";
