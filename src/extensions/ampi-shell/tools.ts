import { randomBytes } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionContext,
  formatSize,
  getShellConfig,
  type ToolDefinition,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { MmrShellSettings } from "./config.js";
import type { MmrShellOutput, MmrShellProcess, MmrShellProcessRegistry } from "./processes.js";

export const MMR_SHELL_TOOL_NAMES = ["shell_command", "shell_command_status", "shell_command_kill"] as const;

/** `shell_command_status` waits at most this long. */
export const MMR_SHELL_STATUS_MAX_WAIT_MS = 60_000;
const STATUS_DEFAULT_WAIT_MS = 10_000;
/** Largest delay `setTimeout` accepts. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const UPDATE_INTERVAL_MS = 100;

export const SHELL_COMMAND_PARAMS = Type.Object(
  {
    command: Type.String({ description: "The shell command to run." }),
    workdir: Type.Optional(
      Type.String({
        description: "Directory to run it in, absolute or relative to the session's working directory, which is the default. It must exist.",
      }),
    ),
    timeout_ms: Type.Optional(
      Type.Number({
        description: "Wall-clock limit in milliseconds. The command is stopped once it passes, in the background too. No limit when left out.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const SHELL_COMMAND_STATUS_PARAMS = Type.Object(
  {
    pid: Type.Number({ description: "The pid shell_command gave for the command." }),
    timeout_ms: Type.Optional(
      Type.Number({
        description: "How long to wait for the command to end, in milliseconds: 0 to 60000, default 10000. 0 answers at once.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const SHELL_COMMAND_KILL_PARAMS = Type.Object(
  { pid: Type.Number({ description: "The pid shell_command gave for the command." }) },
  { additionalProperties: false },
);

export const SHELL_COMMAND_DESCRIPTION = `Run a shell command that may take long or has to keep running: a dev server, a file watcher, a long test suite, a build.

The command runs in Pi's shell, in a process group of its own, with the same PI_* session variables as bash. If it ends within a short wait (30 seconds unless the user changed it), the result is the tail of its output, plus its exit code when that is not 0. If it is still going, it keeps running in the background and the result gives its pid and what it printed so far; follow it with shell_command_status and end it with shell_command_kill.

Output is cut to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, whichever comes first; when it is cut, the output is saved to a temp file whose path the result names. Between two reads a command keeps at most its newest 1 MiB of output; the result says how much older output was dropped.`;

export const SHELL_COMMAND_STATUS_DESCRIPTION = `Follow a command that shell_command left running in the background.

Waits until the command ends or timeout_ms runs out, showing new output as it arrives. Returns the output that arrived since the previous read of this pid, whether the command still runs, and its exit code once it ended. It never starts the command again. A result that says the command still runs is normal for slow work: check again later.`;

export const SHELL_COMMAND_KILL_DESCRIPTION = `End a background command that shell_command started in this session.

Everything in the command's process group is asked to exit (SIGTERM) and, after a one-second grace, forced to (SIGKILL). The result holds the output not read yet and how the command ended; if it somehow still runs two seconds after the request, the result says so.`;

export const SHELL_COMMAND_PROMPT_SNIPPET =
  "Run long or never-ending shell commands (dev servers, watchers, long builds and test suites) in the background";
export const SHELL_COMMAND_STATUS_PROMPT_SNIPPET = "Wait for and read new output from a background shell_command";
export const SHELL_COMMAND_KILL_PROMPT_SNIPPET = "Stop a background shell_command";

export const SHELL_COMMAND_PROMPT_GUIDELINES = [
  "Use bash for quick commands. Use shell_command for commands that may run for more than about half a minute or have to keep running, such as dev servers, watchers, long test suites and builds.",
  "When shell_command or shell_command_status says a command still runs, it is not done yet: check on it again with shell_command_status rather than starting it a second time.",
  "Use shell_command_kill for a command you no longer need or one that stopped making progress; leave servers and watchers you still rely on running.",
] as const;

export interface MmrShellToolsDeps {
  registry: MmrShellProcessRegistry;
  settings: () => MmrShellSettings;
  /** Pi's settings, for `shellPath` and `shellCommandPrefix`. */
  piSettings: () => unknown;
}

type ShellCommandParams = Static<typeof SHELL_COMMAND_PARAMS>;
type StatusParams = Static<typeof SHELL_COMMAND_STATUS_PARAMS>;
type KillParams = Static<typeof SHELL_COMMAND_KILL_PARAMS>;
type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
type UpdateCallback = Parameters<ToolDefinition["execute"]>[3];

function stringSetting(settings: unknown, key: string): string | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const value = (settings as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

/** `process.env` with Pi's session variables for this session, as Pi's bash sets them. */
export function shellEnvironment(ctx: ExtensionContext): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) env.PI_SESSION_FILE = sessionFile;
  if (ctx.model) {
    env.PI_PROVIDER = ctx.model.provider;
    env.PI_MODEL = ctx.model.id;
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  return env;
}

