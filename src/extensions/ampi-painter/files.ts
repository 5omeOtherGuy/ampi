import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { detectSupportedImageMimeTypeFromFile, getAgentDir } from "@earendil-works/pi-coding-agent";

/** How many reference images one call takes. */
export const MMR_PAINTER_MAX_REFERENCES = 3;
/** Largest reference image, by `stat` size: 10 MiB. */
export const MMR_PAINTER_MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

/** The image formats painter takes as references, by content. */
const REFERENCE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** File name extensions per format; the first is the one painter writes. */
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
};

const FORMAT_NAMES: Readonly<Record<string, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
};

/** `<agentDir>/data/ampi/painter`: images saved without `output_path`, one folder per session. */
export function resolveDefaultMmrPainterDataDir(): string {
  return path.join(getAgentDir(), "data", "ampi", "painter");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/**
 * Read the reference images as image blocks, in order. Each must exist, be a
 * file of at most 10 MiB and be PNG, JPEG, WebP or GIF by its content.
 * Throws an error naming the file and the rule it broke.
 */
export async function readMmrPainterReferences(paths: readonly string[], cwd: string): Promise<ImageContent[]> {
  if (paths.length > MMR_PAINTER_MAX_REFERENCES) {
    throw new Error(`reference_images takes at most ${MMR_PAINTER_MAX_REFERENCES} images; this call gave ${paths.length}.`);
  }
  const blocks: ImageContent[] = [];
  for (const given of paths) {
    if (typeof given !== "string" || given.trim() === "") throw new Error("reference_images holds an empty path.");
    // Any file the user can read: absolute paths, `../` and symlinks may lead outside the working directory.
    const file = path.resolve(cwd, given);
    const info = await stat(file).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") throw new Error(`Reference image ${given} does not exist.`);
      throw new Error(`Reference image ${given} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!info.isFile()) throw new Error(`Reference image ${given} is not a file.`);
    if (info.size > MMR_PAINTER_MAX_REFERENCE_BYTES) {
      throw new Error(`Reference image ${given} is ${info.size} bytes; the limit is 10 MiB (${MMR_PAINTER_MAX_REFERENCE_BYTES} bytes).`);
    }
    const mimeType = await detectSupportedImageMimeTypeFromFile(file);
    if (mimeType === null || !REFERENCE_MIME_TYPES.has(mimeType)) {
      throw new Error(`Reference image ${given} is not a PNG, JPEG, WebP or GIF image (painter goes by the file's content, not its name).`);
    }
    blocks.push({ type: "image", data: (await readFile(file)).toString("base64"), mimeType });
  }
  return blocks;
}

function inside(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The nearest ancestor of `target` that exists. */
async function nearestExistingAncestor(target: string): Promise<string> {
  let dir = path.dirname(target);
  for (;;) {
    try {
      await stat(dir);
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return dir;
      dir = parent;
    }
  }
}

/**
 * Check `output_path` before anything is generated: it must resolve inside
 * the working directory (through symlinks too), its folder must exist and
 * nothing may exist at the path yet, not even a symlink. Returns the
 * absolute path; throws an error naming the path and the rule.
 */
export async function checkMmrPainterOutputPath(outputPath: string, cwd: string): Promise<string> {
  if (outputPath.trim() === "") throw new Error("output_path is empty.");
  const target = path.resolve(cwd, outputPath);
  const root = await realpath(cwd);
  const ancestor = await realpath(await nearestExistingAncestor(target)).catch(() => undefined);
  if (ancestor === undefined || !inside(ancestor, root)) {
    throw new Error(`output_path ${outputPath} is outside the working directory ${cwd}; painter saves only inside it.`);
  }
  const folder = path.dirname(target);
  const folderInfo = await stat(folder).catch(() => undefined);
  if (!folderInfo?.isDirectory()) {
    throw new Error(`output_path ${outputPath}: the folder ${folder} does not exist; painter does not create folders.`);
  }
  if (await lstat(target).then(() => true, () => false)) {
    throw new Error(`output_path ${outputPath} already exists; painter never overwrites a file.`);
  }
  return target;
}

/** Write a new file at `target`, failing if anything appeared there since the check. */
export async function writeMmrPainterOutput(target: string, data: Buffer, given: string): Promise<void> {
  try {
    await writeFile(target, data, { flag: "wx" });
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new Error(`output_path ${given} already exists; painter never overwrites a file.`);
    throw new Error(`output_path ${given} could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The extension painter writes for a format: `png`, `jpg`, `webp`, `gif`, else the format's own subtype. */
export function mmrPainterExtension(mimeType: string): string {
  const known = EXTENSIONS[mimeType]?.[0];
  if (known) return known;
  const subtype = /^image\/([a-z0-9]+)/i.exec(mimeType)?.[1];
  return subtype ? subtype.toLowerCase() : "img";
}

/** Whether `file`'s name ends in an extension of the format, `.jpeg` and `.jpg` alike for JPEG. */
export function mmrPainterNameMatchesFormat(file: string, mimeType: string): boolean {
  const ext = path.extname(file).slice(1).toLowerCase();
  return (EXTENSIONS[mimeType] ?? [mmrPainterExtension(mimeType)]).includes(ext);
}

export function mmrPainterFormatName(mimeType: string): string {
  return FORMAT_NAMES[mimeType] ?? mimeType;
}

export interface MmrPainterStoreOptions {
  /** Default: {@link resolveDefaultMmrPainterDataDir}. */
  baseDir?: string;
  /** Milliseconds since the epoch; the file name's timestamp. */
  now?: () => number;
  /** The random part of a temporary file's name. */
  randomId?: () => string;
  /** Hard-links the temporary file to its name; default `fs.promises.link`. */
  link?: (existing: string, created: string) => Promise<void>;
}

/** A folder name for a session id: kept as is when it is filesystem-safe, else its unsafe characters replaced. */
function sessionFolder(sessionId: string | undefined): string {
  const id = sessionId?.trim() || "no-session";
  return id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
}

/**
 * Images saved without `output_path`:
 * `<baseDir>/<session id>/<timestamp>-<n>.<ext>`, where `n` counts the
 * session's images from 1 in this process. Each image is written to a
 * temporary file first and then hard-linked to its name, which fails
 * rather than replaces when the name is taken, so two calls in the same
 * millisecond never overwrite each other: a taken name moves `n` on. Where
 * the filesystem has no hard links, the image is written to its name
 * directly, still only as a new file.
 */
export function createMmrPainterStore(options: MmrPainterStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => randomBytes(8).toString("hex"));
  const linkFile = options.link ?? link;
  const counts = new Map<string, number>();
  // Temporary names stay apart within this process even when the random part repeats.
  let temps = 0;
  return {
    async save(sessionId: string | undefined, data: Buffer, mimeType: string): Promise<string> {
      const baseDir = options.baseDir ?? resolveDefaultMmrPainterDataDir();
      const folder = sessionFolder(sessionId);
      const dir = path.join(baseDir, folder);
      await mkdir(dir, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      const ext = mmrPainterExtension(mimeType);
      const temp = path.join(dir, `.${stamp}.${process.pid}.${++temps}.${randomId()}.tmp`);
      await writeFile(temp, data, { flag: "wx" });
      try {
        for (;;) {
          // Taken before any await, so calls running side by side get different numbers.
          const n = (counts.get(folder) ?? 0) + 1;
          counts.set(folder, n);
          const file = path.join(dir, `${stamp}-${n}.${ext}`);
          try {
            try {
              await linkFile(temp, file);
            } catch (error) {
              if (errorCode(error) === "EEXIST") throw error;
              await writeFile(file, data, { flag: "wx" });
            }
            return file;
          } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
          }
        }
      } finally {
        await unlink(temp).catch(() => {});
      }
    },
  };
}

export type MmrPainterStore = ReturnType<typeof createMmrPainterStore>;
