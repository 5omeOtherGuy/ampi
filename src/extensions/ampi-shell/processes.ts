/**
 * The commands `shell_command` started in this session.
 *
 * Each command runs in a process group of its own (a detached spawn), so a
 * stop reaches everything it started. Output from stdout and stderr is kept
 * in arrival order until a tool reads it; past {@link MMR_SHELL_MAX_UNREAD_BYTES}
 * the oldest output is dropped and the next read starts with one line that
 * says how much. A command that ended stays listed until its last output
 * was read once.
 *
 * A command can leave processes behind in its group (`npm run dev &`), so
 * the registry remembers every group it started until it finds the group
 * empty, and a session end stops what is left there too.
 *
 * Windows has no process groups: there a stop reaches only the shell itself.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

/** Unread output kept per command; older output is dropped. */
export const MMR_SHELL_MAX_UNREAD_BYTES = 1024 * 1024;
/** After a command's shell exits, how long its pipes may stay quiet before it counts as ended. */
const EXIT_IDLE_MS = 100;
/** How often a stop checks whether a process group emptied. */
const GROUP_POLL_MS = 20;

const USE_PROCESS_GROUPS = process.platform !== "win32";

/** Why ampi stopped a command, when it did. */
export type MmrShellStopReason = "timeout" | "kill" | "abort" | "shutdown";

export interface MmrShellProcess {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
  /** Start time, in milliseconds since the epoch. */
  readonly startedAt: number;
  /** The wall-clock limit from `timeout_ms`, if one was given. */
  readonly timeoutMs?: number;
  running: boolean;
  /** Exit code once ended; a command ended by a signal gets 128 plus the signal number. */
  exitCode?: number;
  /** The signal that ended the command, if one did. */
  signal?: NodeJS.Signals;
  stoppedBy?: MmrShellStopReason;
}

interface Entry extends MmrShellProcess {
  child: ChildProcess;
  chunks: string[];
  unreadBytes: number;
  droppedBytes: number;
  listeners: Set<() => void>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

/** Output read from a command: the text, starting with the dropped-bytes line when output was dropped. */
export interface MmrShellOutput {
  output: string;
  /** Bytes of older output dropped since the previous read. */
  droppedBytes: number;
}

export interface MmrShellSpawnOptions {
  command: string;
  cwd: string;
  shell: string;
  args: readonly string[];
  /** The legacy WSL bash on Windows reads its command from stdin. */
  commandOnStdin?: boolean;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface MmrShellRegistryOptions {
  /** Time between SIGTERM and SIGKILL when stopping a command. Default 1000. */
  killGraceMs?: number;
  /** How long `kill` waits for the command to end. Default 2000. */
  killWaitMs?: number;
  /** Clock for `startedAt`. Default `Date.now`. */
  now?: () => number;
}

/** Signal the process group `pid` leads, or only `child` where there are no groups. */
function signalGroup(pid: number, child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (USE_PROCESS_GROUPS) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group is gone or was never created; try the shell itself.
    }
  }
  try {
    child?.kill(signal);
  } catch {
    // Already ended.
  }
}

/** Whether the process group `pid` led still has members. Always false without process groups. */
function groupAlive(pid: number): boolean {
  if (!USE_PROCESS_GROUPS) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return (osConstants.signals as Record<string, number | undefined>)[signal] ?? 0;
}

export class MmrShellProcessRegistry {
  private readonly entries = new Map<number, Entry>();
  /** Process groups of the commands started here, kept until found empty. */
  private readonly groups = new Set<number>();
  private readonly killGraceMs: number;
  private readonly killWaitMs: number;
  private readonly now: () => number;
  private exitHook?: () => void;