function seconds(ms: number): string {
  return String(ms / 1000);
}

/** The last line of a result: how the command ended, or that it still runs. */
export function describeShellState(proc: MmrShellProcess): string {
  if (proc.running) return `Command is still running as pid ${proc.pid}.`;
  if (proc.stoppedBy === "timeout" && proc.timeoutMs !== undefined) return `Command timed out after ${seconds(proc.timeoutMs)} seconds`;
  if (proc.signal && proc.stoppedBy) return `Command stopped with ${proc.signal}`;
  if (proc.signal) return `Command terminated by ${proc.signal}`;
  return `Command exited with code ${proc.exitCode}`;
}

function failed(proc: MmrShellProcess): boolean {
  return proc.exitCode !== 0 || proc.signal !== undefined || proc.stoppedBy !== undefined;
}

/**
 * The tail of `output`; all of it goes to a temp file when the tail is
 * shorter. That file holds the whole output unless the registry dropped
 * older output, which the note then says.
 */
function outputTail({ output, droppedBytes }: MmrShellOutput, pid: number): { text: string; details: Record<string, unknown> } {
  const tail = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!tail.truncated) return { text: output, details: {} };
  const fullOutputPath = path.join(tmpdir(), `ampi-shell-${pid}-${randomBytes(4).toString("hex")}.log`);
  writeFileSync(fullOutputPath, output);
  const shown = `last ${tail.outputLines} of ${tail.totalLines} lines (${formatSize(tail.outputBytes)} of ${formatSize(tail.totalBytes)})`;
  const saved =
    droppedBytes > 0
      ? `${droppedBytes} bytes of older output were dropped before that. Kept output: ${fullOutputPath}`
      : `Full output: ${fullOutputPath}`;
  return {
    text: `${tail.content}\n\n[Output cut to the ${shown}. ${saved}]`,
    details: { truncation: tail, fullOutputPath, ...(droppedBytes > 0 ? { droppedBytes } : {}) },
  };
}

function withStatus(output: string, status: string): string {
  return output.trim() === "" ? status : `${output.replace(/\n+$/, "")}\n\n${status}`;
}

function stateDetails(proc: MmrShellProcess): Record<string, unknown> {
  return {
    pid: proc.pid,
    command: proc.command,
    running: proc.running,
    startedAt: proc.startedAt,
    ...(proc.running ? {} : { exitCode: proc.exitCode }),
    ...(proc.signal ? { signal: proc.signal } : {}),
    ...(proc.stoppedBy ? { stoppedBy: proc.stoppedBy } : {}),
    ...(proc.timeoutMs !== undefined ? { timeoutMs: proc.timeoutMs } : {}),
  };
}

/** Calls `update` with fresh partial results at most every {@link UPDATE_INTERVAL_MS}. */
function throttledUpdates(onUpdate: UpdateCallback | undefined, partial: () => ToolResult) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = 0;
  return {
    schedule() {
      if (!onUpdate || timer) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          last = Date.now();
          onUpdate(partial());
        },
        Math.max(0, last + UPDATE_INTERVAL_MS - Date.now()),
      );
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function checkPid(pid: unknown): number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw new Error("pid must be a positive whole number.");
  return pid;
}

function lookup(registry: MmrShellProcessRegistry, pid: number): MmrShellProcess {
  const proc = registry.get(pid);
  if (proc) return proc;
  const known = registry.pids();
  const listed =
    known.length > 0
      ? `Pids shell_command started in this session: ${known.join(", ")}.`
      : "shell_command has no commands listed in this session.";
  throw new Error(`Unknown pid ${pid}: shell_command did not start it in this session, or it ended and its output was already read. ${listed}`);
}

/** Read what `pid` printed since the last read and report its state, as status and kill do. */
function stateResult(registry: MmrShellProcessRegistry, proc: MmrShellProcess): ToolResult {
  const output = registry.read(proc.pid);
  const tail = outputTail(output, proc.pid);
  return {
    content: [{ type: "text", text: withStatus(tail.text === "" ? "(no new output)" : tail.text, describeShellState(proc)) }],
    details: { ...stateDetails(proc), ...tail.details },
  };
}

