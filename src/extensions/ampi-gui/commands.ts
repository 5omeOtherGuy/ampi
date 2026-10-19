import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { type ExtensionAPI, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { getMmrCommand } from "../ampi-core/command-registry.js";
import { getMmrGuiHost } from "../ampi-core/gui-host.js";
import { findMmrLiveOwner, type MmrLiveEntry, type MmrLiveRegistryOptions, readMmrLiveToken } from "../ampi-core/live-registry.js";
import { getMmrPromptQueue, removeMmrQueuedPrompt } from "../ampi-core/prompt-queue.js";
import { getMmrModeName } from "../ampi-core/mode-registry.js";
import { getMmrModeState } from "../ampi-core/runtime.js";
import { getMmrThreadIndex, type MmrThreadRecord, type MmrThreadRecordPatch } from "../ampi-core/thread-index.js";
import { getMmrThreadReports } from "../ampi-core/thread-reports.js";
import type { MmrGuiBridge } from "./bridge.js";
import { MMR_GUI_LOOPBACK, mmrGuiCookieName } from "./server.js";
import { type MmrGuiSessions, persistedModeName } from "./sessions.js";

/** The live session's mode for Copy as Markdown: a registered mode by its key. */
function liveModeName(): string | undefined {
  const state = getMmrModeState();
  return state ? getMmrModeName(state) : undefined;
}

/**
 * What the web GUI's composer can do to the running session. Every write
 * goes through the Pi session of the terminal process that serves the page,
 * the same way the terminal's own keys go:
 *
 * | Route              | Body                          | Effect |
 * | ------------------ | ----------------------------- | ------ |
 * | `/api/send`        | `{ text, deliverAs? }`        | idle: a new prompt; busy: steers the turn (`"steer"`, the default) or waits for it to end (`"followUp"`), through `pi.sendUserMessage` |
 * | `/api/dequeue`     | `{ kind, index, text }`       | takes one queued message back, through ampi-core's prompt-queue seam |
 * | `/api/steer-next`  | `{}`                          | runs the `prompt.steerQueuedMessage` command |
 * | `/api/interrupt`   | `{}`                          | cancels the open questions, then runs the `thread.interrupt` command, or `ctx.abort()` without it |
 * | `/api/dialog`      | `{ id, value }` or `{ id, cancelled: true }` | answers an extension's open question (a session `ampi app` hosts); the first answer wins, any later one answers 409 |
 *
 * And the More Actions ({@link MMR_GUI_SESSION_ACTIONS}), for any listed
 * session; every body names it as `{ sessionId }`:
 *
 * | Route              | Body                          | Effect |
 * | ------------------ | ----------------------------- | ------ |
 * | `/api/markdown`    | `{}`                          | answers `{ markdown }`: the session's current branch through ampi-threads' formatter |
 * | `/api/archive`     | `{ archived }`                | sets or clears the session's archive date in the thread index |
 * | `/api/pin`         | `{ pinned }`                  | pins or unpins it in the thread index |
 * | `/api/color`       | `{ color }`                   | sets its colour (a thread colour name or `#rrggbb`), or `null` for the hashed one |
 * | `/api/labels`      | `{ labels }`                  | replaces its labels, with the thread index's label rules |
 * | `/api/snooze`      | `{ snoozed }`                 | snoozes it until its next message, or ends the snooze |
 * | `/api/unread`      | `{ unread }`                  | `true` marks it unread; `false` marks it read now |
 * | `/api/cost`        | `{}`                          | answers `{ cost }`: ampi-threads' cost report for every entry of the session |
 * | `/api/running`     | `{}`                          | answers where it runs (`where`, `pid`, `phase`) and its `cwd` and Git `branch` |
 * | `/api/rename`      | `{ name }`                    | see below |
 * | `/api/delete`      | `{}`                          | see below |
 *
 * Rename: the session this process runs is renamed with
 * `pi.setSessionName`. A session a terminal with the web GUI runs is
 * renamed by forwarding the request to that terminal's server (with the
 * token from its token file). A session another process holds otherwise
 * answers 409 with the holder. A session nobody holds, checked with
 * `findMmrLiveOwner` just before, gets Pi's `session_info` entry appended
 * through `SessionManager.open`, as `ampi threads rename` does. Every rename
 * records the title as the user's.
 *
 * Delete: 409 while any live process holds the session, this one included;
 * otherwise its file and its thread index record are removed, as
 * `ampi threads delete` does.
 *
 * A request that cannot act now answers 409 with the reason; a malformed one
 * answers 400; a session the catalogue does not list answers 404.
 */

export interface MmrGuiCommandResult {
  status: number;
  body: Record<string, unknown>;
}

export type MmrGuiCommands = Readonly<Record<string, (body: unknown) => MmrGuiCommandResult | Promise<MmrGuiCommandResult>>>;

/** The routes about any listed session, which `ampi app`'s hub serves at `/api/` too. */
export const MMR_GUI_SESSION_ACTIONS: readonly string[] = Object.freeze([
  "markdown",
  "archive",
  "pin",
  "color",
  "labels",
  "snooze",
  "unread",
  "cost",
  "running",
  "rename",
  "delete",
]);

/** Longest prompt the composer may send, in UTF-16 code units. */
export const MMR_GUI_MAX_PROMPT_LENGTH = 100_000;

const STEER_COMMAND_ID = "prompt.steerQueuedMessage";
const INTERRUPT_COMMAND_ID = "thread.interrupt";

/** Longest session name the title bar may set. */
export const MMR_GUI_MAX_NAME_LENGTH = 200;

/** How long the Git branch lookup and a forwarded rename may take. */
const SUBPROCESS_TIMEOUT_MS = 2_000;
const FORWARD_TIMEOUT_MS = 10_000;

const ok = (body: Record<string, unknown> = {}): MmrGuiCommandResult => ({ status: 200, body: { ok: true, ...body } });
const conflict = (error: string, extra: Record<string, unknown> = {}): MmrGuiCommandResult => ({ status: 409, body: { ...extra, error } });
const invalid = (error: string): MmrGuiCommandResult => ({ status: 400, body: { error } });
const unknownSession: MmrGuiCommandResult = { status: 404, body: { error: "No such session." } };

function record(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Where a session runs, as `/api/running` answers it. */
export type MmrGuiRunningWhere = "this-terminal" | "terminal" | "execute" | "app" | "none";

const WHERE: Readonly<Record<MmrLiveEntry["kind"], MmrGuiRunningWhere>> = { tui: "terminal", execute: "execute", app: "app", "app-session": "app" };

/** A 409 naming the live process that holds a session, as the hub's answers name it. */
function held(owner: MmrLiveEntry, what: string): MmrGuiCommandResult {
  return conflict(`Process ${owner.pid} (${owner.kind}) has this session open; ${what}.`, {
    state: "elsewhere",
    kind: owner.kind,
    pid: owner.pid,
    gui: owner.gui !== null,
  });
}

function isIndexError(error: unknown): error is Error {
  // By name: Pi may load another copy of the store's module, whose class differs.
  return error instanceof Error && error.name === "MmrThreadIndexError";
}

/** The Git branch checked out in `cwd`, the short commit id on a detached head, or `null` outside a repository. */
export function readMmrGuiGitBranch(cwd: string): Promise<string | null> {
  // Never takes Git's optional locks, so a page asking never disturbs a Git command in that checkout.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const git = (args: string[]) =>
    new Promise<string>((resolve) => {
      execFile("git", ["-C", cwd, ...args], { env, timeout: SUBPROCESS_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
        resolve(error ? "" : String(stdout).trim()),
      );
    });
  if (cwd === "") return Promise.resolve(null);
  return git(["symbolic-ref", "--short", "-q", "HEAD"]).then(async (branch) => branch || (await git(["rev-parse", "--short", "HEAD"])) || null);
}

/** POST a command to another process's GUI server with its token, as the hub forwards requests. */
function postToMmrGui(port: number, token: string, route: string, body: unknown): Promise<MmrGuiCommandResult> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    const gone = () => resolve({ status: 502, body: { error: "The process that has this session open did not answer." } });
    const req = httpRequest(
      {
        host: MMR_GUI_LOOPBACK,
        port,
        method: "POST",
        path: `/api/${route}`,
        setHost: false,
        agent: false,
        timeout: FORWARD_TIMEOUT_MS,
        headers: {
          Host: `${MMR_GUI_LOOPBACK}:${port}`,
          Origin: `http://${MMR_GUI_LOOPBACK}:${port}`,
          Cookie: `${mmrGuiCookieName(port)}=${token}`,
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          resolve({ status: res.statusCode ?? 502, body: record(parsed) });
        });
        res.on("error", gone);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", gone);
    req.end(payload);
  });
}

/** The session a More Actions request names: the one this process runs, or one the catalogue lists. */
type Target = { id: string; live: true } | { id: string; live: false; info: SessionInfo };

async function findTarget(bridge: MmrGuiBridge, sessions: Pick<MmrGuiSessions, "find">, body: unknown): Promise<Target | MmrGuiCommandResult> {
  const { sessionId } = record(body);
  if (typeof sessionId !== "string" || sessionId === "") return invalid("Name the session by its id.");
  const ctx = bridge.context();
  if (ctx && ctx.sessionManager.getSessionId() === sessionId) return { id: sessionId, live: true };
  const info = await sessions.find(sessionId);
  return info ? { id: sessionId, live: false, info } : unknownSession;
}

/** The session's current branch as Markdown, or a 409 without ampi-threads. */
async function markdownOf(bridge: MmrGuiBridge, sessions: MmrGuiSessions, target: Target): Promise<string | MmrGuiCommandResult> {
  const reports = getMmrThreadReports();
  if (!reports) return conflict("Copying as Markdown needs the ampi-threads extension.");
  const ctx = bridge.context();
  if (target.live && ctx) {
    const manager = ctx.sessionManager;
    const header = manager.getHeader();
    return reports.markdown([...(header ? [header] : []), ...manager.getBranch()], {
      title: manager.getSessionName(),
      mode: liveModeName(),
    });
  }
  if (target.live) return conflict("The session has ended.");
  const { header, branch } = await sessions.read(target.info);
  return reports.markdown([...(header ? [header] : []), ...branch], {
    title: target.info.name,
    mode: persistedModeName(branch) ?? undefined,
  });
}

/** A session's title as `ampi threads` prints it: its name, else its first message, on one line without control characters. */
function exportTitle(info: SessionInfo): string {
  const clean = (text: string) => text.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim();
  return clean(info.name ?? "") || clean(info.firstMessage) || "untitled";
}

/**
 * The JSON export: the object `ampi threads export` prints, the session's
 * catalogue fields and thread metadata followed by every entry of its file
 * as written (lines that are not JSON are skipped, as Pi skips them).
 */
export function describeMmrGuiExport(info: SessionInfo, threadRecord: MmrThreadRecord | undefined, text: string): Record<string, unknown> {
  const entries = text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  return {
    id: info.id,
    title: exportTitle(info),
    ...(info.name?.trim() ? { name: info.name.trim() } : {}),
    created: info.created.toISOString(),
    updated: info.modified.toISOString(),
    messageCount: info.messageCount,
    cwd: info.cwd,
    path: info.path,
    ...(info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
    ...(threadRecord?.archived !== undefined ? { archived: threadRecord.archived } : {}),
    ...(threadRecord?.labels?.length ? { labels: threadRecord.labels } : {}),
    ...(threadRecord?.color !== undefined ? { color: threadRecord.color } : {}),
    ...(threadRecord?.pinned !== undefined ? { pinned: threadRecord.pinned } : {}),
    entries,
  };
}

/** A file to download, or a command result when there is none. */
export type MmrGuiExportResult = { status: 200; filename: string; contentType: string; text: string } | MmrGuiCommandResult;

export type MmrGuiExporter = (sessionId: string, format: string) => Promise<MmrGuiExportResult>;

/** `GET /api/export?sessionId=&format=markdown|json`: a session as a Markdown or JSON file. */
export function createMmrGuiExporter(bridge: MmrGuiBridge, sessions: MmrGuiSessions): MmrGuiExporter {
  return async (sessionId, format) => {
    if (format !== "markdown" && format !== "json") return invalid('format must be "markdown" or "json".');
    const target = await findTarget(bridge, sessions, { sessionId });
    if ("status" in target) return target;
    const base = target.id.replace(/[^A-Za-z0-9_-]/g, "_");
    if (format === "markdown") {
      const markdown = await markdownOf(bridge, sessions, target);
      if (typeof markdown !== "string") return markdown;
      return { status: 200, filename: `${base}.md`, contentType: "text/markdown; charset=utf-8", text: markdown };
    }
    // The session file as written, the live session's too once Pi has saved it.
    const info = target.live ? await sessions.find(target.id) : target.info;
    if (!info) return conflict("Pi has not saved this session yet; send a message first.");
    const threadRecord = await getMmrThreadIndex()
      ?.get(target.id)
      .catch(() => undefined);
    const value = describeMmrGuiExport(info, threadRecord, await sessions.text(info));
    return { status: 200, filename: `${base}.json`, contentType: "application/json; charset=utf-8", text: `${JSON.stringify(value, null, 2)}\n` };
  };
}

export interface MmrGuiCommandOptions {
  /** Archive, snooze and read dates; defaults to the current time. */
  now?: () => string;
  /** Where the live registry is, to find the process that holds a session. */
  registry?: MmrLiveRegistryOptions;
  /** This process's pid, left out when renaming; defaults to `process.pid`. */
  pid?: number;
  /** The Git branch in a directory; defaults to {@link readMmrGuiGitBranch}. */
  gitBranch?: (cwd: string) => Promise<string | null>;
}

export function createMmrGuiCommands(
  pi: Pick<ExtensionAPI, "sendUserMessage" | "setSessionName">,
  bridge: MmrGuiBridge,
  sessions: MmrGuiSessions,
  options: MmrGuiCommandOptions = {},
): MmrGuiCommands {
  const now = options.now ?? (() => new Date().toISOString());
  const registry = options.registry ?? {};
  const pid = options.pid ?? process.pid;
  const gitBranch = options.gitBranch ?? readMmrGuiGitBranch;

  /** Apply `patch` to the session's thread index record; 400 for a value the index refuses. */
  async function updateIndex(body: unknown, what: string, patch: MmrThreadRecordPatch): Promise<MmrGuiCommandResult> {
    const target = await findTarget(bridge, sessions, body);
    if ("status" in target) return target;
    const index = getMmrThreadIndex();
    if (!index) return conflict(`${what} needs the ampi-threads extension.`);
    try {
      return ok({ record: (await index.update(target.id, patch)) ?? {} });
    } catch (error) {
      if (isIndexError(error)) return invalid(error.message);
      throw error;
    }
  }

  const flag = (body: unknown, key: string): boolean | MmrGuiCommandResult => {
    const value = record(body)[key];
    return typeof value === "boolean" ? value : invalid(`${key} must be true or false.`);
  };

  return {
    async markdown(body) {
      const target = await findTarget(bridge, sessions, body);
      if ("status" in target) return target;
      const markdown = await markdownOf(bridge, sessions, target);
      return typeof markdown === "string" ? ok({ markdown }) : markdown;
    },
    async archive(body) {
      const archived = flag(body, "archived");
      if (typeof archived !== "boolean") return archived;
      const result = await updateIndex(body, "Archiving", { archived: archived ? now() : null });
      return result.status === 200 ? ok({ archived }) : result;
    },
    async pin(body) {
      const pinned = flag(body, "pinned");
      if (typeof pinned !== "boolean") return pinned;
      return updateIndex(body, "Pinning", { pinned: pinned ? true : null });
    },
    async color(body) {
      const { color } = record(body);
      if (color !== null && typeof color !== "string") return invalid("color must be a colour name, #rrggbb or null.");
      return updateIndex(body, "Colours", { color: color === null ? null : color.trim().toLowerCase() });
    },
    async labels(body) {
      const { labels } = record(body);
      if (!Array.isArray(labels)) return invalid("labels must be a list of strings.");
      return updateIndex(body, "Labels", { labels });
    },
    async snooze(body) {
      const snoozed = flag(body, "snoozed");
      if (typeof snoozed !== "boolean") return snoozed;
      return updateIndex(body, "Snoozing", { snoozed: snoozed ? now() : null });
    },
    async unread(body) {
      const unread = flag(body, "unread");
      if (typeof unread !== "boolean") return unread;
      return updateIndex(body, "Unread marks", unread ? { unread: true } : { unread: null, readAt: now() });
    },
    async cost(body) {
      const target = await findTarget(bridge, sessions, body);
      if ("status" in target) return target;
      const reports = getMmrThreadReports();
      if (!reports) return conflict("The cost report needs the ampi-threads extension.");
      if (!reports.showCosts) return conflict("Costs are turned off (ampiThreads.showCosts).");
      const ctx = bridge.context();
      if (target.live && ctx) return ok({ cost: reports.cost(ctx) });
      if (target.live) return conflict("The session has ended.");
      return ok({ cost: reports.costOfEntries((await sessions.read(target.info)).entries) });
    },
    async running(body) {
      const target = await findTarget(bridge, sessions, body);
      if ("status" in target) return target;
      const ctx = bridge.context();
      if (target.live && ctx) {
        const where: MmrGuiRunningWhere = getMmrGuiHost()?.role === "session" ? "app" : "this-terminal";
        return ok({ where, pid, phase: bridge.status().phase, cwd: ctx.cwd, branch: await gitBranch(ctx.cwd) });
      }
      if (target.live) return conflict("The session has ended.");
      const owner = await findMmrLiveOwner(target.info.path, { ...registry, exceptPid: pid });
      const cwd = target.info.cwd;
      return ok({
        where: owner ? WHERE[owner.kind] : "none",
        pid: owner?.pid ?? null,
        phase: owner?.status?.phase ?? null,
        cwd,
        branch: await gitBranch(cwd),
      });
    },
    async rename(body) {
      const raw = record(body).name;
      const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
      if (name === "") return invalid("Type a name.");
      if (name.length > MMR_GUI_MAX_NAME_LENGTH) return invalid("The name is too long.");
      const target = await findTarget(bridge, sessions, body);
      if ("status" in target) return target;
      if (target.live) {
        pi.setSessionName(name);
      } else {
        // One writer per session file: the process that has it open renames it, or nobody may.
        const owner = await findMmrLiveOwner(target.info.path, { ...registry, exceptPid: pid });
        if (owner) {
          // A holder with a web GUI (a terminal, or a session ampi app hosts) renames its own session; one without stays read-only.
          const token = owner.gui ? await readMmrLiveToken(owner, registry) : undefined;
          if (owner.gui && token !== undefined) return postToMmrGui(owner.gui.port, token, "rename", { sessionId: target.id, name });
          return held(owner, "rename it there");
        }
        SessionManager.open(target.info.path).appendSessionInfo(name);
        sessions.invalidate();
      }
      // As the terminal's rename does: a typed title is never replaced by a generated one.
      await getMmrThreadIndex()?.update(target.id, { titleSource: "user" });
      return ok({ name });
    },
    async delete(body) {
      const target = await findTarget(bridge, sessions, body);
      if ("status" in target) return target;
      if (target.live) return conflict("This process runs this session; it cannot delete it while it runs.");
      const owner = await findMmrLiveOwner(target.info.path, registry);
      if (owner) return held(owner, "close it there before deleting it");
      try {
        await unlink(target.info.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      sessions.invalidate();
      try {
        await getMmrThreadIndex()?.remove(target.id);
      } catch (error) {
        return ok({ warning: `The session was deleted, but its thread metadata was not: ${error instanceof Error ? error.message : String(error)}` });
      }
      return ok();
    },
    send(body) {
      const { text, deliverAs } = record(body);
      if (typeof text !== "string" || text.trim() === "") return invalid("Type a message to send.");
      if (text.length > MMR_GUI_MAX_PROMPT_LENGTH) return invalid("The message is too long.");
      if (deliverAs !== undefined && deliverAs !== "steer" && deliverAs !== "followUp") return invalid('deliverAs must be "steer" or "followUp".');
      const ctx = bridge.context();
      if (!ctx) return conflict("The session has ended.");
      if (bridge.status().phase === "compacting") return conflict("Pi is compacting the conversation. Send again when it is done.");
      const idle = ctx.isIdle();
      const mode = deliverAs ?? "steer";
      // Pi uses `deliverAs` only while a turn runs, so a turn that starts
      // between the check and the call still gets the message queued.
      // Expanded like a typed prompt, so templates and skills work as in the terminal.
      pi.sendUserMessage(text.trim(), { deliverAs: mode, expandPromptTemplates: true });
      return ok({ delivered: idle ? "prompt" : mode });
    },
    dequeue(body) {
      const { kind, index, text } = record(body);
      if (kind !== "steering" && kind !== "followUp") return invalid('kind must be "steering" or "followUp".');
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || typeof text !== "string") {
        return invalid("Name the queued message by its index and text.");
      }
      if (!bridge.context()) return conflict("The session has ended.");
      if (!getMmrPromptQueue()) return conflict("This session does not show ampi its queue.");
      if (!removeMmrQueuedPrompt(kind, index, text)) return conflict("That message is no longer queued.");
      return ok({ text });
    },
    "steer-next"() {
      const ctx = bridge.context();
      if (!ctx) return conflict("The session has ended.");
      const command = getMmrCommand(STEER_COMMAND_ID);
      if (!command) return conflict("This session cannot steer a queued message.");
      const availability = command.availability?.(ctx) ?? { state: "available" };
      if (availability.state !== "available") return conflict(availability.reason ?? "No queued message can steer now.");
      return Promise.resolve(command.run(ctx)).then(() => ok());
    },
    dialog(body) {
      const { id, value, cancelled } = record(body);
      if (typeof id !== "string" || id === "") return invalid("Name the question by its id.");
      if (cancelled !== true && value === undefined) return invalid("Send a value, or cancelled: true.");
      const result = bridge.answerDialog(id, cancelled === true ? { cancelled: true } : { value });
      if (result === "unknown") return conflict("That question is no longer open.");
      if (result === "invalid") return invalid("That answer does not fit the question.");
      return ok();
    },
    interrupt() {
      const ctx = bridge.context();
      if (!ctx) return conflict("The session has ended.");
      // A tool that waits for an answer is refused rather than left waiting.
      const cancelled = bridge.cancelDialogs("interrupt");
      if (ctx.isIdle()) return cancelled > 0 ? ok() : conflict("Nothing is running.");
      bridge.interrupted();
      // The terminal's own command, so its status shows the interruption too.
      const command = getMmrCommand(INTERRUPT_COMMAND_ID);
      if (command) return Promise.resolve(command.run(ctx)).then(() => ok());
      ctx.abort();
      return ok();
    },
  };
}
