import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const RENDERING_MODULE = "extensions/mmr-history/progress-rendering.ts";

const fakeTheme = {
  fg(_color, text) { return text; },
  bold(text) { return text; },
  italic(text) { return text; },
};

function renderText(component) {
  return component.render(200).join("\n");
}

function normalize(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/[ \t]+/g, " ").trim();
}

function childTypes(component) {
  return Array.isArray(component.children) ? component.children.map((c) => c.constructor.name) : [];
}

function findChildByType(component, typeName) {
  if (!Array.isArray(component.children)) return undefined;
  return component.children.find((c) => c.constructor.name === typeName);
}

function renderNonMarkdownText(component) {
  // The Markdown component requires Pi's full theme infrastructure to
  // render headings/lists; in unit tests we exercise everything *but*
  // the Markdown child and read its raw text directly instead.
  if (!Array.isArray(component.children)) return component.render(200).join("\n");
  return component.children
    .filter((c) => c.constructor.name !== "Markdown")
    .flatMap((c) => c.render(200))
    .join("\n");
}

describe("mmr-history renderMmrHistoryCall", () => {
  it("renders find_session call with the query", async () => {
    const { renderMmrHistoryCall } = await importSource(RENDERING_MODULE);
    const component = renderMmrHistoryCall("find_session", { query: "auth refactor", limit: 5 }, fakeTheme);
    const text = normalize(renderText(component));
    assert.match(text, /find_session/);
    assert.match(text, /query: auth refactor/);
  });


  it("renders read_session call with goal and sessionId on separate rows", async () => {
    const { renderMmrHistoryCall } = await importSource(RENDERING_MODULE);
    const component = renderMmrHistoryCall(
      "read_session",
      { sessionId: "S-1234567890", goal: "find auth changes" },
      fakeTheme,
    );
    const text = normalize(renderText(component));
    assert.match(text, /read_session/);
    assert.match(text, /goal: find auth changes/);
    assert.match(text, /sessionId: S-1234567890/);
  });

  it("renders read_session call when only the legacy threadID parameter is provided", async () => {
    // The schema no longer advertises threadID, but the render path
    // still surfaces a value passed in args so legacy callers don't
    // see a blank progress row while their tool call is in flight.
    const { renderMmrHistoryCall } = await importSource(RENDERING_MODULE);
    const component = renderMmrHistoryCall(
      "read_session",
      { threadID: "T-XYZ", goal: "find regressions" },
      fakeTheme,
    );
    const text = normalize(renderText(component));
    assert.match(text, /sessionId: T-XYZ/);
  });

  it("omits the goal label when args[goal] is missing", async () => {
    const { renderMmrHistoryCall } = await importSource(RENDERING_MODULE);
    const component = renderMmrHistoryCall("read_session", { sessionId: "S-1" }, fakeTheme);
    const text = normalize(renderText(component));
    assert.match(text, /read_session/);
    assert.doesNotMatch(text, /goal:/);
    assert.match(text, /sessionId: S-1/);
  });
});

