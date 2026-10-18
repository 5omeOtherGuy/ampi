// Permission rules: matching, validation, the text form, evaluation order and
// how shell lines are split and judged against ampi's defaults.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

let rules;

before(async () => {
  rules = await importSource("extensions/ampi-core/permissions.ts");
});

const bash = (command) => ({ toolName: "bash", input: { command } });
const action = (call, sources) => rules.evaluateMmrPermission(call, sources).action;
const matches = (pattern, value, field = "x") =>
  rules.matchesMmrPermissionRule({ tool: "t", matches: { [field]: pattern }, action: "allow" }, "t", value === undefined ? {} : { [field]: value });

describe("permission rule matching", () => {
  it("a glob covers the whole value: * spans slashes and spaces, ? is one character, the rest is literal", () => {
    assert.equal(matches("git *", "git status --short"), true);
    assert.equal(matches("git *", "agit status"), false, "anchored at the start");
    assert.equal(matches("git", "git status"), false, "anchored at the end");
    assert.equal(matches("*", "/a b/c"), true);
    assert.equal(matches("l?", "ls"), true);
    assert.equal(matches("l?", "lsx"), false);
    assert.equal(matches("a.c", "abc"), false, "a dot is a dot");
    assert.equal(matches("(x)", "(x)"), true);
  });

  it("a /regex/ is searched, so it is anchored only where it anchors itself, and keeps its flags", () => {
    assert.equal(matches("/git/", "agit status"), true);
    assert.equal(matches("/^git/", "agit status"), false);
    assert.equal(matches("/GIT/i", "git"), true);
    assert.equal(matches("/GIT/", "git"), false);
    assert.equal(matches("/x/g", "x") && matches("/x/g", "x"), true, "a g flag does not make matching stateful");
    assert.equal(matches("/usr/bin/*", "/usr/bin/env"), true, "a path ending in a glob is a glob, not a regex");
  });

  it("a list matches when any entry does", () => {
    assert.equal(matches(["a", "b*"], "bc"), true);
    assert.equal(matches(["a", "b*"], "cb"), false);
  });

  it("an object pattern recurses into the field", () => {
    const rule = { tool: "t", matches: { options: { force: true, mode: "fast*" } }, action: "ask" };
    assert.equal(rules.matchesMmrPermissionRule(rule, "t", { options: { force: true, mode: "faster", other: 1 } }), true);
    assert.equal(rules.matchesMmrPermissionRule(rule, "t", { options: { force: false, mode: "fast" } }), false);
    assert.equal(rules.matchesMmrPermissionRule(rule, "t", { options: { force: true } }), false);
    assert.equal(rules.matchesMmrPermissionRule(rule, "t", { options: "force" }), false);
  });

  it("booleans, numbers and null compare strictly; a string pattern matches only strings", () => {
    assert.equal(matches(true, true), true);
    assert.equal(matches(true, "true"), false);
    assert.equal(matches(1, 1), true);
    assert.equal(matches(1, "1"), false);
    assert.equal(matches("1", 1), false);
    assert.equal(matches(null, null), true);
    assert.equal(matches(null, 0), false);
  });

  it("a field missing from the input never matches, not even null or *", () => {
    assert.equal(matches(null, undefined), false);
    assert.equal(matches("*", undefined), false);
    assert.equal(rules.matchesMmrPermissionRule({ tool: "t", matches: { x: "*" }, action: "ask" }, "t", "not an object"), false);
  });

  it("the tool is a glob, and a rule without matches covers every call of that tool", () => {
    const rule = { tool: "mcp__*", action: "allow" };
    assert.equal(rules.matchesMmrPermissionRule(rule, "mcp__github__search", {}), true);
    assert.equal(rules.matchesMmrPermissionRule(rule, "bash", {}), false);
  });

  it("a rule with a context applies only there; one without applies everywhere", () => {
    const sub = { tool: "bash", action: "reject", context: "subagent" };
    assert.equal(rules.matchesMmrPermissionRule(sub, "bash", {}, "thread"), false);
    assert.equal(rules.matchesMmrPermissionRule(sub, "bash", {}, "subagent"), true);
    assert.equal(rules.matchesMmrPermissionRule({ tool: "bash", action: "reject" }, "bash", {}, "subagent"), true);
    assert.equal(action({ toolName: "read", input: {} }, { user: [{ tool: "read", action: "reject", context: "subagent" }] }), "allow");
  });
});

