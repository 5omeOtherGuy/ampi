import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const load = () => importSource("extensions/ampi-core/tool-activity.ts");

const CWD = "/home/user/proj";
const HOME = "/home/user";
const options = { cwd: CWD, home: HOME };

function titleText(mod, activity, status = "done") {
  return mod.activityTitle(activity, status).map((part) => part.text).join("");
}

function words(tokens) {
  return tokens.map((token) => (token.type === "op" ? `<${token.value}>` : token.value));
}

describe("ampi-tui activity: shell tokenizer", () => {
  it("splits words and operators and removes quotes", async () => {
    const { tokenizeShell } = await load();
    assert.deepEqual(words(tokenizeShell(`rg "foo bar" src | head -5 && echo 'x;y'`)), [
      "rg",
      "foo bar",
      "src",
      "<|>",
      "head",
      "-5",
      "<&&>",
      "echo",
      "x;y",
    ]);
    assert.deepEqual(words(tokenizeShell("make\nnpm test; ls")), ["make", "<;>", "npm", "test", "<;>", "ls"]);
  });

  it("keeps subshells and command substitutions as one opaque word", async () => {
    const { tokenizeShell } = await load();
    const tokens = tokenizeShell("echo $(git rev-parse HEAD) > out.txt");
    assert.deepEqual(words(tokens), ["echo", "$(git rev-parse HEAD)", "<>>", "out.txt"]);
    assert.equal(tokens[1].opaque, true);
    const sub = tokenizeShell("(cd a; ls) | wc -l");
    assert.deepEqual(words(sub), ["(cd a; ls)", "<|>", "wc", "-l"]);
    assert.equal(sub[0].opaque, true);
  });

  it("reads file-descriptor redirections as one operator", async () => {
    const { tokenizeShell } = await load();
    assert.deepEqual(words(tokenizeShell("cargo test 2>&1")), ["cargo", "test", "<2>&>", "1"]);
    assert.deepEqual(words(tokenizeShell("ls a2 >> log")), ["ls", "a2", "<>>>", "log"]);
  });

  it("keeps a backslash inside double quotes unless it escapes a shell character", async () => {
    const { tokenizeShell } = await load();
    assert.deepEqual(words(tokenizeShell(String.raw`grep -n "\bretries\b" "foo\.bar"`)), ["grep", "-n", String.raw`\bretries\b`, String.raw`foo\.bar`]);
    assert.deepEqual(words(tokenizeShell(String.raw`echo "a\"b\$c\\d" e\.f`)), ["echo", String.raw`a"b$c\d`, "e.f"]);
  });

  it("gives up on heredocs, comments and unbalanced quotes", async () => {
    const { tokenizeShell } = await load();
    assert.equal(tokenizeShell("cat <<EOF\nhi\nEOF"), undefined);
    assert.equal(tokenizeShell("# just a comment"), undefined);
    assert.equal(tokenizeShell("echo 'unclosed"), undefined);
    assert.equal(tokenizeShell("echo $(unclosed"), undefined);
  });
});

