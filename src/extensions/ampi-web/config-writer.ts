import { isRecord } from "../ampi-core/internal/json.js";
import { rewriteJsonSettingsFile } from "../ampi-core/internal/settings-file.js";
import { isMmrWebBackend, type MmrWebBackend } from "./config.js";

/**
 * Sentinel used in update payloads to mean "remove this field from the
 * settings file" so the loader falls back to its default. The plain absence
 * of a field in `MmrWebConfigUpdate` means "do not touch this field".
 */
export type ClearSentinel = "clear";

/**
 * Update payload accepted by {@link applyMmrWebConfigUpdate} and
 * {@link writeMmrWebConfigFile}.
 *
 * Each field, when present, either writes the new value or clears it via
 * the {@link ClearSentinel}. Omitted fields are not touched. API keys
 * (`braveApiKey`, plus legacy key-shaped fields) are intentionally NOT part
 * of this surface: they are env-only secrets and must never be persisted to a
 * settings file that may be committed or synced.
 */
export interface MmrWebConfigUpdate {
  enabled?: boolean | ClearSentinel;
  backend?: MmrWebBackend | ClearSentinel;
  searchBackend?: MmrWebBackend | ClearSentinel;
  readerBackend?: MmrWebBackend | ClearSentinel;
  searxngUrl?: string | ClearSentinel;
  searxngManaged?: boolean | ClearSentinel;
  searxngHealthUrl?: string | ClearSentinel;
  searxngIdleTimeoutMs?: number | ClearSentinel;
  searxngStartTimeoutMs?: number | ClearSentinel;
  searchTimeoutMs?: number | ClearSentinel;
  readTimeoutMs?: number | ClearSentinel;
  maxResultBytes?: number | ClearSentinel;
  // `searxngStartCommand` and `searxngStopCommand` are intentionally NOT
  // part of this update surface. They spawn arbitrary processes and must
  // come from a settings file the user edited directly, not from any
  // interactive editor that an extension could surface.
}

interface FieldSpec {
  /** Settings-file key. */
  key: keyof MmrWebConfigUpdate;
  /** Field kind for validation. */
  kind: "boolean" | "backend" | "positive-int" | "non-negative-int" | "http-url";
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { key: "enabled", kind: "boolean" },
  { key: "backend", kind: "backend" },
  { key: "searchBackend", kind: "backend" },
  { key: "readerBackend", kind: "backend" },
  { key: "searxngUrl", kind: "http-url" },
  { key: "searxngManaged", kind: "boolean" },
  { key: "searxngHealthUrl", kind: "http-url" },
  { key: "searxngIdleTimeoutMs", kind: "non-negative-int" },
  { key: "searxngStartTimeoutMs", kind: "positive-int" },
  { key: "searchTimeoutMs", kind: "positive-int" },
  { key: "readTimeoutMs", kind: "positive-int" },
  { key: "maxResultBytes", kind: "positive-int" },
];

function isClear(value: unknown): value is ClearSentinel {
  return value === "clear";
}

