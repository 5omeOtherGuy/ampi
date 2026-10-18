import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type FileEntry, migrateSessionEntries, parseSessionEntries, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { dedupeMmrSessionsById, type MmrSessionSource } from "../ampi-core/session-catalog.js";
import { findLatestPersistedModeState } from "../ampi-core/state.js";
import { getMmrThreadIndex, type MmrThreadIndex, type MmrThreadRecord } from "../ampi-core/thread-index.js";
import { getMmrThreadReports } from "../ampi-core/thread-reports.js";
import type { MmrGuiSessionInfo } from "./bridge.js";
import { buildMmrGuiTranscript, type MmrGuiGroup, type MmrGuiItem, mmrGuiSessionTitle } from "./view-model.js";

/**
 * The sessions the web GUI's sidebar lists, and read-only views of them.
 *
 * Sessions are Pi's own sessions on disk, from ampi-core's session
 * catalogue; whether one is archived or pinned, and its colour, come from
 * the thread index that `ampi-threads` registers. The session this process
 * runs is always listed, even before Pi has saved it, and is marked `live`;
 * a session that another running Pi serves (the live registry) is marked
 * `elsewhere`.
 *
 * Groups, each sorted by last activity, newest first:
 *
 * | Group                | Holds |
 * | -------------------- | ----- |
 * | `pinned`             | pinned sessions that are not archived |
 * | `project:<cwd>`      | the other sessions active in the last 72 hours, or running, one group per working directory, the group with the newest session first |
 * | `inactive-72h`       | the rest that are not archived |
 * | `archived`           | archived sessions |
 *
 * Empty groups are left out. Reading a session never writes it: the file is
 * parsed in memory (Pi's own parser and format migration), never opened with
 * a session manager, which may rewrite an old file.
 */

/** Sessions without activity for this long leave their project group. */
export const MMR_GUI_INACTIVE_AFTER_MS = 72 * 60 * 60 * 1000;

const LIST_TTL_MS = 5_000;

export interface MmrGuiSessionRow {
  id: string;
  title: string;
  cwd: string;
  /** Last activity, ISO 8601. */
  modified: string;
  messageCount: number;
  /** The colour set in the thread index (a name or `#rrggbb`), or `null` for the colour hashed from the id. */
  color: string | null;
  pinned: boolean;
  archived: boolean;
  /** This process runs the session. */
  live: boolean;
  /** Another running Pi serves the session. */
  elsewhere: boolean;
}

export interface MmrGuiSessionGroup {
  id: string;
  kind: "pinned" | "project" | "inactive" | "archived";
  label: string;
  /** The working directory of a project group. */
  cwd?: string;
  sessions: MmrGuiSessionRow[];
}

export interface MmrGuiSessionList {
  /** The id of the session this process runs. */
  currentId: string | null;
  groups: MmrGuiSessionGroup[];
  /** Which More Actions work: archiving needs the thread index, Markdown its formatter. */
  actions: { archive: boolean; markdown: boolean };
}

/** A session as the page shows it read-only. */
export interface MmrGuiSessionView {
  session: MmrGuiSessionInfo;
  row: MmrGuiSessionRow;
  items: MmrGuiItem[];
  groups: MmrGuiGroup[];
}

export interface MmrGuiGroupInput {
  sessions: readonly SessionInfo[];
  threads: Readonly<Record<string, MmrThreadRecord>>;
  /** The session this process runs. */
  current?: Pick<MmrGuiSessionInfo, "id" | "title" | "cwd">;
  /** Session files that other running Pi processes serve. */
  elsewhere?: ReadonlySet<string>;
  now: number;
  home?: string;
}

/** A project group's name: the last segment of its working directory, `~` for the home directory. */
export function mmrGuiProjectLabel(cwd: string, home = homedir()): string {
  if (cwd === "") return "No project";
  if (path.resolve(cwd) === path.resolve(home)) return "~";
  return path.basename(cwd) || cwd;
}

function rowTitle(info: SessionInfo): string {
  const first = info.firstMessage ? [{ type: "user" as const, id: "", text: info.firstMessage, images: 0, timestamp: 0 }] : [];
  return mmrGuiSessionTitle(info.name, first);
}

function byActivity(a: MmrGuiSessionRow, b: MmrGuiSessionRow): number {
  return b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id);
}

/** The sidebar's groups for a catalogue listing and the thread index; see the module comment. */
export function groupMmrGuiSessions(input: MmrGuiGroupInput): MmrGuiSessionGroup[] {
  const { current, threads, now } = input;
  const elsewhere = new Set([...(input.elsewhere ?? [])].map((file) => path.resolve(file)));
  const rows: MmrGuiSessionRow[] = [];
  for (const info of dedupeMmrSessionsById(input.sessions)) {
    const record = Object.hasOwn(threads, info.id) ? threads[info.id] : undefined;
    const live = info.id === current?.id;
    rows.push({
      id: info.id,
      title: live && current ? current.title : rowTitle(info),
      cwd: info.cwd,
      modified: info.modified.toISOString(),
      messageCount: info.messageCount,
      color: record?.color ?? null,
      pinned: record?.pinned === true,
      archived: record?.archived !== undefined,
      live,
      elsewhere: !live && elsewhere.has(path.resolve(info.path)),
    });
  }
  // Pi saves a session only once it has a message; until then it is listed from the running process.
  if (current?.id && !rows.some((row) => row.live)) {
    const record = Object.hasOwn(threads, current.id) ? threads[current.id] : undefined;
    rows.push({
      id: current.id,
      title: current.title,
      cwd: current.cwd,
      modified: new Date(now).toISOString(),
      messageCount: 0,
      color: record?.color ?? null,
      pinned: record?.pinned === true,
      archived: record?.archived !== undefined,
      live: true,
      elsewhere: false,
    });
  }
  rows.sort(byActivity);

  const pinned: MmrGuiSessionRow[] = [];
  const inactive: MmrGuiSessionRow[] = [];
  const archived: MmrGuiSessionRow[] = [];
  const projects = new Map<string, MmrGuiSessionRow[]>();
  for (const row of rows) {
    if (row.archived) archived.push(row);
    else if (row.pinned) pinned.push(row);
    else if (row.live || row.elsewhere || now - Date.parse(row.modified) <= MMR_GUI_INACTIVE_AFTER_MS) {
      const group = projects.get(row.cwd) ?? [];
      group.push(row);
      projects.set(row.cwd, group);
    } else inactive.push(row);
  }

  const groups: MmrGuiSessionGroup[] = [];
  if (pinned.length > 0) groups.push({ id: "pinned", kind: "pinned", label: "Pinned", sessions: pinned });
  // Rows are sorted already, so each project's first row is its newest and Map order follows it.
  for (const [cwd, sessions] of projects) {
    groups.push({ id: `project:${cwd}`, kind: "project", label: mmrGuiProjectLabel(cwd, input.home), cwd, sessions });
  }
  if (inactive.length > 0) groups.push({ id: "inactive-72h", kind: "inactive", label: "Inactive Last 72h", sessions: inactive });
  if (archived.length > 0) groups.push({ id: "archived", kind: "archived", label: "Archived", sessions: archived });
  return groups;
}