describe("ampi-tui activity: shell classification", () => {
  const cases = [
    ["rg foo src", { kind: "search", pattern: "foo", path: "src" }],
    ["rg foo", { kind: "search", pattern: "foo" }],
    ["grep -rn -e TODO -- lib test", { kind: "search", pattern: "TODO", path: "test" }],
    ["grep -C 3 needle file.txt", { kind: "search", pattern: "needle", path: "file.txt" }],
    ["git grep -n parse -- src", { kind: "search", pattern: "parse", path: "src" }],
    ["git status", { kind: "command" }],
    ["git ls-files", { kind: "list", path: "." }],
    ["sed -n '1,220p' x.ts", { kind: "read", path: "x.ts", range: "L1-220" }],
    ["sed -n '5p;10,12p' a.txt", { kind: "read", path: "a.txt", range: "L5,L10-12" }],
    ["sed -n -e 7,9p notes.md", { kind: "read", path: "notes.md", range: "L7-9" }],
    ["sed -n '/start/,/end/p' a.txt", { kind: "read", path: "a.txt" }],
    ["sed -i 's/a/b/' x.ts", { kind: "edit", path: "x.ts" }],
    ["head -n 50 README.md", { kind: "read", path: "README.md", range: "L1-50" }],
    ["head -20 f.txt", { kind: "read", path: "f.txt", range: "L1-20" }],
    ["head f.txt", { kind: "read", path: "f.txt", range: "L1-10" }],
    ["head -c 100 f.txt", { kind: "read", path: "f.txt" }],
    ["tail -n 20 log.txt", { kind: "read", path: "log.txt", range: "last 20" }],
    ["tail -n +5 data.csv", { kind: "read", path: "data.csv", range: "L5-end" }],
    ["cat a.ts", { kind: "read", path: "a.ts" }],
    ["cat a.ts 2>/dev/null", { kind: "read", path: "a.ts" }],
    ["cat a.ts | grep TODO", { kind: "search", pattern: "TODO", path: "a.ts" }],
    ["cat a.ts | sort | uniq -c", { kind: "read", path: "a.ts" }],
    ["grep -rn foo src 2>&1 | head", { kind: "search", pattern: "foo", path: "src" }],
    ["rg --files | rg test", { kind: "search", pattern: "test", path: "." }],
    ["ls src | xargs grep -l TODO", { kind: "search", pattern: "TODO", path: "src" }],
    ["ls -la src", { kind: "list", path: "src" }],
    ["find src -name '*.ts'", { kind: "list", path: "src", pattern: "*.ts" }],
    ["fd config", { kind: "list", path: ".", pattern: "config" }],
    ["echo start && rg foo src", { kind: "search", pattern: "foo", path: "src" }],
    ["npm test", { kind: "command" }],
    ["find . -name '*.tmp' -delete", { kind: "command" }],
    ["cat a.ts > b.ts", { kind: "command" }],
    ["cat a.ts | tee b.ts", { kind: "command" }],
    ["cat a.ts | python3 x.py", { kind: "command" }],
    ["cd src && rg foo", { kind: "command" }],
    ["jq .", { kind: "command" }],
    ["jq .name package.json", { kind: "read", path: "package.json" }],
    ["cat $(ls)", { kind: "command" }],
    ["cat <<EOF > x\nhi\nEOF", { kind: "command" }],
  ];
  for (const [command, expected] of cases) {
    it(`classifies ${JSON.stringify(command)}`, async () => {
      const { classifyShellCommand } = await load();
      assert.deepEqual(classifyShellCommand(command), expected);
    });
  }

  it("splits a leading cd from the command that follows", async () => {
    const { splitLeadingCd } = await load();
    assert.deepEqual(splitLeadingCd("cd packages/app && npm test -- --watch"), {
      dir: "packages/app",
      rest: "npm test -- --watch",
    });
    assert.equal(splitLeadingCd("cd packages/app; npm test"), undefined);
    assert.equal(splitLeadingCd("npm test"), undefined);
  });
});

