import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type MmrPermissionContext, parseMmrPermissionProgram } from "../ampi-core/permissions.js";

/**
 * Delegate programs: a `delegate` rule's `to` names a program that decides a
 * tool call. It gets one line of JSON on stdin and answers with its exit
 * code: 0 allows, 1 rejects (the first line it prints is the reason), 2 asks.
 * Anything else asks too, and the caller warns the user.
 *
 * The program starts without a shell, in the session's working directory,
 * with the inherited environment. A timeout or an interrupted turn kills it
 * together with its process group.
 */

/** What a delegate program reads on stdin. */
export interface MmrPermissionsDelegateRequest {
  readonly tool: string;
  readonly input: unknown;
  readonly context: MmrPermissionContext;
  readonly cwd: string;
}

export type MmrPermissionsDelegateOutcome =
  | { readonly kind: "allow" }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "ask" }
  /** The program could not answer; the call asks. `problem` completes "the program ...": "exited with code 3". */
  | { readonly kind: "failed"; readonly problem: string }
  | { readonly kind: "aborted" };

/** Starts a timer and returns the function that cancels it. */
export type MmrPermissionsDelegateTimer = (callback: () => void, ms: number) => () => void;

export type MmrPermissionsDelegateSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface RunMmrPermissionsDelegateOptions {
  /** The rule's `to`: the program and its arguments. */
  readonly program: string;
  readonly request: MmrPermissionsDelegateRequest;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly timeoutMs?: number;
  readonly timer?: MmrPermissionsDelegateTimer;
  readonly spawn?: MmrPermissionsDelegateSpawn;
  readonly signal?: AbortSignal;
}

export const MMR_PERMISSIONS_DELEGATE_TIMEOUT_MS = 10_000;
/** Bytes of stdout, and of stderr, a program's answer may use; the rest is read and dropped. */
export const MMR_PERMISSIONS_DELEGATE_OUTPUT_LIMIT = 64 * 1024;
/** Characters of a rejection reason. */
export const MMR_PERMISSIONS_DELEGATE_REASON_LIMIT = 500;

const defaultTimer: MmrPermissionsDelegateTimer = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A bare program name on `PATH`: the first existing, executable regular file
 * in an absolute directory, so the file checked is the file that runs.
 */
function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const extensions = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    // An empty or relative entry would depend on the working directory; a program is never looked up there.
    if (!path.isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function expandHome(word: { value: string; raw: string }, home: string): string {
  // Only an unquoted `~` expands, as in a shell.
  if (word.raw === "~") return home;
  if (word.raw.startsWith("~/")) return path.join(home, word.value.slice(2));
  return word.value;
}

/**
 * Where the program is: `~` and `~/` expand to the home directory in every
 * word, a first word with a path separator resolves against the working
 * directory, and a bare name is looked up on `PATH`. An unreadable `to` is
 * a problem here too, though validation skips such a rule first.
 */
export function resolveMmrPermissionsDelegateProgram(
  program: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv; home?: string },
): { file: string; args: string[] } | { problem: string } {
  const parsed = parseMmrPermissionProgram(program);
  if (!parsed.words) return { problem: `cannot be read (${parsed.problem ?? "it is not a program line"})` };
  const home = options.home ?? homedir();
  const [name, ...args] = parsed.words.map((word) => expandHome(word, home)) as [string, ...string[]];
  const separators = process.platform === "win32" ? /[\\/]/ : /\//;
  if (separators.test(name)) return { file: path.resolve(options.cwd, name), args };
  const found = findOnPath(name, options.env ?? process.env);
  return found ? { file: found, args } : { problem: "was not found on PATH" };
}

/** The first non-empty line, without control or format characters (bidi controls among them), cut to the reason limit. */
function firstLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
    if (clean.length > 0) return Array.from(clean).slice(0, MMR_PERMISSIONS_DELEGATE_REASON_LIMIT).join("");
  }
  return undefined;
}

function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

function spawnProblem(error: NodeJS.ErrnoException, file: string): string {
  if (error.code === "ENOENT") return `was not found at ${file}`;
  if (error.code === "EACCES") return `is not executable (${file})`;
  return `could not start (${error.message})`;
}

/** Collects up to the output limit of a stream and drains the rest. */
function collect(stream: NodeJS.ReadableStream | null | undefined): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  stream?.on("data", (chunk: Buffer | string) => {
    if (size >= MMR_PERMISSIONS_DELEGATE_OUTPUT_LIMIT) return;
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const kept = buffer.subarray(0, MMR_PERMISSIONS_DELEGATE_OUTPUT_LIMIT - size);
    chunks.push(kept);
    size += kept.length;
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

/** Run a delegate program for one call and read its answer. Never throws. */
export function runMmrPermissionsDelegate(options: RunMmrPermissionsDelegateOptions): Promise<MmrPermissionsDelegateOutcome> {
  const { request } = options;
  if (options.signal?.aborted) return Promise.resolve({ kind: "aborted" });
  const env = options.env ?? process.env;
  const resolved = resolveMmrPermissionsDelegateProgram(options.program, { cwd: request.cwd, env, home: options.home });
  if ("problem" in resolved) return Promise.resolve({ kind: "failed", problem: resolved.problem });

  let payload: string;
  try {
    payload = `${JSON.stringify(request)}\n`;
  } catch (error) {
    return Promise.resolve({ kind: "failed", problem: `could not write the call as JSON (${error instanceof Error ? error.message : String(error)})` });
  }

  const timeoutMs = options.timeoutMs ?? MMR_PERMISSIONS_DELEGATE_TIMEOUT_MS;
  const posix = process.platform !== "win32";
  let child: ChildProcess;
  try {
    child = (options.spawn ?? nodeSpawn)(resolved.file, resolved.args, {
      cwd: request.cwd,
      env,
      shell: false,
      // Its own process group on POSIX, so a timeout can stop what it started.
      detached: posix,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return Promise.resolve({ kind: "failed", problem: spawnProblem(error as NodeJS.ErrnoException, resolved.file) });
  }

  return new Promise((resolve) => {
    let settled = false;
    let cancelTimer = () => {};
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);

    const kill = () => {
      if (posix && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const finish = (outcome: MmrPermissionsDelegateOutcome) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const answer = (code: number | null, signal: NodeJS.Signals | null): MmrPermissionsDelegateOutcome => {
      if (code === 0) return { kind: "allow" };
      if (code === 1) {
        const reason = firstLine(stdout()) ?? firstLine(stderr()) ?? `The delegate program "${options.program}" rejected this call without giving a reason.`;
        return { kind: "reject", reason };
      }
      if (code === 2) return { kind: "ask" };
      if (code !== null) return { kind: "failed", problem: `exited with code ${code}` };
      return { kind: "failed", problem: `was stopped by ${signal ?? "a signal"}` };
    };

    const onAbort = () => {
      kill();
      finish({ kind: "aborted" });
    };

    cancelTimer = (options.timer ?? defaultTimer)(() => {
      kill();
      // A program that exited but left its pipes open to something it started has still answered.
      finish(exit ? answer(exit.code, exit.signal) : { kind: "failed", problem: `timed out after ${formatDuration(timeoutMs)}` });
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error: NodeJS.ErrnoException) => {
      kill();
      finish({ kind: "failed", problem: spawnProblem(error, resolved.file) });
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      finish(answer(exit?.code ?? code, exit?.signal ?? signal));
    });

    // A program may exit without reading its input.
    child.stdin?.on("error", () => {});
    child.stdin?.end(payload);
  });
}