/** A session file's header and current branch, the way Pi reads them, without writing the file. */
export function readMmrGuiSessionEntries(text: string): { header: FileEntry | undefined; branch: FileEntry[] } {
  const entries = parseSessionEntries(text);
  // Upgrades old entry shapes in memory only.
  migrateSessionEntries(entries);
  const header = entries.find((entry) => entry.type === "session");
  const byId = new Map<string, FileEntry & { id: string; parentId?: string | null }>();
  let leaf: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session" || typeof (entry as { id?: unknown }).id !== "string") continue;
    const withId = entry as FileEntry & { id: string; parentId?: string | null };
    byId.set(withId.id, withId);
    leaf = withId.id;
  }
  const branch: FileEntry[] = [];
  const seen = new Set<string>();
  let node = leaf ? byId.get(leaf) : undefined;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    branch.push(node);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return { header, branch: branch.reverse() };
}

export interface MmrGuiSessionsOptions {
  /** The session catalogue; defaults come from `index.ts`. */
  source: Pick<MmrSessionSource, "listSessions">;
  /** The session this process runs, while it runs. */
  current: () => MmrGuiSessionInfo | undefined;
  /** Session files other running Pi processes serve. */
  elsewhere?: () => Promise<readonly string[]>;
  threadIndex?: () => MmrThreadIndex | undefined;
  readText?: (file: string) => Promise<string>;
  now?: () => number;
  home?: string;
}

export interface MmrGuiSessions {
  list(): Promise<MmrGuiSessionList>;
  /** A session's catalogue record, by exact id. */
  find(id: string): Promise<SessionInfo | undefined>;
  /** A saved session's header and current branch, read without writing. */
  read(info: SessionInfo): Promise<{ header: FileEntry | undefined; branch: FileEntry[] }>;
  /** The read-only view of a saved session, or `undefined` for an unknown id. */
  view(id: string): Promise<MmrGuiSessionView | undefined>;
}

export function createMmrGuiSessions(options: MmrGuiSessionsOptions): MmrGuiSessions {
  const now = options.now ?? Date.now;
  const home = options.home ?? homedir();
  const threadIndex = options.threadIndex ?? getMmrThreadIndex;
  const readText = options.readText ?? ((file: string) => readFile(file, "utf8"));
  let cache: { at: number; sessions: SessionInfo[] } | undefined;

  async function catalogue(): Promise<SessionInfo[]> {
    if (cache && now() - cache.at < LIST_TTL_MS) return cache.sessions;
    const sessions = dedupeMmrSessionsById(await options.source.listSessions());
    cache = { at: now(), sessions };
    return sessions;
  }

  async function threads(): Promise<Readonly<Record<string, MmrThreadRecord>>> {
    try {
      return (await threadIndex()?.list()) ?? {};
    } catch {
      // An unreadable index lists every session as unarchived; ampi-threads reports the file.
      return {};
    }
  }

  async function groups(): Promise<MmrGuiSessionGroup[]> {
    const [sessions, records, elsewhere] = await Promise.all([catalogue(), threads(), options.elsewhere?.().catch(() => []) ?? []]);
    return groupMmrGuiSessions({ sessions, threads: records, current: options.current(), elsewhere: new Set(elsewhere), now: now(), home });
  }

  const sessions: MmrGuiSessions = {
    async list() {
      const current = options.current();
      return {
        currentId: current?.id || null,
        groups: await groups(),
        actions: { archive: threadIndex() !== undefined, markdown: getMmrThreadReports()?.markdown !== undefined },
      };
    },
    async find(id) {
      return (await catalogue()).find((info) => info.id === id);
    },
    async read(info) {
      return readMmrGuiSessionEntries(await readText(info.path));
    },
    async view(id) {
      const info = await sessions.find(id);
      if (!info) return undefined;
      const row = (await groups()).flatMap((group) => group.sessions).find((candidate) => candidate.id === id);
      if (!row) return undefined;
      const { branch } = await sessions.read(info);
      const transcript = buildMmrGuiTranscript(branch, { cwd: info.cwd, home });
      return {
        session: {
          id: info.id,
          title: row.title,
          cwd: info.cwd,
          mode: findLatestPersistedModeState(branch)?.mode ?? null,
          model: null,
        },
        row,
        ...transcript,
      };
    },
  };
  return sessions;
}