describe("ampi-tui activity: tool calls", () => {
  it("reads with a path relative to the working directory and a line range", async () => {
    const mod = await load();
    const activity = mod.classifyToolCall("read", { path: `${CWD}/src/index.ts`, offset: 1, limit: 120 }, options);
    assert.equal(activity.kind, "read");
    assert.equal(titleText(mod, activity), "Read src/index.ts L1-120");
    assert.equal(titleText(mod, activity, "running"), "Reading src/index.ts L1-120");
    const outside = mod.classifyToolCall("read", { path: `${HOME}/notes/todo.md`, offset: 40 }, options);
    assert.equal(titleText(mod, outside), "Read ~/notes/todo.md L40-end");
    assert.equal(titleText(mod, mod.classifyToolCall("read", { path: "/etc/hosts" }, options)), "Read /etc/hosts");
  });

  it("names shell reads, searches and commands, with the exit code of a failure", async () => {
    const mod = await load();
    const bash = (command, result) => mod.classifyToolCall("bash", { command }, { ...options, result });
    assert.equal(titleText(mod, bash("sed -n '1,220p' x.ts")), "Read x.ts L1-220");
    assert.equal(titleText(mod, bash("rg foo src")), 'Grep src "foo"');
    assert.equal(titleText(mod, bash("ls")), "Listed .");
    assert.equal(titleText(mod, bash("npm test")), "Ran npm test");
    const failed = bash("npm test", { content: [{ type: "text", text: "1 failing\n\nCommand exited with code 1" }] });
    assert.equal(failed.exitCode, 1);
    assert.equal(titleText(mod, failed, "error"), "Ran npm test (exit code: 1)");
    const missing = bash("ls missing-dir", { content: [{ type: "text", text: "ls: no such file\n\nCommand exited with code 2" }] });
    assert.equal(titleText(mod, missing, "error"), "Listed missing-dir (exit code: 2)");
    assert.equal(titleText(mod, bash("printf 'a\\nb'\nmake")), "Ran printf 'a\\nb' …");
    assert.equal(titleText(mod, bash(String.raw`grep -n "\bretries\b" src/app.ts`)), String.raw`Grep src/app.ts "\bretries\b"`);
    assert.equal(titleText(mod, bash("find src -name '*.ts'")), "Listed src *.ts");
  });

  it("says why a command ended without an exit code", async () => {
    const mod = await load();
    const bash = (text) => mod.classifyToolCall("bash", { command: "sleep 3" }, { ...options, result: { content: [{ type: "text", text }] } });
    assert.equal(titleText(mod, bash("partial\n\nCommand timed out after 1 seconds"), "error"), "Ran sleep 3 (timed out after 1s)");
    assert.equal(titleText(mod, bash("Command terminated without an exit code"), "error"), "Ran sleep 3 (killed)");
    assert.equal(bash("Command timed out after 1 seconds").exitCode, undefined);
  });

  it("classifies shell_command like bash, in its workdir, and says when it was left running", async () => {
    const mod = await load();
    const read = mod.classifyToolCall("shell_command", { command: "sed -n '1,20p' a.ts", workdir: "pkg" }, options);
    assert.equal(read.kind, "read");
    assert.equal(read.toolName, "shell_command");
    assert.equal(read.workdir, `${CWD}/pkg`);
    assert.equal(titleText(mod, read), "Read pkg/a.ts L1-20");
    const failed = mod.classifyToolCall("shell_command", { command: "npm test" }, {
      ...options,
      result: { content: [{ type: "text", text: "1 failing\n\nCommand exited with code 1" }] },
    });
    assert.equal(titleText(mod, failed, "error"), "Ran npm test (exit code: 1)");
    const background = mod.classifyToolCall("shell_command", { command: "npm run dev" }, {
      ...options,
      result: { content: [{ type: "text", text: "ready" }], details: { pid: 4242, running: true } },
    });
    assert.equal(background.kind, "command");
    assert.equal(titleText(mod, background), "Ran npm run dev (still running as pid 4242)");
    const timedOut = mod.classifyToolCall("shell_command", { command: "make" }, {
      ...options,
      result: { content: [{ type: "text", text: "Command timed out after 1.5 seconds" }] },
    });
    assert.equal(titleText(mod, timedOut, "error"), "Ran make (timed out after 1.5s)");
    assert.equal(
      mod.summarizeActivities([{ activity: failed, status: "error" }, { activity: background, status: "done" }]),
      "Ran 2 commands",
    );
  });

  it("names shell_command_status and shell_command_kill by pid", async () => {
    const mod = await load();
    const status = (details) =>
      mod.classifyToolCall("shell_command_status", { pid: 4242 }, { ...options, ...(details ? { result: { content: [], details } } : {}) });
    assert.equal(titleText(mod, status(), "running"), "Checking pid 4242");
    assert.equal(titleText(mod, status({ running: true })), "Checked pid 4242, still running");
    assert.equal(titleText(mod, status({ running: false, exitCode: 0 })), "Checked pid 4242, finished");
    assert.equal(titleText(mod, status({ running: false, exitCode: 2 })), "Checked pid 4242, finished (exit code: 2)");
    assert.equal(
      titleText(mod, status({ running: false, exitCode: 143, signal: "SIGTERM", stoppedBy: "timeout", timeoutMs: 5000 })),
      "Checked pid 4242, finished (timed out after 5s)",
    );
    assert.equal(status().kind, "command");
    const kill = (details) => mod.classifyToolCall("shell_command_kill", { pid: 4242 }, { ...options, result: { content: [], details } });
    assert.equal(
      titleText(mod, kill({ running: false, exitCode: 137, signal: "SIGKILL", stoppedBy: "kill", command: "npm run dev" })),
      "Stopped pid 4242 (SIGKILL)",
    );
    assert.equal(titleText(mod, kill({ running: false, exitCode: 0 })), "Checked pid 4242, finished", "it had already ended");
    assert.equal(kill({ running: false, command: "npm run dev" }).command, "npm run dev");
    assert.equal(titleText(mod, kill({ running: true })), "Stopped pid 4242, still running");
  });

  it("names a painter call by its prompt while it runs and by the saved file once done", async () => {
    const mod = await load();
    const args = { prompt: "A red fox in the snow\nwatercolour", background: "opaque" };
    const painting = mod.classifyToolCall("painter", args, options);
    assert.equal(painting.kind, "tool");
    assert.equal(titleText(mod, painting, "running"), "Painting A red fox in the snow …");
    const saved = mod.classifyToolCall("painter", args, {
      ...options,
      result: {
        content: [{ type: "text", text: "Saved the image to /x/data/ampi/painter/s1/2026-10-19T08-00-00-000Z-1.png." }],
        details: { path: "/x/data/ampi/painter/s1/2026-10-19T08-00-00-000Z-1.png", model: "fakeimg/img-1" },
      },
    });
    assert.equal(titleText(mod, saved), "Painted 2026-10-19T08-00-00-000Z-1.png");
    const failed = mod.classifyToolCall("painter", args, {
      ...options,
      result: { content: [{ type: "text", text: "fakeimg/img-1 could not make the image: quota" }] },
    });
    assert.equal(titleText(mod, failed, "error"), "Painted A red fox in the snow …");
    assert.equal(mod.resultStatus(true, { content: [{ type: "text", text: "The painter call was cancelled; no image was saved." }] }), "cancelled");
    // A painter call keeps its own row, image or not, so it never folds into a group of reads.
    const runs = await importSource("extensions/ampi-core/activity-runs.ts");
    assert.equal(runs.standsAlone("painter", undefined, false), true);
    assert.equal(runs.standsAlone("painter", { content: [{ type: "text", text: "Saved." }] }, false), true);
    assert.equal(runs.standsAlone("read", undefined, false), false);
  });

  it("follows a leading cd into the directory it names", async () => {
    const mod = await load();
    const read = mod.classifyToolCall("bash", { command: `cd ${CWD}/pkg && cat a.ts` }, options);
    assert.equal(read.workdir, `${CWD}/pkg`);
    assert.equal(titleText(mod, read), "Read pkg/a.ts");
    const run = mod.classifyToolCall("bash", { command: "cd pkg && npm test" }, options);
    assert.equal(run.workdir, `${CWD}/pkg`);
    assert.equal(titleText(mod, run), "Ran npm test");
    assert.equal(run.command, "cd pkg && npm test");
  });

  it("names Pi's search and list tools", async () => {
    const mod = await load();
    assert.equal(titleText(mod, mod.classifyToolCall("grep", { pattern: "foo" }, options)), 'Grep "foo"');
    assert.equal(
      titleText(mod, mod.classifyToolCall("grep", { pattern: "foo", path: `${CWD}/src`, glob: "*.ts" }, options)),
      'Grep src "foo" · *.ts',
    );
    assert.equal(titleText(mod, mod.classifyToolCall("find", { pattern: "**/*.ts", path: "src" }, options)), "Glob **/*.ts in src");
    assert.equal(titleText(mod, mod.classifyToolCall("ls", {}, options)), "Listed .");
  });

  it("derives diff stats for edits from the result, or from the arguments while running", async () => {
    const mod = await load();
    const diff = " 1 import a from 'a';\n-2 const x = 1;\n+2 const x = 2;\n+3 const y = 3;\n 4 export { x };";
    const done = mod.classifyToolCall("edit", { path: "x.ts", edits: [] }, { ...options, result: { content: [], details: { diff } } });
    assert.deepEqual(done.diff, { added: 2, removed: 1 });
    assert.equal(titleText(mod, done), "Edited x.ts +2 -1");
    const running = mod.classifyToolCall("edit", { path: "x.ts", edits: [{ oldText: "a\nb\nc", newText: "d" }] }, options);
    assert.deepEqual(running.diff, { added: 1, removed: 3 });
    assert.equal(titleText(mod, running, "running"), "Editing x.ts +1 -3");
    assert.equal(titleText(mod, running, "error"), "Edited x.ts", "a failed edit shows no stat");
    const written = mod.classifyToolCall("write", { path: `${CWD}/new.txt`, content: "a\nb\nc\n" }, options);
    assert.equal(titleText(mod, written), "Created new.txt +3");
  });

  it("names apply_patch files from the patch text and from the result", async () => {
    const mod = await load();
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+one",
      "+two",
      "*** End Patch",
    ].join("\n");
    const running = mod.classifyToolCall("apply_patch", { patchText }, options);
    assert.deepEqual(running.paths, ["src/a.ts", "src/b.ts"]);
    assert.equal(titleText(mod, running, "running"), "Editing 2 files +3 -1");
    const created = mod.classifyToolCall("apply_patch", { patchText }, {
      ...options,
      result: { content: [], details: { files: [{ type: "add", path: `${CWD}/src/b.ts`, additions: 2, deletions: 0 }] } },
    });
    assert.equal(titleText(mod, created), "Created src/b.ts +2");
  });

  it("names ampi's tools, MCP tools and unknown tools", async () => {
    const mod = await load();
    const title = (name, args) => titleText(mod, mod.classifyToolCall(name, args, options));
    assert.equal(title("web_search", { objective: "pi tool renderers" }), "Searched the web · pi tool renderers");
    assert.equal(title("read_web_page", { url: "https://example.com/docs" }), "Read https://example.com/docs");
    assert.equal(title("task_list", { tasks: [{}, {}, {}] }), "Updated task list · 3 items");
    const mcp = mod.classifyToolCall("mcp__docs__search", { query: "tokens", limit: 5 }, options);
    assert.equal(mcp.server, "docs");
    assert.equal(titleText(mod, mcp), "Ran docs/search · tokens");
    assert.equal(title("frobnicate", { level: 3 }), "Ran frobnicate");
    assert.equal(mod.classifyToolCall("frobnicate", {}, options).kind, "tool");
  });

  it("marks ampi-workers' tools and custom subagents as subagents, which draw their own rows", async () => {
    const mod = await load();
    for (const name of ["finder", "oracle", "librarian", "reviewer", "view_media", "Task", "start_task", "task_poll", "task_wait", "task_cancel", "sa__security_audit"]) {
      assert.equal(mod.classifyToolCall(name, {}, options).kind, "subagent", name);
    }
    assert.equal(mod.classifyToolCall("task_list", {}, options).kind, "tool");
    assert.equal(mod.classifyToolCall("subagent_report", {}, options).kind, "tool");
  });
});

