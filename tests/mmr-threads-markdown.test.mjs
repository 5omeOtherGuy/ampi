import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const fixtures = path.join(import.meta.dirname, "fixtures", "ampi-threads-markdown");
const readEntries = () =>
  readFileSync(path.join(fixtures, "session.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

let formatMmrThreadMarkdown;

before(async () => {
  ({ formatMmrThreadMarkdown } = await importSource("extensions/ampi-threads/markdown.ts"));
});

const message = (id, parentId, body) => ({ type: "message", id, parentId, timestamp: "2026-10-18T10:00:00.000Z", message: body });

describe("thread Markdown", () => {
  it("renders a session file as the hand-written golden Markdown", () => {
    const expected = readFileSync(path.join(fixtures, "session.md"), "utf8");
    assert.equal(formatMmrThreadMarkdown(readEntries()), expected);
  });

  it("is exported from the package root under both names", async () => {
    const root = await importSource("index.ts");
    assert.equal(root.formatAmpiThreadMarkdown, root.formatMmrThreadMarkdown);
    assert.equal(root.formatMmrThreadMarkdown(readEntries()), formatMmrThreadMarkdown(readEntries()));
  });

  it("takes front matter values from the options over the entries, and leaves out unknown ones", () => {
    const markdown = formatMmrThreadMarkdown(readEntries(), { title: "Parser: rename", sessionId: "s-9", created: "2026-01-02T03:04:05.000Z", mode: "low" });
    assert.ok(markdown.startsWith('---\ntitle: "Parser: rename"\nsessionId: "s-9"\ncreated: "2026-01-02T03:04:05.000Z"\nmode: "low"\n---\n\n# Parser: rename\n'));

    const bare = formatMmrThreadMarkdown([message("a", null, { role: "user", content: "hi" })]);
    assert.equal(bare, '---\ntitle: "hi"\n---\n\n# hi\n\n## User\n\nhi\n');
  });

  it("titles an unnamed session by its first prompt on one line, cut to 80 characters, else Untitled", () => {
    const long = `${"word ".repeat(30)}\nsecond line`;
    const markdown = formatMmrThreadMarkdown([message("a", null, { role: "user", content: long })]);
    const title = markdown.split("\n")[1];
    assert.equal(title, `title: ${JSON.stringify(`${"word ".repeat(16).slice(0, 79)}…`)}`);
    assert.equal(formatMmrThreadMarkdown([]), '---\ntitle: "Untitled"\n---\n\n# Untitled\n');
  });

  it("renders the branch that ends with the last entry, so a list already cut to one branch renders the same", () => {
    const entries = readEntries();
    const branchIds = new Set(["e01", "e02", "e03", "e04", "e05", "e06", "e07", "e08", "e09", "e10", "e11", "e14", "e15", "e16", "e17", "e18", "e19"]);
    const branch = entries.filter((entry) => entry.type === "session" || branchIds.has(entry.id));
    assert.equal(formatMmrThreadMarkdown(branch), formatMmrThreadMarkdown(entries));
    assert.ok(!formatMmrThreadMarkdown(entries).includes("Also update the docs."), "the abandoned branch is left out");
  });

  it("makes a fence longer than any run of backticks in the text, and keeps one speaker heading per turn", () => {
    const markdown = formatMmrThreadMarkdown([
      message("a", null, { role: "user", content: "go" }),
      message("b", "a", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo '````'" } }] }),
      message("c", "b", { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "````" }] }),
      message("d", "c", { role: "assistant", content: [{ type: "text", text: "ok" }] }),
    ]);
    assert.match(markdown, /\n`````\n````\n`````\n/);
    assert.equal(markdown.match(/## Assistant/g).length, 1);
  });

  it("leaves out empty assistant replies, thinking, system and extension messages", () => {
    const markdown = formatMmrThreadMarkdown([
      message("a", null, { role: "user", content: "go" }),
      message("b", "a", { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }),
      message("c", "b", { role: "custom", customType: "note", content: "an extension note", display: true }),
      message("d", "c", { role: "system", content: "You are a coding agent." }),
    ]);
    assert.equal(markdown, '---\ntitle: "go"\n---\n\n# go\n\n## User\n\ngo\n');
  });
});