function shellCommandTool(deps: MmrShellToolsDeps): ToolDefinition {
  return {
    name: "shell_command",
    label: "shell_command",
    description: SHELL_COMMAND_DESCRIPTION,
    promptSnippet: SHELL_COMMAND_PROMPT_SNIPPET,
    promptGuidelines: [...SHELL_COMMAND_PROMPT_GUIDELINES],
    parameters: SHELL_COMMAND_PARAMS,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as ShellCommandParams;
      const { registry } = deps;
      const settings = deps.settings();
      const timeoutMs = params.timeout_ms;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)) {
        throw new Error(`timeout_ms must be a number of milliseconds from 1 to ${MAX_TIMEOUT_MS}.`);
      }
      const cwd = path.resolve(ctx.cwd, params.workdir ?? ".");
      let isDirectory = false;
      try {
        isDirectory = statSync(cwd).isDirectory();
      } catch {
        // Reported below.
      }
      if (!isDirectory) throw new Error(`Working directory does not exist or is not a directory: ${cwd}`);
      const running = registry.runningPids();
      if (running.length >= settings.maxBackground) {
        throw new Error(
          `${running.length} commands are already running (the limit is ${settings.maxBackground}): pids ${running.join(", ")}. Wait for one with shell_command_status or stop one with shell_command_kill first.`,
        );
      }

      const piSettings = deps.piSettings();
      const shellPath = stringSetting(piSettings, "shellPath");
      const prefix = stringSetting(piSettings, "shellCommandPrefix");
      const shell = getShellConfig(shellPath ? expandHome(shellPath) : undefined);
      const proc = await registry.start({
        command: prefix ? `${prefix}\n${params.command}` : params.command,
        cwd,
        shell: shell.shell,
        args: shell.args,
        commandOnStdin: shell.commandTransport === "stdin",
        env: shellEnvironment(ctx),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });

      const updates = throttledUpdates(onUpdate, () => ({
        content: [{ type: "text", text: registry.peek(proc.pid) }],
        details: stateDetails(proc),
      }));
      onUpdate?.({ content: [], details: stateDetails(proc) });
      await registry.wait(proc.pid, settings.backgroundAfterMs, { signal, onOutput: updates.schedule });
      updates.cancel();

      if (signal?.aborted && proc.running) {
        await registry.stop(proc, "abort");
        const output = registry.read(proc.pid);
        registry.forget(proc.pid);
        throw new Error(withStatus(outputTail(output, proc.pid).text, "Command aborted"));
      }

      const tail = outputTail(registry.read(proc.pid), proc.pid);
      if (proc.running) {
        return {
          content: [
            {
              type: "text",
              text: withStatus(
                tail.text,
                `Command is still running in the background as pid ${proc.pid}. Follow it with shell_command_status; end it with shell_command_kill.`,
              ),
            },
          ],
          details: { ...stateDetails(proc), ...tail.details },
        };
      }
      const details = { ...stateDetails(proc), ...tail.details };
      if (!failed(proc)) return { content: [{ type: "text", text: tail.text === "" ? "(no output)" : tail.text }], details };
      return { content: [{ type: "text", text: withStatus(tail.text, describeShellState(proc)) }], details, isError: true };
    },
  };
}

function shellStatusTool(deps: MmrShellToolsDeps): ToolDefinition {
  return {
    name: "shell_command_status",
    label: "shell_command_status",
    description: SHELL_COMMAND_STATUS_DESCRIPTION,
    promptSnippet: SHELL_COMMAND_STATUS_PROMPT_SNIPPET,
    parameters: SHELL_COMMAND_STATUS_PARAMS,
    async execute(_toolCallId, rawParams, signal, onUpdate) {
      const params = rawParams as StatusParams;
      const { registry } = deps;
      const waitMs = params.timeout_ms ?? STATUS_DEFAULT_WAIT_MS;
      if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > MMR_SHELL_STATUS_MAX_WAIT_MS) {
        throw new Error(`timeout_ms must be from 0 to ${MMR_SHELL_STATUS_MAX_WAIT_MS} milliseconds.`);
      }
      const proc = lookup(registry, checkPid(params.pid));
      const updates = throttledUpdates(onUpdate, () => ({
        content: [{ type: "text", text: registry.peek(proc.pid) }],
        details: stateDetails(proc),
      }));
      // Output that arrived before this call shows at once, not with the next line.
      if (registry.peek(proc.pid) !== "") updates.schedule();
      await registry.wait(proc.pid, waitMs, { signal, onOutput: updates.schedule });
      updates.cancel();
      return stateResult(registry, proc);
    },
  };
}

function shellKillTool(deps: MmrShellToolsDeps): ToolDefinition {
  return {
    name: "shell_command_kill",
    label: "shell_command_kill",
    description: SHELL_COMMAND_KILL_DESCRIPTION,
    promptSnippet: SHELL_COMMAND_KILL_PROMPT_SNIPPET,
    parameters: SHELL_COMMAND_KILL_PARAMS,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as KillParams;
      const { registry } = deps;
      const proc = lookup(registry, checkPid(params.pid));
      await registry.stop(proc, "kill");
      return stateResult(registry, proc);
    },
  };
}

/** The three tools, sharing one registry. */
export function createMmrShellTools(deps: MmrShellToolsDeps): ToolDefinition[] {
  return [shellCommandTool(deps), shellStatusTool(deps), shellKillTool(deps)];
}
