// ampi-gui client Markdown renderer: the blocks and inline forms models
// write, and escaping that never lets model output inject markup.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const load = () => importSource("extensions/ampi-gui/client/markdown.js");

describe("ampi-gui Markdown renderer", () => {
  it("escapes raw HTML everywhere, inside code and links too", async () => {
    const { renderMarkdown } = await load();
    const html = renderMarkdown('<img src=x onerror="alert(1)">\n\n`<b>` and [<i>x</i>](https://a.example/?q="1")');
    assert.equal(html.includes("<img"), false);
    assert.equal(html.includes("<i>"), false);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /<code>&lt;b&gt;<\/code>/);
    assert.match(html, /<a href="https:\/\/a\.example\/\?q=&quot;1&quot;" target="_blank" rel="noreferrer noopener">&lt;i&gt;x&lt;\/i&gt;<\/a>/);
  });

  it("keeps only http, https and mailto links", async () => {
    const { renderMarkdown } = await load();
    assert.equal(renderMarkdown("[x](javascript:alert(1))"), "<p>[x](javascript:alert(1))</p>");
    assert.match(renderMarkdown("[mail](mailto:a@b.example)"), /href="mailto:a@b\.example"/);
    assert.match(renderMarkdown("<https://pi.example/docs>"), /<a href="https:\/\/pi\.example\/docs"/);
  });

  it("renders headings, emphasis, inline code and rules", async () => {
    const { renderMarkdown } = await load();
    assert.equal(
      renderMarkdown("## Plan\n\n**bold**, *it*, _it_, ~~old~~ and `a*b*c`\n\n---"),
      "<h2>Plan</h2><p><strong>bold</strong>, <em>it</em>, <em>it</em>, <del>old</del> and <code>a*b*c</code></p><hr>",
    );
    assert.equal(renderMarkdown("snake_case_name stays"), "<p>snake_case_name stays</p>");
  });

  it("renders fenced code with its language, and an unclosed fence while it streams", async () => {
    const { renderMarkdown } = await load();
    assert.equal(
      renderMarkdown("```ts\nconst a = 1 < 2;\n```\nafter"),
      '<div class="code-card"><div class="code-label">ts</div><pre><code>const a = 1 &lt; 2;</code></pre></div><p>after</p>',
    );
    assert.equal(renderMarkdown("```\nstill typing"), '<div class="code-card"><pre><code>still typing</code></pre></div>');
  });

  it("renders nested and numbered lists", async () => {
    const { renderMarkdown } = await load();
    assert.equal(
      renderMarkdown("1. one\n2. two\n   - a\n   - b\n3. three"),
      "<ol><li>one</li><li>two<ul><li>a</li><li>b</li></ul></li><li>three</li></ol>",
    );
    assert.equal(renderMarkdown("3. third\n4. fourth"), '<ol start="3"><li>third</li><li>fourth</li></ol>');
    assert.equal(renderMarkdown("- a\n\n- b\n\nnext"), "<ul><li>a</li><li>b</li></ul><p>next</p>");
  });

  it("renders pipe tables with alignment classes, block quotes and line breaks", async () => {
    const { renderMarkdown } = await load();
    assert.equal(
      renderMarkdown("| Name | Size |\n| :--- | ---: |\n| a.ts | 12 |"),
      '<div class="table-wrap"><table><thead><tr><th class="align-left">Name</th><th class="align-right">Size</th></tr></thead><tbody><tr><td class="align-left">a.ts</td><td class="align-right">12</td></tr></tbody></table></div>',
    );
    assert.equal(renderMarkdown("> quoted\n> text"), "<blockquote><p>quoted<br>text</p></blockquote>");
  });
});