describe("mmr-history renderMmrHistoryResult — find_session", () => {
  it("collapses to a single match-count line when not expanded", async () => {
    const { renderMmrHistoryResult } = await importSource(RENDERING_MODULE);
    const result = {
      content: [{ type: "text", text: "## Match\n- S-1: example" }],
      details: {
        query: "auth",
        resultCount: 3,
        scope: "all_sessions",
        matches: [],
        queryDiagnostics: [],
      },
    };
    const component = renderMmrHistoryResult("find_session", result, { expanded: false }, fakeTheme);
    const text = normalize(renderText(component));
    assert.match(text, /find_session/);
    assert.match(text, /3 matches/);
    assert.match(text, /succeeded/);
    // No Markdown body in the collapsed view.
    assert.equal(childTypes(component).includes("Markdown"), false);
  });

  it("renders the result text as Markdown when expanded", async () => {
    const { renderMmrHistoryResult } = await importSource(RENDERING_MODULE);
    const result = {
      content: [{ type: "text", text: "## Match\n- S-1: example" }],
      details: { query: "auth", resultCount: 1, scope: "all_sessions", matches: [], queryDiagnostics: [] },
    };
    const component = renderMmrHistoryResult("find_session", result, { expanded: true }, fakeTheme);
    const markdown = findChildByType(component, "Markdown");
    assert.ok(markdown, "expanded find_session result must render the text as a Markdown component");
    // The Markdown component owns the body text; check it directly
    // rather than forcing Pi's theme infrastructure to render in tests.
    assert.match(markdown.text, /## Match/);
    assert.match(markdown.text, /S-1: example/);
  });

  it("uses 'error' label when context.isError is true (collapsed view)", async () => {
    const { renderMmrHistoryResult } = await importSource(RENDERING_MODULE);
    const result = { content: [{ type: "text", text: "boom" }], details: undefined };
    const component = renderMmrHistoryResult(
      "find_session",
      result,
      { expanded: false },
      fakeTheme,
      { isError: true },
    );
    const text = normalize(renderText(component));
    assert.match(text, /error/);
    assert.doesNotMatch(text, /succeeded/);
  });
});

describe("mmr-history renderMmrHistoryResult — read_session", () => {
  it("renders the markdown body and a worker analysis footer when worker analysis ran", async () => {
    const { renderMmrHistoryResult } = await importSource(RENDERING_MODULE);
    const result = {
      content: [{ type: "text", text: "## Analysis\n- finding 1\n- finding 2" }],
      details: {
        scope: "all_sessions",
        projectRef: "deadbeef",
        analysisUsed: "worker",
        sessionId: "S-1",
        excerpts: [],
        worker: {
          worker: "mmr-history.history-reader",
          profile: "history-reader",
          model: "openai-codex/gpt-5.4-mini",
          reportedModel: "openai-codex/gpt-5.4-mini",
          exitCode: 0,
          signal: null,
          aborted: false,
          outputTruncated: false,
          ignoredJsonLines: 0,
          usage: { input: 12000, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0.0123, contextTokens: 11800, turns: 1 },
          workerTools: [],
          packetBytes: 4321,
          packetTruncated: false,
        },
      },
    };
    const component = renderMmrHistoryResult("read_session", result, { expanded: true }, fakeTheme);
    const markdown = findChildByType(component, "Markdown");
    assert.ok(markdown, "expanded read_session result must render the text as a Markdown component");
    assert.match(markdown.text, /## Analysis/);
    assert.match(markdown.text, /finding 1/);
    // Footer rows are plain Text and render fine in tests.
    const footer = normalize(renderNonMarkdownText(component));
    assert.match(footer, /analysis: worker/);
    assert.match(footer, /1 turn/);
    assert.match(footer, /\$0\.0123/);
    assert.match(footer, /gpt-5\.4-mini/);
  });

  it("shows 'analysis: lexical' and the fallback reason when worker analysis was skipped", async () => {
    const { renderMmrHistoryResult } = await importSource(RENDERING_MODULE);
    const result = {
      content: [{ type: "text", text: "## Lexical excerpts\n- e1" }],
      details: {
        scope: "all_sessions",
        projectRef: "deadbeef",
        analysisUsed: "lexical",
        analysisFallbackReason: "No authenticated history-reader model route is available.",
        sessionId: "S-1",
        excerpts: [],
      },
    };
    const component = renderMmrHistoryResult("read_session", result, { expanded: true }, fakeTheme);
    const footer = normalize(renderNonMarkdownText(component));
    assert.match(footer, /analysis: lexical/);
    assert.match(footer, /lexical fallback: No authenticated history-reader/);
  });

  it("omits the worker footer when there is no worker block (pure lexical run)", async () => {
    const { renderMmrHistoryResult } = await importSource(RENDERING_MODULE);
    const result = {
      content: [{ type: "text", text: "## body" }],
      details: { scope: "all_sessions", projectRef: "deadbeef", analysisUsed: "lexical", sessionId: "S-1", excerpts: [] },
    };
    const component = renderMmrHistoryResult("read_session", result, { expanded: true }, fakeTheme);
    const footer = normalize(renderNonMarkdownText(component));
    // 'analysis: lexical' is the only footer row; no worker usage / model line.
    assert.match(footer, /analysis: lexical/);
    assert.doesNotMatch(footer, /turn/);
    assert.doesNotMatch(footer, /↑|↓|R\d+|\$/);
  });

  it("renders a friendly placeholder when expanded with no text content", async () => {
    const { renderMmrHistoryResult } = await importSource(RENDERING_MODULE);
    const result = { content: [], details: undefined };
    const component = renderMmrHistoryResult("read_session", result, { expanded: true }, fakeTheme);
    const text = normalize(renderNonMarkdownText(component));
    assert.match(text, /no result content/);
  });
});

describe("mmr-history renderers are wired onto the tool definitions", () => {
  it("createFindSessionTool registers renderCall and renderResult", async () => {
    const { createFindSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const tool = createFindSessionTool({
      getSettings: () => ({ enabled: true, maxResults: 10, defaultLimit: 5 }),
      listSessions: async () => ({ infos: [], hasMore: false }),
      openSession: () => ({}),
    });
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  });

  it("createReadSessionTool registers renderCall and renderResult", async () => {
    const { createReadSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const tool = createReadSessionTool({
      getSettings: () => ({ enabled: true, maxResults: 10, defaultLimit: 5 }),
      listSessions: async () => ({ infos: [], hasMore: false }),
      openSession: () => ({}),
    });
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  });
});