describe("ampi-tui activity: summaries", () => {
  const entry = (activity, status = "done") => ({ activity, status });
  const command = { kind: "command", toolName: "bash", present: "Running", past: "Ran", object: "x" };
  const read = { kind: "read", toolName: "read", present: "Reading", past: "Read", object: "x" };
  const search = { kind: "search", toolName: "grep", present: "Grep", past: "Grep", object: "x" };
  const list = { kind: "list", toolName: "ls", present: "Listing", past: "Listed", object: "." };
  const edit = (p, added, removed) => ({
    kind: "edit",
    toolName: "edit",
    present: "Editing",
    past: "Edited",
    object: p,
    path: p,
    diff: { added, removed },
  });
  const create = (p, added) => ({ ...edit(p, added, 0), kind: "create", toolName: "write" });

  it("orders clauses by first appearance and adds the diff stat", async () => {
    const { summarizeActivities } = await load();
    const entries = [
      entry(read),
      entry(command),
      entry(edit("a.ts", 200, 3)),
      entry(read),
      entry(command),
      entry(read),
      entry(edit("b.ts", 65, 1)),
      entry(command),
      entry(read),
    ];
    assert.equal(summarizeActivities(entries), "Read 4 files, ran 3 commands, edited 2 files (+265 -4)");
  });

  it("uses singular nouns for one and present verbs while a call runs", async () => {
    const { summarizeActivities } = await load();
    assert.equal(summarizeActivities([entry(command), entry(search)]), "Ran 1 command, ran 1 search");
    assert.equal(summarizeActivities([entry(command), entry(command, "running")]), "Running 2 commands");
    assert.equal(summarizeActivities([entry(search), entry(list)]), "Ran 2 searches");
  });

  it("counts a file edited twice once and leaves failed edits out of the stat", async () => {
    const { summarizeActivities } = await load();
    assert.equal(summarizeActivities([entry(edit("a.ts", 1, 1)), entry(edit("a.ts", 2, 0))]), "Edited 1 file (+3 -1)");
    assert.equal(summarizeActivities([entry(edit("a.ts", 5, 0), "error"), entry(edit("b.ts", 1, 0))]), "Edited 2 files (+1)");
    assert.equal(summarizeActivities([entry(edit("a.ts", 5, 0), "cancelled"), entry(edit("b.ts", 1, 0))]), "Edited 2 files (+1, 1 cancelled)");
  });

  it("says created or changed for new and mixed files", async () => {
    const { summarizeActivities } = await load();
    assert.equal(summarizeActivities([entry(create("n.ts", 3))]), "Created 1 file (+3)");
    assert.equal(summarizeActivities([entry(edit("a.ts", 1, 1)), entry(create("n.ts", 3))]), "Changed 2 files (+4 -1)");
  });

  it("counts cancelled calls and names web activity", async () => {
    const { summarizeActivities } = await load();
    assert.equal(summarizeActivities([entry(command), entry(command, "cancelled")]), "Ran 2 commands (1 cancelled)");
    const web = { kind: "web-search", toolName: "web_search", present: "", past: "", object: "" };
    const page = { kind: "web-read", toolName: "read_web_page", present: "", past: "", object: "" };
    assert.equal(summarizeActivities([entry(web), entry(page), entry(page)]), "Ran 1 web search, read 2 web pages");
  });
});
