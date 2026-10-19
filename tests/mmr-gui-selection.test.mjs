// ampi-gui selection actions: the HTML-to-Markdown converter behind "copy
// as Markdown" and "reply", the text fragment a copied link carries, the
// quote a reply puts in the prompt, and the message anchors links point at,
// as pure functions; the chip's presses and the whole-part copy on a
// linkedom page with a stand-in selection. Layout is checked in a browser.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const selection = () => importSource("extensions/ampi-gui/client/selection.js");
const markdown = () => importSource("extensions/ampi-gui/client/markdown.js");

/** `html` parsed into a detached container, as the page hands the converter a selection's markup. */
function container(html) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="root">${html}</div></body></html>`);
  return document.getElementById("root");
}

/** Markdown drawn by the transcript's renderer, then converted back. */
async function roundTrip(source) {
  const { htmlToMarkdown } = await selection();
  const { renderMarkdown } = await markdown();
  return htmlToMarkdown(container(renderMarkdown(source)));
}

describe("ampi-gui HTML to Markdown", () => {
  it("converts each element the renderer draws back to its Markdown", async () => {
    const sources = [
      "## Heading two",
      "Some **bold**, *italic*, ~~struck~~ and `inline code`.",
      "See [the docs](https://pi.example/docs) and [`run`](https://pi.example/run).",
      "> A quote with **weight**\n>\n> and a second paragraph",
      "---",
      "4. four\n5. five",
      "| Name | Count | Note |\n| :--- | ---: | :---: |\n| a | 1 | x \\| y |",
      "```ts\nconst value = 1;\n```",
      "First line\nsecond line of the same paragraph",
    ];
    for (const source of sources) assert.equal(await roundTrip(source), source, source);
  });

  it("keeps a nested list's levels at the marker widths the renderer reads", async () => {
    const source = "- one\n- two\n  - two a\n  - two b\n    1. deep\n    2. deeper\n- three";
    assert.equal(await roundTrip(source), source);
    const { renderMarkdown } = await markdown();
    assert.equal(renderMarkdown(await roundTrip(source)), renderMarkdown(source), "the copy renders as the original");
  });

  it("fences code that holds backticks with a longer fence, and code spans with longer ticks", async () => {
    const block = "````md\n```js\nlet a = `b`;\n```\n````";
    assert.equal(await roundTrip(block), block);
    const { htmlToMarkdown, codeFence } = await selection();
    assert.equal(htmlToMarkdown(container("<pre><code>a ``` b\n````\nc</code></pre>")), "`````\na ``` b\n````\nc\n`````");
    assert.equal(codeFence("plain"), "```\nplain\n```", "three backticks at least");
    assert.equal(htmlToMarkdown(container("<p>use <code>a`b</code> and <code>`x</code></p>")), "use ``a`b`` and `` `x ``");
  });

  it("keeps blocks a partial selection cut out of their list or table on consecutive lines", async () => {
    const { htmlToMarkdown } = await selection();
    assert.equal(htmlToMarkdown(container("<li>first</li><li>second <strong>bold</strong></li>")), "- first\n- second **bold**");
    assert.equal(htmlToMarkdown(container("<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>")), "| a | b |\n| c | d |");
  });

  it("leaves out hidden work, buttons and icons, and keeps a user's message as written", async () => {
    const { htmlToMarkdown } = await selection();
    const html =
      '<article class="msg user"><div class="bubble">Line *one*\n\n  indented</div></article>' +
      '<div class="work-fold"><button type="button">Worked for 5 seconds<svg><path d="M0 0"/></svg></button></div>' +
      '<article class="msg assistant" hidden><div class="part"><div class="prose"><p>hidden work</p></div></div></article>' +
      '<article class="msg assistant"><div class="part"><div class="prose"><p>The <em>answer</em></p></div></div></article>';
    assert.equal(htmlToMarkdown(container(html)), "Line *one*\n\n  indented\n\nThe *answer*");
  });

  it("moves spaces a partial selection left inside emphasis outside the marks", async () => {
    const { htmlToMarkdown } = await selection();
    assert.equal(htmlToMarkdown(container("<p>a<strong>bold </strong>word</p>")), "a**bold** word");
  });
});

describe("ampi-gui links to a selection", () => {
  it("percent-encodes the characters text fragments use as syntax", async () => {
    const { textFragment } = await selection();
    assert.equal(textFragment("well-known, fast & safe"), "text=well%2Dknown%2C%20fast%20%26%20safe");
  });

  it("names a short selection whole and a long one by its first and last words", async () => {
    const { textFragment } = await selection();
    assert.equal(textFragment("  word "), "text=word");
    assert.equal(textFragment("one two three four five six"), "text=one%20two%20three%20four%20five%20six", "six words stay whole");
    assert.equal(textFragment("one two three four five six seven"), "text=one%20two%20three,five%20six%20seven");
    assert.equal(textFragment(" \n "), "");
  });

  it("joins a selection over several lines with spaces", async () => {
    const { textFragment } = await selection();
    assert.equal(textFragment("first line\nsecond\n\n  third line"), "text=first%20line%20second%20third%20line");
    assert.equal(textFragment("alpha beta gamma\ndelta\nepsilon zeta eta"), "text=alpha%20beta%20gamma,epsilon%20zeta%20eta");
  });

  it("links to the page without its query or old fragment, at the message, with the text directive", async () => {
    const { messageLink } = await selection();
    const token = ["tok", "en"].join("");
    assert.equal(messageLink(`http://127.0.0.1:4100/?t=${token}#m-old`, "m-u17", "hello world"), "http://127.0.0.1:4100/#m-u17:~:text=hello%20world");
    assert.equal(messageLink("http://127.0.0.1:4100/s/abc?x=1", "m-a18", "x-y"), "http://127.0.0.1:4100/s/abc#m-a18:~:text=x%2Dy");
    assert.equal(messageLink("http://127.0.0.1:4100/", "m-a18", " "), "http://127.0.0.1:4100/#m-a18");
  });
});