describe("permission rule validation", () => {
  it("accepts every action with its own fields", () => {
    for (const rule of [
      { tool: "bash", action: "allow", matches: { command: ["ls", "/^cat /", 1, true, null, { a: "b" }] } },
      { tool: "bash", action: "reject", message: "no" },
      { tool: "bash", action: "ask", context: "thread" },
      { tool: "bash", action: "delegate", to: "check-cmd" },
    ]) {
      assert.deepEqual(rules.validateMmrPermissionRule(rule), [], JSON.stringify(rule));
    }
  });

  it("names each problem precisely", () => {
    assert.deepEqual(rules.validateMmrPermissionRule("allow bash"), ["a rule must be an object"]);
    assert.deepEqual(rules.validateMmrPermissionRule({ tool: "", action: "permit", match: { command: "x" } }), [
      'unknown field "match"',
      "tool must be a non-empty string",
      'action must be allow, reject, ask or delegate (got "permit")',
    ]);
    assert.deepEqual(rules.validateMmrPermissionRule({ tool: "bash" }), ["action must be allow, reject, ask or delegate (got nothing)"]);
    assert.deepEqual(rules.validateMmrPermissionRule({ tool: "bash", action: "ask", matches: ["x"] }), [
      "matches must be an object of input field names to patterns",
    ]);
    const [regexProblem, ...rest] = rules.validateMmrPermissionRule({
      tool: "bash",
      action: "ask",
      matches: { command: ["/(/", []], n: Number.NaN, o: {}, f: () => 1 },
    });
    // The engine's own wording follows the field path; the parenthesis holds the JavaScript error.
    assert.match(regexProblem, /^matches\.command\[0\]: invalid regular expression \/\(\/ \(.+\)$/);
    assert.deepEqual(
      rest,
      [
        "matches.command[1]: an empty list matches nothing",
        "matches.n: expected a finite number",
        "matches.o: an empty object matches every object; leave the field out instead",
        "matches.f: expected a string, true or false, a number, null, a list or an object",
      ],
    );
    assert.deepEqual(rules.validateMmrPermissionRule({ tool: "bash", action: "ask", context: "worker" }), ["context must be thread or subagent"]);
    assert.deepEqual(rules.validateMmrPermissionRule({ tool: "bash", action: "delegate" }), ["a delegate rule needs to: the program to run"]);
    assert.deepEqual(rules.validateMmrPermissionRule({ tool: "bash", action: "ask", to: "x" }), ["to is allowed only on a delegate rule"]);
    assert.deepEqual(rules.validateMmrPermissionRule({ tool: "bash", action: "ask", message: "x" }), ["message is allowed only on a reject rule"]);
    assert.deepEqual(rules.validateMmrPermissionRule({ tool: "bash", action: "reject", message: 3 }), ["message must be a string"]);
  });

  it("splits a settings list into valid rules and per-index problems", () => {
    const { rules: valid, problems } = rules.parseMmrPermissionRules([{ tool: "a", action: "ask" }, { tool: "b" }, { tool: "c", action: "allow" }]);
    assert.deepEqual(valid.map((rule) => rule.tool), ["a", "c"]);
    assert.deepEqual(problems, [{ index: 1, problems: ["action must be allow, reject, ask or delegate (got nothing)"] }]);
  });
});

describe("permission rule text form", () => {
  it("writes '<action> <tool> --<field> <pattern>...', quoting what the shell would split", () => {
    assert.equal(
      rules.formatMmrPermissionRule({ tool: "bash", matches: { command: ["git push*", "/^rm/"] }, action: "ask" }),
      "ask bash --command 'git push*' --command '/^rm/'",
    );
    assert.equal(rules.formatMmrPermissionRule({ tool: "mcp__*", action: "allow" }), "allow 'mcp__*'");
    assert.equal(
      rules.formatMmrPermissionRule({ tool: "edit", matches: { path: "src/a.ts", opts: { force: true }, n: null }, action: "reject", message: "don't" }),
      "reject edit --path src/a.ts --opts.force true --n null --message 'don'\\''t'",
    );
    assert.equal(
      rules.formatMmrPermissionRule({ tool: "bash", action: "delegate", to: "my-check", context: "subagent" }),
      "delegate bash --context subagent --to my-check",
    );
  });
});

describe("permission evaluation", () => {
  it("takes the first match in the order project, user, defaults; nothing matching allows", () => {
    const push = bash("git push origin main");
    assert.equal(action(push), "ask", "the defaults ask");
    assert.equal(action(push, { user: [{ tool: "bash", matches: { command: "git push*" }, action: "allow" }] }), "allow");
    const decision = rules.evaluateMmrPermission(push, {
      project: [{ tool: "bash", matches: { command: "git push*" }, action: "reject", message: "use the release script" }],
      user: [{ tool: "bash", matches: { command: "git push*" }, action: "allow" }],
    });
    assert.equal(decision.action, "reject");
    assert.equal(decision.source, "project");
    assert.equal(decision.rule.message, "use the release script");
    assert.equal(action({ toolName: "edit", input: { path: "a" } }), "allow", "no rule for edits");
    assert.equal(action({ toolName: "read", input: {} }, { defaults: [] }), "allow");
  });

  it("splits shell lines and allows only when every part is allowed", () => {
    assert.equal(action(bash("git status && git log -1")), "allow");
    assert.equal(action(bash("cd sub && git status")), "allow");
    assert.equal(action(bash("ls && rm -rf build")), "ask");
    assert.equal(action(bash("ls | grep x; pwd\nwc -l a")), "allow");
    assert.equal(action({ toolName: "shell_command", input: { command: "ls && rm -rf build" } }), "ask");
  });

  it("asks for a part with a subshell or command substitution", () => {
    const decision = rules.evaluateMmrPermission(bash("echo $(rm -rf x)"));
    assert.equal(decision.action, "ask");
    assert.equal(decision.reason, "this command runs a subshell or command substitution");
    assert.equal(action(bash("echo `id`")), "ask");
    assert.equal(action(bash("(cd x && ls)")), "ask");
  });

  it("asks for output written into a file, but not for /dev/null or descriptor copies", () => {
    assert.equal(action(bash("cat a > b")), "ask");
    assert.equal(action(bash("cat a >> b")), "ask");
    assert.equal(action(bash("cat a &> b")), "ask");
    assert.equal(action(bash("cat a 2> err.log")), "ask");
    assert.equal(action(bash("npm test 2>&1")), "allow");
    assert.equal(action(bash("ls >/dev/null 2>&1")), "allow");
    assert.equal(action(bash("ls > /dev/nullx")), "ask");
  });

  it("allows test, lint and build scripts but no other package script", () => {
    assert.equal(action(bash("npm run test:unit")), "allow");
    assert.equal(action(bash("pnpm run typecheck")), "allow");
    assert.equal(action(bash("yarn test --watch=false")), "allow");
    assert.equal(action(bash("npm run deploy")), "ask");
    assert.equal(action(bash("npm install")), "ask");
    assert.equal(action(bash("env CI=1 npm test")), "ask");
    assert.equal(action(bash("CI=1 npm test")), "ask");
    assert.equal(action(bash("cargo fmt --check")), "allow");
    assert.equal(action(bash("cargo fmt")), "ask");
    assert.equal(action(bash("eslint --fix src")), "ask");
  });

  it("asks for find actions and git branch changes, allows plain find and jj reads", () => {
    assert.equal(action(bash("find . -name x -delete")), "ask");
    assert.equal(action(bash("find . -name x -exec rm {} ;")), "ask");
    assert.equal(action(bash("find . -name '*.ts'")), "allow");
    assert.equal(action(bash("git branch -D x")), "ask");
    assert.equal(action(bash("git branch new-feature")), "ask");
    assert.equal(action(bash("git branch -a")), "allow");
    assert.equal(action(bash("jj diff")), "allow");
    assert.equal(action(bash("git diff --output=patch.txt")), "ask");
    assert.equal(action(bash("uniq in.txt")), "allow");
    assert.equal(action(bash("uniq in.txt out.txt")), "ask");
    assert.equal(action(bash("sort -u names.txt")), "allow");
    assert.equal(action(bash("sort -o out.txt names.txt")), "ask");
    assert.equal(action(bash("sort --compress-program=gzip names.txt")), "ask");
    assert.equal(action(bash("rg --pre=sh x")), "ask");
  });

  it("rejects the whole line when one part is rejected, with that rule", () => {
    const reject = { tool: "bash", matches: { command: "rm *" }, action: "reject", message: "no rm" };
    const decision = rules.evaluateMmrPermission(bash("ls && rm -rf build && echo done"), { user: [reject] });
    assert.equal(decision.action, "reject");
    assert.equal(decision.rule, reject);
    assert.equal(decision.command, "rm -rf build");
    assert.equal(action(bash("echo $(rm -rf x)"), { user: [{ tool: "bash", matches: { command: "echo *" }, action: "reject" }] }), "reject");
  });

  it("asks for a line it cannot split unless a rule rejects the whole line", () => {
    const heredoc = bash("cat <<EOF\nhi\nEOF");
    const decision = rules.evaluateMmrPermission(heredoc);
    assert.equal(decision.action, "ask");
    assert.equal(decision.reason, "ampi cannot split this command line into simple commands");
    assert.equal(action(bash("ls # list")), "ask");
    assert.equal(action(heredoc, { user: [{ tool: "bash", matches: { command: "/<</" }, action: "reject" }] }), "reject");
    assert.equal(action(heredoc, { user: [{ tool: "bash", matches: { command: "/<</" }, action: "allow" }] }), "ask");
  });

  it("matches a powershell command as a whole and asks by default", () => {
    assert.equal(action({ toolName: "powershell", input: { command: "Get-ChildItem; Remove-Item x" } }), "ask");
    assert.equal(action({ toolName: "powershell", input: { command: "ls" } }), "ask", "the bash allow list does not apply");
    const allowLs = { tool: "powershell", matches: { command: "Get-ChildItem*" }, action: "allow" };
    assert.equal(action({ toolName: "powershell", input: { command: "Get-ChildItem; Remove-Item x" } }, { user: [allowLs] }), "allow");
  });

  it("keeps a single part's delegate but asks for a delegate among several parts", () => {
    const delegate = { tool: "bash", matches: { command: "make *" }, action: "delegate", to: "check" };
    assert.equal(action(bash("make all"), { user: [delegate] }), "delegate");
    assert.equal(action(bash("ls && make all"), { user: [delegate] }), "ask");
  });

  it("exports the splitter: parts keep their original text and say whether they are opaque", () => {
    assert.deepEqual(rules.splitMmrShellCommand("cd 'a b' && ls -l | wc -l; echo $(date) &"), [
      { text: "cd 'a b'", opaque: false },
      { text: "ls -l", opaque: false },
      { text: "wc -l", opaque: false },
      { text: "echo $(date)", opaque: true },
    ]);
    assert.equal(rules.splitMmrShellCommand("echo 'open"), undefined);
  });
});
