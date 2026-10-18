import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

let analyzeMmrContext;

before(async () => {
  ({ analyzeMmrContext } = await importSource("extensions/ampi-threads/context-analysis.ts"));
});

const tokens = (text) => Math.ceil(text.length / 4);
const declaration = (tool) => tokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));

let nextId = 0;
/** A chain of entries, each the child of the one before. */
function chain(...bodies) {
  let parentId = null;
  return bodies.map((body) => {
    const id = `e${++nextId}`;
    const entry = { id, parentId, timestamp: "2026-10-18T10:00:00.000Z", ...body };
    parentId = id;
    return entry;
  });
}
const message = (body) => ({ type: "message", message: { timestamp: 0, ...body } });

const READ = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const BASH = { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } };
const WRITE = { name: "write", description: "Write a file", parameters: { type: "object" } };
const SEARCH = { name: "mcp__docs__search", description: "Search the docs", parameters: { type: "object" } };

const agentsBlock = (file, content) => `<project_instructions path="${file}">\n${content}\n</project_instructions>`;
const BLOCKS = [agentsBlock("/work/AGENTS.md", "Use tabs.".repeat(10)), agentsBlock("/work/pkg/AGENTS.md", "Run the tests.")];
const SKILLS = formatSkillsForPrompt([
  { name: "pdf", description: "Read PDF files", filePath: "/skills/pdf/SKILL.md", baseDir: "/skills/pdf", disableModelInvocation: false },
  { name: "deploy", description: "Ship the site", filePath: "/skills/deploy/SKILL.md", baseDir: "/skills/deploy", disableModelInvocation: false },
]).trim();
const SECTIONS = {
  preamble: "p".repeat(400),
  project_context: `<project_context>\nProject-specific instructions and guidelines:\n\n${BLOCKS.join("\n\n")}\n</project_context>`,
  skills: `<skills>\n${SKILLS}\n</skills>`,
  cwd: "<cwd>\n/work\n</cwd>",
};

const section = (analysis, id) => analysis.sections.find((candidate) => candidate.id === id);

describe("context analysis", () => {
  it("splits the recorded prompt into AGENTS.md files, skills and the rest, and tools into built-in and MCP", () => {
    const entries = chain(
      message({ role: "system", content: "", sections: SECTIONS, toolsAdded: [READ, BASH, SEARCH] }),
      message({ role: "user", content: "u".repeat(40) }),
      message({ role: "assistant", content: [{ type: "text", text: "a".repeat(80) }] }),
      // A later prompt change: bash goes, write comes, the cwd section is removed.
      message({ role: "system", content: "", sections: { cwd: null }, toolsRemoved: [{ name: "bash" }], toolsAdded: [WRITE] }),
      message({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "r".repeat(120) }], isError: false }),
    );
    const analysis = analyzeMmrContext({ entries, model: "acme/one", contextWindow: 2000, measuredTokens: 900, mcpTools: new Set([SEARCH.name]) });

    const prompt = [SECTIONS.preamble, SECTIONS.project_context, SECTIONS.skills].join("\n\n");
    const agentsChars = BLOCKS.join("").length;
    const skillsList = SKILLS.slice(SKILLS.indexOf("<available_skills>"));
    assert.ok(skillsList.endsWith("</available_skills>"), "Pi's skills list still ends the skills text");

    assert.deepEqual(
      analysis.sections.map((entry) => [entry.id, entry.name, entry.tokens, entry.count]),
      [
        ["system-prompt", "System prompt", Math.ceil((prompt.length - agentsChars - skillsList.length) / 4), undefined],
        ["builtin-tools", "Built-in tools", declaration(READ) + declaration(WRITE), 2],
        ["agents-files", "AGENTS.md files", Math.ceil(agentsChars / 4), 2],
        ["mcp-tools", "MCP tools", declaration(SEARCH), 1],
        ["loaded-skills", "Loaded skills", Math.ceil(skillsList.length / 4), 2],
        ["compaction-summary", "Compaction summary", 0, undefined],
        ["messages", "Messages", 10 + 20 + 30, undefined],
      ],
    );
    assert.equal(analysis.totalTokens, analysis.sections.reduce((sum, entry) => sum + entry.tokens, 0));
    assert.equal(analysis.model, "acme/one");
    assert.equal(analysis.contextWindow, 2000);
    assert.equal(analysis.measuredTokens, 900);
    assert.equal(analysis.compactionCount, 0);
  });

  it("counts every compaction on the branch and the latest summary, with the conversation kept after it", () => {
    const system = { role: "system", content: "s".repeat(200), timestamp: 0 };
    const before = chain(
      message(system),
      message({ role: "user", content: "x".repeat(400) }),
      message({ role: "assistant", content: [{ type: "text", text: "y".repeat(400) }] }),
    );
    const first = chain({ type: "compaction", summary: "f".repeat(100), firstKeptEntryId: "", tokensBefore: 500, systemMessage: system })[0];
    first.parentId = before.at(-1).id;
    first.firstKeptEntryId = first.id;
    const kept = chain(message({ role: "user", content: "k".repeat(40) }));
    kept[0].parentId = first.id;
    const second = chain({ type: "compaction", summary: "z".repeat(200), firstKeptEntryId: kept[0].id, tokensBefore: 300, systemMessage: system })[0];
    second.parentId = kept[0].id;
    const after = chain(message({ role: "assistant", content: [{ type: "text", text: "w".repeat(20) }] }));
    after[0].parentId = second.id;

    const analysis = analyzeMmrContext({ entries: [...before, first, ...kept, second, ...after], contextWindow: 1000 });
    assert.equal(analysis.compactionCount, 2);
    assert.equal(section(analysis, "compaction-summary").tokens, 50, "only the latest summary is sent");
    assert.equal(section(analysis, "messages").tokens, 10 + 5, "the kept prompt and the reply after the compaction");
    assert.equal(section(analysis, "system-prompt").tokens, 50, "the prompt checkpoint the compaction recorded");
  });

  it("uses the prompt and tools Pi would send while the session records none, and leaves an unknown window unknown", () => {
    const analysis = analyzeMmrContext({
      entries: [],
      pending: { systemPrompt: `${"q".repeat(80)}\n\n${BLOCKS[1]}`, tools: [READ, SEARCH] },
      mcpTools: new Set([SEARCH.name]),
      contextWindow: 0,
    });
    assert.equal(section(analysis, "system-prompt").tokens, Math.ceil(82 / 4), "80 characters and the blank line before the AGENTS.md block");
    assert.equal(section(analysis, "agents-files").count, 1);
    assert.equal(section(analysis, "builtin-tools").count, 1);
    assert.equal(section(analysis, "mcp-tools").count, 1);
    assert.equal(section(analysis, "messages").tokens, 0);
    assert.equal(analysis.contextWindow, undefined);
    assert.equal(analysis.measuredTokens, undefined);
  });
});