describe("ampi-gui reply quote", () => {
  it("quotes every line, marks blank ones and ends with a blank line, the caret after it", async () => {
    const { quoteReply } = await importSource("extensions/ampi-gui/client/composer.js");
    const empty = quoteReply("\nline one\n\n  line two\n\n", "");
    assert.equal(empty.text, "> line one\n>\n>   line two\n\n");
    assert.equal(empty.caret, empty.text.length);
    assert.deepEqual(quoteReply("quoted", "   \n"), { text: "> quoted\n\n", caret: 10 }, "a blank prompt counts as empty");
  });

  it("keeps what the prompt holds and puts the quote in a new paragraph after it", async () => {
    const { quoteReply } = await importSource("extensions/ampi-gui/client/composer.js");
    const reply = quoteReply("a\nb", "Draft first\n");
    assert.equal(reply.text, "Draft first\n\n> a\n> b\n\n");
    assert.equal(reply.caret, reply.text.length);
  });
});

describe("ampi-gui message anchors", () => {
  it("prefixes message ids so a link names only a message", async () => {
    const { MESSAGE_ANCHOR_PREFIX, anchorItemId, messageAnchorId } = await importSource("extensions/ampi-gui/client/transcript.js");
    assert.equal(MESSAGE_ANCHOR_PREFIX, "m-");
    assert.equal(messageAnchorId("u1760000000000"), "m-u1760000000000");
    assert.equal(anchorItemId("m-u1760000000000"), "u1760000000000");
    assert.equal(anchorItemId("/s/session-id"), null, "a session route is no message");
    assert.equal(anchorItemId("transcript"), null, "another element's id is no message");
    assert.equal(anchorItemId("m-"), null);
  });
});

