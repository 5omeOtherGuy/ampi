// `ampi top` (packages/ampi-cli/src/top.js): the table of running sessions
// at 80 and 140 columns with hand-written expected text, the order, the
// `--json` record and the `--stream-jsonl` lines for a scripted sequence of
// registry changes, the full-screen view on a fake terminal, the watcher's
// fallback while the registry directory is missing, and spawned runs of the
// executable. Registry entries are JSON files in a temporary directory;
// process probes, clock, terminal size, watcher and timer are injected.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createLogger } from "../packages/ampi-cli/src/log.js";
import {
  cutMiddle,
  formatTopLines,
  formatTopRecord,
  formatUptime,
  runTopCommand,
  sortTopEntries,
  TOP_EMPTY,
  watchLiveRegistry,
} from "../packages/ampi-cli/src/top.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoRoot, "packages", "ampi-cli", "bin", "ampi.js");
const temporary = mkdtempSync(path.join(tmpdir(), "ampi-cli-top-"));
after(() => rmSync(temporary, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const HOME = "/home/ada";
const TOKEN_HASH = "ab".repeat(32);
/** A GUI access token as a terminal saves it beside its entry, in `<pid>.token`. */
const TOKEN = ["tok", "en-", "cd".repeat(16)].join("");
const PORTS = [43117, 43118, 43119];
const ENTER = "\x1b[?1049h\x1b[?25l";
const LEAVE = "\x1b[?25h\x1b[?1049l";

const gui = (port) => ({ port, tokenHash: TOKEN_HASH });
const entry = (fields) => ({
  version: 2,
  procStart: null,
  kind: "tui",
  sessionId: `s-${fields.pid}`,
  sessionPath: `/home/ada/.pi/agent/sessions/s-${fields.pid}.jsonl`,
  gui: null,
  ...fields,
});

/** Every kind of row the table has, in an order that is not the table's. */
const ENTRIES = [
  entry({
    pid: 4242,
    status: { phase: "runningTools", label: "Running Tools" },
    title: "Fix the flaky build test",
    mode: "high",
    cwd: "/home/ada/src/ampi",
    startedAt: "2026-10-18T09:48:00.000Z",
    updatedAt: "2026-10-18T09:59:58.000Z",
  }),
  entry({
    pid: 4100,
    status: { phase: "idle", label: "" },
    title: "Release notes",
    mode: "medium",
    cwd: "/work/demo",
    startedAt: "2026-10-16T09:00:00.000Z",
    updatedAt: "2026-10-18T09:59:00.000Z",
  }),
  entry({
    pid: 5001,
    kind: "execute",
    status: { phase: "thinking", label: "Thinking" },
    title: null,
    mode: "low",
    cwd: "/work/demo",
    startedAt: "2026-10-18T09:59:48.000Z",
    updatedAt: "2026-10-18T09:59:59.000Z",
  }),
  entry({
    pid: 6000,
    kind: "app",
    sessionId: "app-own",
    sessionPath: null,
    status: { phase: "idle", label: "" },
    title: null,
    mode: "medium",
    cwd: HOME,
    startedAt: "2026-10-18T07:00:00.000Z",
    updatedAt: "2026-10-18T07:00:00.000Z",
    gui: gui(PORTS[0]),
  }),
  entry({
    pid: 6001,
    kind: "app-session",
    ownerPid: 6000,
    status: { phase: "idle", label: "" },
    title: "Rewrite the session catalogue so it reads every directory at once",
    mode: "ultra",
    cwd: "/srv/projects/customer-portal/packages/frontend/components/settings",
    startedAt: "2026-10-18T09:30:00.000Z",
    updatedAt: "2026-10-18T09:58:00.000Z",
    gui: gui(PORTS[1]),
  }),
  entry({
    pid: 4300,
    status: { phase: "idle", label: "" },
    title: "日本語のタイトルをテストする長い名前",
    mode: "free",
    cwd: HOME,
    startedAt: "2026-10-18T09:57:00.000Z",
    updatedAt: "2026-10-18T09:57:00.000Z",
  }),
];
/** A version 1 file, as an older ampi-gui wrote it. */
const V1 = { version: 1, pid: 3000, port: PORTS[2], tokenHash: TOKEN_HASH, cwd: "/work/legacy", sessionPath: "/work/legacy/s.jsonl", startedAt: "2026-10-18T09:00:00.000Z" };

const dirs = [];
function registryDir(files = []) {
  const root = mkdtempSync(path.join(temporary, "registry-"));
  dirs.push(root);
  const dir = path.join(root, "live");
  mkdirSync(dir);
  for (const file of files) writeEntry(dir, file);
  return dir;
}
const writeEntry = (dir, file) => writeFileSync(path.join(dir, `${file.pid}.json`), `${JSON.stringify(file, null, 2)}\n`);

/** A host on a fake terminal whose watcher, timer, keys, resize, signals and exit the test drives. */
function fakeHost(dir, { isTTY = true, columns = 80, rows = 24, alive = () => true } = {}) {
  const state = { out: "", err: "", clock: NOW, raw: false, closed: [] };
  /** @type {Record<string, ((...args: any[]) => void) | undefined>} */
  const fire = {};
  const subscribe = (name) => (callback) => {
    fire[name] = callback;
    if (name === "keys") state.raw = true;
    return () => {
      state.closed.push(name);
      if (name === "keys") state.raw = false;
      fire[name] = undefined;
    };
  };
  const host = {
    dir,
    now: () => state.clock,
    isAlive: alive,
    procStart: () => null,
    columns,
    rows,
    isTTY,
    home: HOME,
    out: (text) => {
      state.out += text;
    },
    log: createLogger({
      stderr: (text) => {
        state.err += text;
      },
    }),
    watch: (_dir, onChange) => subscribe("watch")(onChange),
    interval: (callback) => subscribe("interval")(callback),
    keys: subscribe("keys"),
    onResize: subscribe("resize"),
    onSignal: subscribe("signal"),
    onExit: subscribe("exit"),
  };
  return { host, state, fire };
}

/** Run the command to its end, collecting its output. */
async function runTop(args, dir, options) {
  const { host, state } = fakeHost(dir, { isTTY: false, ...options });
  const code = await runTopCommand(args, host);
  return { code, out: state.out, err: state.err };
}

const assertNoSecrets = (text) => {
  assert.ok(!text.includes(TOKEN_HASH), "no token hash");
  assert.ok(!text.includes(TOKEN), "no token");
  for (const port of PORTS) assert.ok(!text.includes(String(port)), `no port ${port}`);
  assert.ok(!text.includes("tokenHash") && !text.includes(`"port"`), "no GUI fields");
};

const TABLE_80 = `6 sessions running

Status           Title       Mode    Directory                 Kind    Up    PID
───────────────  ──────────  ──────  ────────────────────────  ──────  ───  ────
● Thinking       -           low     /work/demo                -x      12s  5001
● Running Tools  Fix the f…  high    ~/src/ampi                tui     12m  4242
Idle             Release n…  medium  /work/demo                tui     2d   4100
Idle             Rewrite t…  ultra   /srv/project…ts/settings  hosted  30m  6001
Idle             日本語の…   free    ~                         tui     3m   4300
-                -           -       /work/legacy              tui     1h   3000
Idle             app         medium  ~                         app     3h   6000`;

const TABLE_140 = `6 sessions running

Status           Title                                                           Mode    Directory                         Kind    Up    PID
───────────────  ──────────────────────────────────────────────────────────────  ──────  ────────────────────────────────  ──────  ───  ────
● Thinking       -                                                               low     /work/demo                        -x      12s  5001
● Running Tools  Fix the flaky build test                                        high    ~/src/ampi                        tui     12m  4242
Idle             Release notes                                                   medium  /work/demo                        tui     2d   4100
Idle             Rewrite the session catalogue so it reads every directory at…   ultra   /srv/projects/cu…onents/settings  hosted  30m  6001
Idle             日本語のタイトルをテストする長い名前                            free    ~                                 tui     3m   4300
-                -                                                               -       /work/legacy                      tui     1h   3000
Idle             app                                                             medium  ~                                 app     3h   6000`;

describe("ampi top: the table", () => {
  const dir = registryDir([...ENTRIES, V1]);

  it("lays out every kind of row at 80 and 140 columns, cutting titles at the end and directories in the middle", async () => {
    const { readLiveEntries } = await import("../packages/ampi-cli/src/live-registry.js");
    const entries = readLiveEntries({ dir, isAlive: () => true, procStart: () => null });
    assert.equal(formatTopLines(entries, { now: NOW, columns: 80, home: HOME }).join("\n"), TABLE_80);
    assert.equal(formatTopLines(entries, { now: NOW, columns: 140, home: HOME }).join("\n"), TABLE_140);
    for (const [table, columns] of [
      [TABLE_80, 80],
      [TABLE_140, 140],
    ]) {
      const widths = table.split("\n").map((line) => [...line].reduce((sum, char) => sum + (/[　-鿿]/.test(char) ? 2 : 1), 0));
      assert.ok(Math.max(...widths) <= columns, `fits ${columns} columns`);
    }
  });

  it("prints the table once, whole, when stdout is not a terminal, and never a token hash or port", async () => {
    const { code, out, err } = await runTop([], dir);
    assert.equal(code, 0, err);
    const lines = out.split("\n");
    assert.equal(lines[0], "6 sessions running");
    assert.ok(out.includes("  Rewrite the session catalogue so it reads every directory at once  "));
    assert.ok(out.includes("  /srv/projects/customer-portal/packages/frontend/components/settings  "));
    assert.ok(!out.includes("…"));
    assertNoSecrets(out);
  });

  it("says nothing runs when the registry is empty or missing", async () => {
    assert.deepEqual(await runTop([], registryDir()), { code: 0, out: `${TOP_EMPTY}\n`, err: "" });
    assert.deepEqual(await runTop([], path.join(temporary, "no-such", "live")), { code: 0, out: `${TOP_EMPTY}\n`, err: "" });
  });

  it("counts sessions without the ampi app row, which it still lists", () => {
    const [hub] = ENTRIES.filter((e) => e.kind === "app");
    assert.deepEqual(formatTopLines([hub], { now: NOW, columns: 80, home: HOME }).slice(0, 1), ["0 sessions running"]);
    assert.deepEqual(formatTopLines([ENTRIES[0], hub], { now: NOW, columns: 80, home: HOME }).slice(0, 1), ["1 session running"]);
  });

  it("puts working sessions first, then the latest update first, then the lower pid", () => {
    const at = (time) => `2026-10-18T09:${time}.000Z`;
    const status = (phase) => ({ phase, label: phase });
    const entries = [
      entry({ pid: 10, status: status("idle"), updatedAt: at("59:00"), startedAt: at("00:00"), cwd: "/a", title: null, mode: null }),
      entry({ pid: 20, status: status("error"), updatedAt: at("59:30"), startedAt: at("00:00"), cwd: "/a", title: null, mode: null }),
      entry({ pid: 30, status: status("streaming"), updatedAt: at("10:00"), startedAt: at("00:00"), cwd: "/a", title: null, mode: null }),
      entry({ pid: 40, status: null, updatedAt: at("59:30"), startedAt: at("00:00"), cwd: "/a", title: null, mode: null }),
      entry({ pid: 50, status: status("compacting"), updatedAt: at("20:00"), startedAt: at("00:00"), cwd: "/a", title: null, mode: null }),
      entry({ pid: 5, status: status("waitingApproval"), updatedAt: at("20:00"), startedAt: at("00:00"), cwd: "/a", title: null, mode: null }),
    ];
    assert.deepEqual(
      sortTopEntries(entries).map((e) => e.pid),
      [5, 50, 30, 20, 40, 10],
    );
  });

  it("floors the time since start to seconds, minutes, hours or days, on both sides of each step", () => {
    const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();
    assert.deepEqual(
      [0, 59, 60, 3599, 3600, 86_399, 86_400, 10 * 86_400 + 5].map((seconds) => formatUptime(ago(seconds), NOW)),
      ["0s", "59s", "1m", "59m", "1h", "23h", "1d", "10d"],
    );
    assert.equal(formatUptime(new Date(NOW + 90_000).toISOString(), NOW), "0s", "a start in the future");
  });

  it("cuts a path in the middle at whole characters, giving a wide character's spare column to the end", () => {
    assert.equal(cutMiddle("/srv/projects/app", 40), "/srv/projects/app");
    assert.equal(cutMiddle("/srv/projects/customer-portal", 11), "/srv/…ortal");
    assert.equal(cutMiddle("/日本/語のタ/イトル", 9), "/日…トル");
    assert.equal(cutMiddle("abc", 1), "…");
  });

  it("prints control characters in status, title, mode and directory as spaces, so each row stays one line", () => {
    const lines = formatTopLines(
      [
        entry({
          pid: 7000,
          status: { phase: "idle", label: "Idle\x1b[2J" },
          title: "Two\nlines",
          mode: "hi\x1b[31mgh",
          cwd: "/work/a\rb",
          startedAt: "2026-10-18T09:59:00.000Z",
          updatedAt: "2026-10-18T09:59:00.000Z",
        }),
      ],
      { now: NOW, columns: 140, home: HOME },
    );
    assert.equal(lines.length, 5);
    assert.equal(lines[4], "Idle [2J  Two lines  hi [31mgh  /work/a b  tui   1m  7000");
    for (const line of lines) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/, JSON.stringify(line));
  });

  it("ends the rows that do not fit the screen with a line counting them", () => {
    const lines = formatTopLines([...ENTRIES], { now: NOW, columns: 80, rows: 8, home: HOME });
    assert.equal(lines.length, 8);
    assert.deepEqual(lines.slice(4), [
      "● Thinking       -           low     /work/demo                -x      12s  5001",
      "● Running Tools  Fix the f…  high    ~/src/ampi                tui     12m  4242",
      "Idle             Release n…  medium  /work/demo                tui     2d   4100",
      "… 3 more",
    ]);
  });
});

describe("ampi top: JSON", () => {
  it("prints one snapshot for --json, in the stream line's shape and the table's order", async () => {
    const dir = registryDir([...ENTRIES, V1]);
    const { code, out, err } = await runTop(["--json"], dir);
    assert.equal(code, 0, err);
    assert.equal(out.split("\n").length, 2, "one line");
    assertNoSecrets(out);
    const record = JSON.parse(out);
    assert.deepEqual(Object.keys(record), ["type", "time", "sessions"]);
    assert.equal(record.type, "sessions");
    assert.equal(record.time, "2026-10-18T10:00:00.000Z");
    assert.deepEqual(
      record.sessions.map((session) => session.pid),
      [5001, 4242, 4100, 6001, 4300, 3000, 6000],
    );
    assert.deepEqual(record.sessions[3], {
      pid: 6001,
      kind: "app-session",
      ownerPid: 6000,
      sessionId: "s-6001",
      sessionPath: "/home/ada/.pi/agent/sessions/s-6001.jsonl",
      cwd: "/srv/projects/customer-portal/packages/frontend/components/settings",
      title: "Rewrite the session catalogue so it reads every directory at once",
      mode: "ultra",
      status: { phase: "idle", label: "" },
      startedAt: "2026-10-18T09:30:00.000Z",
      updatedAt: "2026-10-18T09:58:00.000Z",
      gui: true,
    });
    assert.deepEqual(record.sessions[5], {
      pid: 3000,
      kind: "tui",
      ownerPid: null,
      sessionId: null,
      sessionPath: "/work/legacy/s.jsonl",
      cwd: "/work/legacy",
      title: null,
      mode: null,
      status: null,
      startedAt: "2026-10-18T09:00:00.000Z",
      updatedAt: "2026-10-18T09:00:00.000Z",
      gui: true,
    });
    assert.equal(record.sessions[0].gui, false);
    assert.deepEqual(formatTopRecord([], NOW), { type: "sessions", time: "2026-10-18T10:00:00.000Z", sessions: [] });
  });

  it("skips the entries of processes that no longer run, and removes their files", async () => {
    const dir = registryDir([...ENTRIES, V1]);
    const { out } = await runTop(["--json"], dir, { alive: (pid) => pid !== 4242 && pid !== 3000 });
    assert.deepEqual(
      JSON.parse(out).sessions.map((session) => session.pid),
      [5001, 4100, 6001, 4300, 6000],
    );
    assert.deepEqual(readdirSync(dir).sort(), ["4100.json", "4300.json", "5001.json", "6000.json", "6001.json"]);
  });

  it("prints a line at once and one per change of the list, until a signal", async () => {
    const root = mkdtempSync(path.join(temporary, "stream-"));
    const dir = path.join(root, "live");
    const { host, state, fire } = fakeHost(dir, { isTTY: false });
    const done = runTopCommand(["--stream-jsonl"], host);
    const step = (seconds, change) => {
      state.clock = NOW + seconds * 1000;
      change();
      fire.watch();
    };
    const session = entry({
      pid: 4242,
      status: { phase: "idle", label: "" },
      title: null,
      mode: "medium",
      cwd: "/work/demo",
      startedAt: "2026-10-18T10:00:01.000Z",
      updatedAt: "2026-10-18T10:00:01.000Z",
      gui: gui(PORTS[0]),
    });
    step(1, () => {
      mkdirSync(dir);
      writeEntry(dir, session);
    });
    step(2, () => writeEntry(dir, { ...session, status: { phase: "runningTools", label: "Running Tools" }, updatedAt: "2026-10-18T10:00:02.000Z" }));
    step(3, () =>
      writeEntry(dir, { ...session, status: { phase: "runningTools", label: "Running Tools" }, title: "Build", updatedAt: "2026-10-18T10:00:02.000Z" }),
    );
    // Unchanged: the same entry written again, a temporary file, and a file that is not an entry.
    step(4, () =>
      writeEntry(dir, { ...session, status: { phase: "runningTools", label: "Running Tools" }, title: "Build", updatedAt: "2026-10-18T10:00:02.000Z" }),
    );
    step(5, () => writeFileSync(path.join(dir, "4242.json.4242.0a1b2c.tmp"), "{"));
    step(6, () => rmSync(path.join(dir, "4242.json.4242.0a1b2c.tmp")));
    step(7, () => {
      writeFileSync(path.join(dir, "notes.txt"), "not an entry");
      writeFileSync(path.join(dir, "4242.token"), TOKEN);
    });
    fire.interval();
    step(8, () => rmSync(path.join(dir, "4242.json")));
    fire.signal("SIGINT");
    assert.equal(await done, 0);
    const line = (time, sessions) => `{"type":"sessions","time":"2026-10-18T10:00:0${time}.000Z","sessions":[${sessions}]}\n`;
    const record = (fields) =>
      JSON.stringify({
        pid: 4242,
        kind: "tui",
        ownerPid: null,
        sessionId: "s-4242",
        sessionPath: "/home/ada/.pi/agent/sessions/s-4242.jsonl",
        cwd: "/work/demo",
        title: null,
        mode: "medium",
        status: { phase: "idle", label: "" },
        startedAt: "2026-10-18T10:00:01.000Z",
        updatedAt: "2026-10-18T10:00:01.000Z",
        gui: true,
        ...fields,
      });
    const busy = { status: { phase: "runningTools", label: "Running Tools" }, updatedAt: "2026-10-18T10:00:02.000Z" };
    assert.equal(
      state.out,
      line(0, "") + line(1, record({})) + line(2, record(busy)) + line(3, record({ ...busy, title: "Build" })) + line(8, ""),
    );
    assert.equal(state.err, "");
    assert.deepEqual(state.closed.sort(), ["exit", "interval", "signal", "watch"]);
    assertNoSecrets(state.out);
  });
});

describe("ampi top: the full-screen view", () => {
  const session = entry({
    pid: 4242,
    status: { phase: "streaming", label: "Streaming" },
    title: "Port the release scripts to the new runner",
    mode: "high",
    cwd: "/work/demo",
    startedAt: "2026-10-18T09:59:30.000Z",
    updatedAt: "2026-10-18T09:59:50.000Z",
    gui: gui(PORTS[0]),
  });
  const frame = (lines) => `\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
  const FRAME = frame([
    "1 session running  (q to quit)",
    "",
    "Status       Title                                       Mode  Directory   Kind  Up    PID",
    "───────────  ──────────────────────────────────────────  ────  ──────────  ────  ───  ────",
    "● Streaming  Port the release scripts to the new runner  high  /work/demo  tui   30s  4242",
  ]);

  for (const [name, quit, code] of [
    ["q", (fire) => fire.keys("q"), 0],
    ["Esc", (fire) => fire.keys("\x1b"), 0],
    ["Ctrl+C", (fire) => fire.keys("\x03"), 0],
    ["SIGTERM", (fire) => fire.signal("SIGTERM"), 0],
    ["SIGHUP", (fire) => fire.signal("SIGHUP"), 129],
  ]) {
    it(`draws on the alternate screen and restores the terminal on ${name}, exiting ${code}`, async () => {
      const { host, state, fire } = fakeHost(registryDir([session]), { columns: 100 });
      const done = runTopCommand([], host);
      assert.ok(state.raw, "raw mode while it runs");
      fire.keys("\x1b[A");
      fire.keys("\x1b[B");
      quit(fire);
      assert.equal(await done, code);
      assert.equal(state.out, ENTER + FRAME + LEAVE, "arrow keys neither quit nor draw");
      assert.equal(state.raw, false);
      assert.deepEqual(state.closed.sort(), ["exit", "interval", "keys", "resize", "signal", "watch"]);
      assertNoSecrets(state.out);
    });
  }

  it("restores the terminal when the process exits", async () => {
    const { host, state, fire } = fakeHost(registryDir([session]));
    const done = runTopCommand([], host);
    fire.exit();
    assert.equal(await done, 0);
    assert.ok(state.out.startsWith(ENTER) && state.out.endsWith(LEAVE));
    assert.equal(state.raw, false);
  });

  it("restores the terminal before it reports a registry it cannot read", async () => {
    const dir = registryDir([session]);
    const { host, state, fire } = fakeHost(dir);
    const done = runTopCommand([], host);
    host.isAlive = () => {
      throw new Error("probe failed");
    };
    fire.interval();
    assert.equal(await done, 1);
    assert.ok(state.out.endsWith(LEAVE));
    assert.equal(state.err, "ampi: cannot read the live registry: probe failed\n");
    assert.equal(state.raw, false);
  });

  it("draws again only when the screen would differ, and at the new width on a resize", async () => {
    const dir = registryDir([session]);
    const { host, state, fire } = fakeHost(dir, { columns: 80 });
    const done = runTopCommand([], host);
    const first = state.out;
    fire.watch();
    fire.interval();
    assert.equal(state.out, first, "nothing changed");

    state.clock = NOW + 1000;
    fire.interval();
    assert.ok(state.out.slice(first.length).includes("  31s  "), "the poll keeps Up current");

    const before = state.out.length;
    host.columns = 140;
    fire.resize();
    const wide = state.out.slice(before);
    assert.ok(wide.startsWith("\x1b[H") && wide.endsWith("\x1b[J"));
    const rule = wide.split("\r\n")[3];
    assert.equal(rule.replace("\x1b[K", "").length, 90, "the table's natural width at 140 columns");

    host.columns = 60;
    fire.resize();
    const narrow = state.out.slice(before + wide.length);
    assert.ok(narrow.includes("  Port the re…  "), "the title is cut at 60 columns");
    for (const line of narrow.slice(3, -3).replaceAll("\x1b[K", "").split("\r\n")) assert.ok(line.length <= 60, line);
    fire.keys("q");
    assert.equal(await done, 0);
  });

  it("follows a session that starts and one that ends, and shows the empty state in between", async () => {
    const dir = registryDir();
    const { host, state, fire } = fakeHost(dir, { columns: 100 });
    const done = runTopCommand([], host);
    assert.equal(state.out, `${ENTER}\x1b[H${TOP_EMPTY}  (q to quit)\x1b[K\x1b[J`);
    writeEntry(dir, session);
    fire.watch();
    assert.ok(state.out.endsWith(FRAME));
    rmSync(path.join(dir, "4242.json"));
    fire.watch();
    assert.ok(state.out.endsWith(`\x1b[H${TOP_EMPTY}  (q to quit)\x1b[K\x1b[J`));
    fire.keys("q");
    assert.equal(await done, 0);
  });
});

describe("ampi top: the registry watcher", () => {
  it("watches the parent while the directory is missing, then the directory once it appears", () => {
    const dir = "/agent/data/ampi/live";
    const present = new Set();
    const watched = [];
    const watch = (target, listener) => {
      const watcher = { target, listener, closed: false, on: () => watcher, close() {
          watcher.closed = true;
        },
      };
      watched.push(watcher);
      return watcher;
    };
    let changes = 0;
    const close = watchLiveRegistry(dir, () => changes++, { watch, exists: (file) => present.has(file) });
    assert.deepEqual(watched, [], "neither exists: only the poll");

    present.add("/agent/data/ampi");
    close.refresh();
    assert.deepEqual(
      watched.map((w) => w.target),
      ["/agent/data/ampi"],
    );

    present.add(dir);
    watched[0].listener("rename", "live");
    assert.equal(changes, 1);
    assert.deepEqual(
      watched.map((w) => [w.target, w.closed]),
      [
        ["/agent/data/ampi", true],
        [dir, false],
      ],
    );
    close.refresh();
    assert.equal(watched.length, 2, "nothing changes while the directory stays");
    close();
    assert.equal(watched[1].closed, true);
    close.refresh();
    assert.equal(watched.length, 2, "a closed watcher stays closed");
  });
});

describe("ampi top: usage", () => {
  it("prints its help for -h and --help", async () => {
    for (const flag of ["-h", "--help"]) {
      const { code, out } = await runTop([flag], registryDir());
      assert.equal(code, 0);
      assert.match(out, /^Usage: ampi top \[--json \| --stream-jsonl\]\n/);
    }
  });

  it("exits 2 with one reason and the help pointer for an unknown option, an argument or both output flags", async () => {
    const hint = "Run ampi top --help for its options.\n";
    for (const [args, reason] of [
      [["--watch"], "top has no option --watch."],
      [["sessions"], "top takes no arguments, not sessions."],
      [["--json", "--stream-jsonl"], "--json and --stream-jsonl cannot be combined."],
    ]) {
      assert.deepEqual(await runTop(args, registryDir()), { code: 2, out: "", err: `ampi: ${reason}\n${hint}` }, args.join(" "));
    }
  });
});

describe("ampi top: the executable", () => {
  const home = path.join(temporary, "home");
  const agentDir = path.join(temporary, "agent");
  const live = path.join(agentDir, "data", "ampi", "live");
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  const spawnBin = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: home, encoding: "utf8", env });
  const own = entry({
    pid: process.pid,
    status: { phase: "idle", label: "" },
    title: "Spawned check",
    mode: "high",
    cwd: path.join(home, "proj"),
    startedAt: new Date(Date.now() - 5000).toISOString(),
    updatedAt: new Date().toISOString(),
    gui: gui(PORTS[0]),
  });

  it("prints the empty state, then a running session, once when stdout is not a terminal", () => {
    rmSync(agentDir, { recursive: true, force: true });
    const empty = spawnBin(["top"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout, `${TOP_EMPTY}\n`);

    mkdirSync(live, { recursive: true });
    writeEntry(live, own);
    const listed = spawnBin(["top"]);
    assert.equal(listed.status, 0, listed.stderr);
    const lines = listed.stdout.split("\n");
    assert.equal(lines[0], "1 session running");
    assert.match(lines[4], new RegExp(`^Idle +Spawned check +high +~/proj +tui +\\d+s +${process.pid}$`));
    assertNoSecrets(listed.stdout);
    assert.ok(existsSync(path.join(live, `${process.pid}.json`)));
  });

  it("exits 2 on an unknown option and on --json with --stream-jsonl", () => {
    for (const args of [
      ["top", "--frobnicate"],
      ["top", "--json", "--stream-jsonl"],
    ]) {
      const result = spawnBin(args);
      assert.equal(result.status, 2, args.join(" "));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^ampi: .+\nRun ampi top --help for its options\.\n$/);
    }
  });

  it("streams until SIGTERM and exits 0 or SIGHUP and exits 129, and stops quietly when the reader closes the pipe", async () => {
    mkdirSync(live, { recursive: true });
    writeEntry(live, own);
    const firstLine = (child) =>
      new Promise((resolve) => {
        let text = "";
        child.stdout.on("data", (chunk) => {
          text += chunk;
          if (text.includes("\n")) resolve(text);
        });
      });
    const exited = (child) => new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

    const streamed = spawn(process.execPath, [bin, "top", "--stream-jsonl"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
    const line = JSON.parse(await firstLine(streamed));
    assert.deepEqual(
      line.sessions.map((session) => session.title),
      ["Spawned check"],
    );
    const stopped = exited(streamed);
    streamed.kill("SIGTERM");
    assert.deepEqual(await stopped, { code: 0, signal: null });

    // Handled, not the default action, which would end the process by the signal.
    const hungUp = spawn(process.execPath, [bin, "top", "--stream-jsonl"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
    await firstLine(hungUp);
    const hangup = exited(hungUp);
    hungUp.kill("SIGHUP");
    assert.deepEqual(await hangup, { code: 129, signal: null });

    const closing = spawn(process.execPath, [bin, "top", "--stream-jsonl"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
    await firstLine(closing);
    const ended = exited(closing);
    closing.stdout.destroy();
    // The next change makes the command write to the closed pipe.
    writeEntry(live, { ...own, title: "Renamed", updatedAt: new Date().toISOString() });
    assert.deepEqual(await ended, { code: 0, signal: null });
  });
});