  constructor(options: MmrShellRegistryOptions = {}) {
    this.killGraceMs = options.killGraceMs ?? 1000;
    this.killWaitMs = options.killWaitMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  /** Pids of the listed commands, in start order. */
  pids(): number[] {
    return [...this.entries.keys()];
  }

  /** Pids of the commands still running. */
  runningPids(): number[] {
    return [...this.entries.values()].filter((entry) => entry.running).map((entry) => entry.pid);
  }

  get(pid: number): MmrShellProcess | undefined {
    return this.entries.get(pid);
  }

  /** Start a command. Rejects when the shell cannot be started. */
  async start(options: MmrShellSpawnOptions): Promise<MmrShellProcess> {
    const child = spawn(options.shell, options.commandOnStdin ? [...options.args] : [...options.args, options.command], {
      cwd: options.cwd,
      detached: USE_PROCESS_GROUPS,
      env: options.env,
      stdio: [options.commandOnStdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const pid = child.pid;
    if (pid === undefined) {
      const error = await new Promise<Error>((resolve) => child.once("error", resolve));
      throw new Error(`Could not start ${options.shell}: ${error.message}`);
    }
    if (options.commandOnStdin) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.command);
    }
    const entry: Entry = {
      pid,
      command: options.command,
      cwd: options.cwd,
      startedAt: this.now(),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      running: true,
      child,
      chunks: [],
      unreadBytes: 0,
      droppedBytes: 0,
      listeners: new Set(),
    };
    this.pruneGroups();
    this.entries.set(pid, entry);
    this.groups.add(pid);
    this.installExitHook();
    this.watch(entry);
    if (options.timeoutMs !== undefined) {
      entry.timeoutTimer = setTimeout(() => void this.stop(entry, "timeout"), options.timeoutMs);
      entry.timeoutTimer.unref?.();
    }
    return entry;
  }

  /** The output not read yet, without marking it read. */
  peek(pid: number): string {
    const entry = this.entries.get(pid);
    if (!entry) return "";
    const marker =
      entry.droppedBytes > 0 ? `[ampi-shell: ${entry.droppedBytes} bytes of older output were dropped]\n` : "";
    return marker + entry.chunks.join("");
  }

  /**
   * The output not read yet, marked read. Reading a command that ended
   * removes it from the list.
   */
  read(pid: number): MmrShellOutput {
    const entry = this.entries.get(pid);
    if (!entry) return { output: "", droppedBytes: 0 };
    const read = { output: this.peek(pid), droppedBytes: entry.droppedBytes };
    entry.chunks = [];
    entry.unreadBytes = 0;
    entry.droppedBytes = 0;
    if (!entry.running) this.entries.delete(pid);
    return read;
  }

  /**
   * Wait until the command ends, `ms` passes or `signal` aborts. `onOutput`
   * runs whenever new output arrives. Resolves with the command's state.
   */
  wait(pid: number, ms: number, options: { signal?: AbortSignal; onOutput?: () => void } = {}): Promise<MmrShellProcess> {
    const entry = this.entries.get(pid);
    if (!entry) return Promise.reject(new Error(`Unknown pid ${pid}`));
    return this.waitFor(entry, ms, options);
  }

  private waitFor(entry: Entry, ms: number, options: { signal?: AbortSignal; onOutput?: () => void } = {}): Promise<MmrShellProcess> {
    if (!entry.running || ms <= 0 || options.signal?.aborted) return Promise.resolve(entry);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        entry.listeners.delete(listener);
        options.signal?.removeEventListener("abort", finish);
        resolve(entry);
      };
      const listener = () => {
        if (!entry.running) finish();
        else options.onOutput?.();
      };
      const timer = setTimeout(finish, ms);
      entry.listeners.add(listener);
      options.signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /**
   * Stop a command: SIGTERM to its process group, then SIGKILL after the
   * grace period while the command or anything left in its group still
   * runs. Resolves once all of it ended or the wait for it ran out. `abort`
   * sends SIGKILL at once.
   */
  async stop(target: MmrShellProcess, reason: MmrShellStopReason): Promise<MmrShellProcess> {
    await this.stopGroup(target.pid, reason);
    return target;
  }

  /** Stop every command and every process group started here, and forget them all. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.groups].map((pid) => this.stopGroup(pid, "shutdown")));
    this.entries.clear();
    this.groups.clear();
    if (this.exitHook) process.removeListener("exit", this.exitHook);
    this.exitHook = undefined;
  }

  /** Forget a command, for a caller that already reported its output. */
  forget(pid: number): void {
    this.entries.delete(pid);
  }

  private async stopGroup(pid: number, reason: MmrShellStopReason): Promise<void> {
    const entry = this.entries.get(pid);
    if (!entry?.running && !(this.groups.has(pid) && groupAlive(pid))) return;
    if (entry?.running) entry.stoppedBy ??= reason;
    if (reason === "abort") {
      signalGroup(pid, entry?.child, "SIGKILL");
      await this.settle(pid, entry, this.killWaitMs);
      return;
    }
    signalGroup(pid, entry?.child, "SIGTERM");
    await this.settle(pid, entry, this.killGraceMs);
    if (entry?.running || groupAlive(pid)) signalGroup(pid, entry?.child, "SIGKILL");
    await this.settle(pid, entry, Math.max(0, this.killWaitMs - this.killGraceMs));
  }

  /** Wait up to `ms` for the command to end and its process group to empty. */
  private async settle(pid: number, entry: Entry | undefined, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    if (entry?.running) await this.waitFor(entry, ms);
    while (groupAlive(pid) && Date.now() < deadline) await delay(GROUP_POLL_MS);
  }

  /** Forget the groups that emptied, so a later stop never reaches a reused id. */
  private pruneGroups(): void {
    for (const pid of this.groups) if (!this.entries.has(pid) && !groupAlive(pid)) this.groups.delete(pid);
  }

  private append(entry: Entry, text: string): void {
    if (text === "") return;
    entry.chunks.push(text);
    entry.unreadBytes += Buffer.byteLength(text);
    while (entry.unreadBytes > MMR_SHELL_MAX_UNREAD_BYTES && entry.chunks.length > 0) {
      const first = entry.chunks[0] as string;
      const size = Buffer.byteLength(first);
      const excess = entry.unreadBytes - MMR_SHELL_MAX_UNREAD_BYTES;
      if (size <= excess) {
        entry.chunks.shift();
        entry.unreadBytes -= size;
        entry.droppedBytes += size;
      } else {
        const kept = Buffer.from(first).subarray(excess).toString();
        entry.chunks[0] = kept;
        entry.unreadBytes -= size - Buffer.byteLength(kept);
        entry.droppedBytes += size - Buffer.byteLength(kept);
      }
    }
  }

  private notify(entry: Entry): void {
    for (const listener of [...entry.listeners]) listener();
  }

  /**
   * Collect output and notice the end. A command counts as ended once its
   * shell exited and its pipes closed, or stayed quiet for a moment: a
   * process it left behind may hold them open.
   */
  private watch(entry: Entry): void {
    const { child } = entry;
    let exited = false;
    let finished = false;
    let open = 2;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (idle) clearTimeout(idle);
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      for (const [stream, decoder] of decoders) {
        this.append(entry, decoder.end());
        stream?.destroy();
      }
      entry.running = false;
      this.notify(entry);
    };
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, EXIT_IDLE_MS);
    };
    const decoders = [child.stdout, child.stderr].map((stream) => {
      const decoder = new StringDecoder("utf8");
      stream?.on("data", (data: Buffer) => {
        this.append(entry, decoder.write(data));
        if (exited) armIdle();
        this.notify(entry);
      });
      stream?.once("close", () => {
        open--;
        if (exited && open === 0) finish();
      });
      return [stream, decoder] as const;
    });
    child.once("error", (error) => {
      this.append(entry, `${error.message}\n`);
      entry.exitCode ??= 1;
      exited = true;
      finish();
    });
    child.once("exit", (code, signal) => {
      exited = true;
      if (signal) entry.signal = signal;
      entry.exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1);
      if (open === 0) finish();
      else armIdle();
    });
  }

  /** A last resort when Pi exits without a session shutdown: kill what still runs. */
  private installExitHook(): void {
    if (this.exitHook) return;
    this.exitHook = () => {
      for (const pid of this.groups) {
        const entry = this.entries.get(pid);
        if (entry?.running || groupAlive(pid)) signalGroup(pid, entry?.child, "SIGKILL");
      }
    };
    process.once("exit", this.exitHook);
  }
}