describe("ampi-gui selection chip", () => {
  const PAGE =
    '<div id="chat"><div id="transcript"><article class="msg assistant" data-id="a1" id="m-a1">' +
    '<div class="part" data-kind="text" data-part="0"><div class="prose"><p>Some <strong>bold</strong> text</p></div></div>' +
    '<div class="part" data-kind="text" data-part="1"><div class="prose"><p>Next part</p></div></div>' +
    '</article></div></div><div id="chip"><button type="button" data-action="markdown">c copy</button></div>';
  const SOURCES = ["Some __bold__ text", "Next part"];

  /** The transcript's text nodes in document order. */
  function textNodes(node, out = []) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out.push(child);
      else textNodes(child, out);
    }
    return out;
  }

  /**
   * A stand-in for the browser's Range from (`texts[from]`, `startOffset`)
   * to (`texts[to]`, `endOffset`): a node intersects it when it holds one of
   * those text nodes, as a browser answers for boundaries in text nodes.
   */
  function textRange(document, root, texts, [from, startOffset], [to, endOffset]) {
    const inside = texts.slice(from, to + 1);
    return {
      startContainer: texts[from],
      startOffset,
      endContainer: texts[to],
      endOffset,
      commonAncestorContainer: root,
      intersectsNode: (node) => inside.some((text) => node === text || node.contains(text)),
      toString: () => inside.map((text, index) => text.nodeValue.slice(index === 0 ? startOffset : 0, index === inside.length - 1 ? endOffset : undefined)).join(""),
      cloneContents: () => {
        const fragment = document.createDocumentFragment();
        for (const part of root.querySelectorAll(".part")) if (inside.some((text) => part.contains(text))) fragment.append(part.cloneNode(true));
        return fragment;
      },
    };
  }

  /** A linkedom page with the selection actions mounted and `range(texts)` selected; the globals are the page's while `run` runs. */
  async function withChip(range, run) {
    const { mountSelectionActions } = await selection();
    const { window, document } = parseHTML(`<!doctype html><html><body>${PAGE}</body></html>`);
    const transcript = document.getElementById("transcript");
    const selected = range(document, transcript.querySelector(".msg"), textNodes(transcript));
    document.getSelection = () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => selected, toString: () => selected.toString() });
    const copied = [];
    const saved = { document: globalThis.document, window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
    globalThis.document = document;
    globalThis.window = window;
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (text) => copied.push(text) } }, configurable: true });
    try {
      const actions = mountSelectionActions({
        transcript,
        scroller: document.getElementById("chat"),
        chip: document.getElementById("chip"),
        item: (id) => (id === "a1" ? { type: "assistant", parts: SOURCES.map((text) => ({ type: "text", text })) } : undefined),
        composer: { writable: () => true, quote: () => {} },
        linkReason: () => null,
        notify: () => {},
      });
      const button = document.querySelector('#chip [data-action="markdown"]');
      const fire = (type, props) => {
        const event = Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), props);
        button.dispatchEvent(event);
        return event;
      };
      await run({ actions, copied, fire });
    } finally {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      Object.defineProperty(globalThis, "navigator", saved.navigator);
    }
  }

  const firstPart = (document, root, texts) => textRange(document, root, texts, [0, 0], [2, texts[2].nodeValue.length]);
  const settle = () => new Promise(setImmediate);

  it("keeps the selection on a press and copies on the click a mouse ends it with", async () => {
    await withChip(firstPart, async ({ copied, fire }) => {
      assert.equal(fire("pointerdown", { pointerType: "mouse", button: 0 }).defaultPrevented, true, "the press keeps the selection");
      fire("pointerup", { pointerType: "mouse", button: 0 });
      await settle();
      assert.deepEqual(copied, [], "nothing is copied before the click");
      fire("click", { detail: 1 });
      await settle();
      assert.deepEqual(copied, ["Some __bold__ text"]);
    });
  });

  it("copies once when a finger lifts, before the click a tap ends with", async () => {
    await withChip(firstPart, async ({ copied, fire }) => {
      assert.equal(fire("pointerdown", { pointerType: "touch", button: 0 }).defaultPrevented, true);
      await settle();
      assert.deepEqual(copied, [], "nothing is copied on touching down");
      fire("pointerup", { pointerType: "touch", button: 0 });
      fire("click", { detail: 1 });
      await settle();
      assert.deepEqual(copied, ["Some __bold__ text"]);
    });
  });

  it("copies on Enter or Space, a click of detail 0", async () => {
    await withChip(firstPart, async ({ copied, fire }) => {
      fire("click", { detail: 0 });
      await settle();
      assert.deepEqual(copied, ["Some __bold__ text"]);
    });
  });

  it("copies a part's own source when the selection ends at offset 0 of the next part", async () => {
    // A triple click on the first part's paragraph.
    const tripleClick = (document, root, texts) => textRange(document, root, texts, [0, 0], [3, 0]);
    await withChip(tripleClick, async ({ actions, copied }) => {
      await actions.copyMarkdown();
      assert.deepEqual(copied, ["Some __bold__ text"]);
    });
    const both = (document, root, texts) => textRange(document, root, texts, [0, 0], [3, texts[3].nodeValue.length]);
    await withChip(both, async ({ actions, copied }) => {
      await actions.copyMarkdown();
      assert.deepEqual(copied, ["Some __bold__ text\n\nNext part"], "both parts whole copy both sources");
    });
  });
});