function validateValue(field: FieldSpec, raw: unknown): unknown {
  if (isClear(raw)) return undefined; // marker for delete
  switch (field.kind) {
    case "boolean": {
      if (typeof raw !== "boolean") {
        throw new Error(`Invalid mmrWeb.${field.key}: expected boolean, got ${typeof raw}.`);
      }
      return raw;
    }
    case "backend": {
      if (!isMmrWebBackend(raw)) {
        throw new Error(`Invalid mmrWeb.${field.key}: expected "auto" | "brave" | "searxng" | "duckduckgo", got ${JSON.stringify(raw)}.`);
      }
      return raw;
    }
    case "positive-int": {
      if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
        throw new Error(`Invalid mmrWeb.${field.key}: expected a positive integer, got ${JSON.stringify(raw)}.`);
      }
      return raw;
    }
    case "non-negative-int": {
      if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
        throw new Error(`Invalid mmrWeb.${field.key}: expected a non-negative integer, got ${JSON.stringify(raw)}.`);
      }
      return raw;
    }
    case "http-url": {
      if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new Error(`Invalid mmrWeb.${field.key}: expected a http(s) URL string, got ${JSON.stringify(raw)}.`);
      }
      const trimmed = raw.trim();
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new Error(`Invalid mmrWeb.${field.key}: ${JSON.stringify(raw)} is not a valid URL.`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Invalid mmrWeb.${field.key}: only http(s) URLs are allowed, got scheme ${parsed.protocol}.`);
      }
      return trimmed;
    }
  }
}

/**
 * Apply a {@link MmrWebConfigUpdate} to a parsed settings JSON value and
 * return a new settings object. The input is not mutated; unrelated keys
 * (including `ampiCore` / `mmrCore`) are preserved.
 *
 * `ampiWeb`, nested `ampi.web`, and legacy `mmrWeb` / `mmr.web` shapes are
 * supported. The writer keeps an existing recognized layout; when all are
 * absent it defaults to the flat `ampiWeb` block.
 */
export function applyMmrWebConfigUpdate(
  existing: unknown,
  update: MmrWebConfigUpdate,
): Record<string, unknown> {
  const root: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};

  const flatAmpiWeb = isRecord(root.ampiWeb) ? { ...root.ampiWeb } : undefined;
  const ampiBlock = isRecord(root.ampi) ? { ...root.ampi } : undefined;
  const nestedAmpiWeb = ampiBlock && isRecord(ampiBlock.web) ? { ...ampiBlock.web } : undefined;

  const flatMmrWeb = isRecord(root.mmrWeb) ? { ...root.mmrWeb } : undefined;
  const mmrBlock = isRecord(root.mmr) ? { ...root.mmr } : undefined;
  const nestedMmrWeb = mmrBlock && isRecord(mmrBlock.web) ? { ...mmrBlock.web } : undefined;

  const target = flatAmpiWeb
    ? { kind: "flat" as const, flatKey: "ampiWeb", web: flatAmpiWeb }
    : nestedAmpiWeb
      ? { kind: "nested" as const, rootKey: "ampi", block: ampiBlock ?? {}, web: nestedAmpiWeb }
      : flatMmrWeb
        ? { kind: "flat" as const, flatKey: "mmrWeb", web: flatMmrWeb }
        : nestedMmrWeb
          ? { kind: "nested" as const, rootKey: "mmr", block: mmrBlock ?? {}, web: nestedMmrWeb }
          : { kind: "flat" as const, flatKey: "ampiWeb", web: {} };
  const web: Record<string, unknown> = target.web;

  for (const spec of FIELD_SPECS) {
    if (!(spec.key in update)) continue;
    const raw = update[spec.key];
    const validated = validateValue(spec, raw);
    if (validated === undefined) {
      delete web[spec.key];
    } else {
      web[spec.key] = validated;
    }
  }

  if (target.kind === "nested") {
    const nextBlock = { ...target.block };
    if (Object.keys(web).length === 0) {
      delete nextBlock.web;
    } else {
      nextBlock.web = web;
    }
    if (Object.keys(nextBlock).length === 0) {
      delete root[target.rootKey];
    } else {
      root[target.rootKey] = nextBlock;
    }
  } else {
    if (Object.keys(web).length === 0) {
      delete root[target.flatKey];
    } else {
      root[target.flatKey] = web;
    }
  }

  return root;
}

/**
 * Atomically rewrite a Pi settings file with the given config update
 * applied. Returns the resolved file path. Creates the parent directory if
 * needed.
 *
 * The file is rewritten with 2-space JSON indentation; if the file did not
 * exist, only the keys touched by `update` are present. Refuses to
 * overwrite a file whose existing contents are not valid JSON.
 */
export function writeMmrWebConfigFile(filePath: string, update: MmrWebConfigUpdate): string {
  return rewriteJsonSettingsFile(filePath, (existing) => applyMmrWebConfigUpdate(existing, update));
}
