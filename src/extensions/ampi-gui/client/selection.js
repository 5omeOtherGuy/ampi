// Selection actions: with text selected in the transcript, `r` quotes it in
// the prompt, `c` copies it as Markdown, `s` copies it with its styling and
// `l` copies a link to it; a chip by the selection offers the same four to
// the mouse and touch. The converter and the link builder at the top are
// pure, so tests run them without a browser; `mountSelectionActions` wires
// them to the page. The keys themselves are commands (commands.js).

import { inTextField } from "./keys.js";

// ---------------------------------------------------------------------------
// HTML to Markdown, for what markdown.js draws

const ELEMENT = 1;
const TEXT = 3;

/** Elements that start a block of their own; everything else is inline. */
const BLOCKS = new Set([
  "ARTICLE",
  "BLOCKQUOTE",
  "DETAILS",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TFOOT",
  "THEAD",
  "TR",
  "UL",
]);

/** Page controls and icons, which are not part of the text. */
const SKIPPED = new Set(["BUTTON", "SVG", "SCRIPT", "STYLE", "TEMPLATE"]);

const tagOf = (node) => (node.nodeType === ELEMENT ? node.nodeName.toUpperCase() : "");
const hasClass = (node, name) => (node.getAttribute?.("class") ?? "").split(/\s+/).includes(name);
const isBlock = (node) => BLOCKS.has(tagOf(node));
/** Hidden elements, controls and a code block's language label, which its fence carries instead. */
const skipped = (node) => node.nodeType === ELEMENT && (node.hasAttribute("hidden") || SKIPPED.has(tagOf(node)) || hasClass(node, "code-label"));

/** The longest run of backticks in `text`. */
function longestTicks(text) {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

/** A fenced code block, its fence longer than any run of backticks inside. */
export function codeFence(code, language = "") {
  const fence = "`".repeat(Math.max(3, longestTicks(code) + 1));
  return `${fence}${language}\n${code.replace(/\n$/, "")}\n${fence}`;
}

function codeSpan(code) {
  const ticks = "`".repeat(longestTicks(code) + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${ticks}${pad}${code}${pad}${ticks}`;
}

/** `inner` between two `mark`s, with any space at its ends kept outside them. */
function wrap(mark, inner) {
  const [, before, body, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  return `${before}${mark}${body}${mark}${after}`;
}

function inlineOf(node) {
  if (node.nodeType === TEXT) return node.nodeValue;
  if (node.nodeType !== ELEMENT || skipped(node)) return "";
  const tag = tagOf(node);
  if (tag === "BR") return "\n";
  if (tag === "CODE") return codeSpan(node.textContent);
  const inner = inlineChildren(node);
  if (inner.trim() === "") return inner;
  if (tag === "STRONG" || tag === "B") return wrap("**", inner);
  if (tag === "EM" || tag === "I") return wrap("*", inner);
  if (tag === "DEL" || tag === "S") return wrap("~~", inner);
  if (tag === "A" && node.getAttribute("href")) return `[${inner}](${node.getAttribute("href")})`;
  return inner;
}

function inlineChildren(node) {
  let text = "";
  for (const child of node.childNodes) text += inlineOf(child);
  return text;
}

function listOf(list, indent) {
  const ordered = tagOf(list) === "OL";
  let number = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
  const items = [];
  for (const child of list.childNodes) {
    if (tagOf(child) === "LI" && !skipped(child)) items.push(itemOf(child, indent, ordered ? `${number++}. ` : "- "));
  }
  return items.join("\n");
}

/** A list item; its later lines and nested lists are indented by the marker's width, as markdown.js reads them. */
function itemOf(item, indent, marker) {
  const inner = indent + " ".repeat(marker.length);
  let text = "";
  const nested = [];
  for (const child of item.childNodes) {
    if (skipped(child)) continue;
    const tag = tagOf(child);
    if (tag === "UL" || tag === "OL") nested.push(listOf(child, inner));
    else if (isBlock(child)) text += `\n${blockOf(child)}`;
    else text += inlineOf(child);
  }
  const [first = "", ...rest] = text.trim().split("\n");
  return [`${indent}${marker}${first}`, ...rest.map((line) => (line === "" ? "" : `${inner}${line}`)), ...nested].join("\n");
}

const cellsOf = (row) => [...row.childNodes].filter((cell) => tagOf(cell) === "TH" || tagOf(cell) === "TD");

function rowOf(row) {
  const cells = cellsOf(row).map((cell) => inlineChildren(cell).trim().replace(/\n/g, " ").replace(/\|/g, "\\|"));
  return `| ${cells.join(" | ")} |`;
}

function separatorOf(row) {
  const marks = cellsOf(row).map((cell) => {
    const align = /(?:^|\s)align-(left|right|center)(?:\s|$)/.exec(cell.getAttribute("class") ?? "")?.[1];
    return align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
  });
  return `| ${marks.join(" | ")} |`;
}

/** Pipe rows, with the separator under a header row. */
function tableOf(table) {
  const rows = [];
  const collect = (node) => {
    for (const child of node.childNodes) {
      const tag = tagOf(child);
      if (tag === "TR") rows.push(child);
      else if (tag === "THEAD" || tag === "TBODY" || tag === "TFOOT") collect(child);
    }
  };
  collect(table);
  const lines = rows.map(rowOf);
  const header = rows.length > 0 && cellsOf(rows[0]).length > 0 && cellsOf(rows[0]).every((cell) => tagOf(cell) === "TH");
  if (header) lines.splice(1, 0, separatorOf(rows[0]));
  return lines.join("\n");
}

function blockOf(node) {
  const tag = tagOf(node);
  const heading = /^H([1-6])$/.exec(tag);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${inlineChildren(node).trim()}`;
  if (tag === "P") return inlineChildren(node).trim();
  if (tag === "HR") return "---";
  if (tag === "UL" || tag === "OL") return listOf(node, "");
  if (tag === "LI") return itemOf(node, "", "- ");
  if (tag === "PRE") return codeFence(node.textContent);
  if (tag === "TABLE") return tableOf(node);
  if (tag === "TR") return rowOf(node);
  if (tag === "BLOCKQUOTE") {
    return blocksOf(node)
      .split("\n")
      .map((line) => (line === "" ? ">" : `> ${line}`))
      .join("\n");
  }
  if (hasClass(node, "code-card")) {
    const pre = [...node.childNodes].find((child) => tagOf(child) === "PRE");
    const label = [...node.childNodes].find((child) => hasClass(child, "code-label"));
    return pre ? codeFence(pre.textContent, label?.textContent.trim() ?? "") : blocksOf(node);
  }
  // A user's message and thinking are shown as written.
  if (hasClass(node, "bubble") || hasClass(node, "thinking-text")) return node.textContent.trim();
  return blocksOf(node);
}

/** The blocks under `parent`, a blank line apart; list items and table rows outside their list or table stay on consecutive lines. */
function blocksOf(parent) {
  const blocks = [];
  let run = "";
  const flush = () => {
    if (run.trim() !== "") blocks.push({ text: run.trim(), tight: false });
    run = "";
  };
  for (const node of parent.childNodes) {
    if (skipped(node)) continue;
    if (isBlock(node)) {
      flush();
      const text = blockOf(node);
      if (text.trim() !== "") blocks.push({ text, tight: tagOf(node) === "LI" || tagOf(node) === "TR" });
    } else run += inlineOf(node);
  }
  flush();
  return blocks.map((block, index) => (index === 0 ? "" : block.tight && blocks[index - 1].tight ? "\n" : "\n\n") + block.text).join("");
}

/**
 * Markdown for a node and what it holds: an element or a fragment of the
 * transcript's markup, from markdown.js (paragraphs, headings, nested
 * lists, fenced code with its language, inline code, emphasis, links,
 * block quotes, tables) or the transcript around it.
 */
export function htmlToMarkdown(root) {
  return (isBlock(root) ? blockOf(root) : blocksOf(root)).replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Links to a selection

/** How many words at each end a long selection's text fragment names. */
const FRAGMENT_WORDS = 3;

/** Percent-encoding for a text fragment, where `-`, `,` and `&` are syntax. */
function encodeFragmentText(text) {
  return encodeURIComponent(text).replace(/-/g, "%2D");
}

/**
 * The text directive that highlights `text`: the whole text when it is
 * short, else its first and last few words as a start and an end. Line
 * breaks count as spaces. Empty for blank text.
 */
export function textFragment(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length <= FRAGMENT_WORDS * 2) return `text=${encodeFragmentText(words.join(" "))}`;
  const start = encodeFragmentText(words.slice(0, FRAGMENT_WORDS).join(" "));
  const end = encodeFragmentText(words.slice(-FRAGMENT_WORDS).join(" "));
  return `text=${start},${end}`;
}

/** The page at `href` without its query (and so its token), at message `anchor`, highlighting `text`. */
export function messageLink(href, anchor, text) {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  const directive = textFragment(text);
  return `${url.href}#${anchor}${directive ? `:~:${directive}` : ""}`;
}

// ---------------------------------------------------------------------------
// The page

/** The chip's entries: action, key, word. */
const CHIP_ACTIONS = [
  ["reply", "r", "reply"],
  ["markdown", "c", "copy"],
  ["styled", "s", "styled"],
  ["link", "l", "link"],
];

/**
 * Wire the selection actions. `item(id)` answers the shown transcript's
 * item, `composer` is the composer's handle, `linkReason()` says why a link
 * cannot be made on this page (or `null`), and `notify` shows a toast.
 */
export function mountSelectionActions({ transcript, scroller, chip, item, composer, linkReason, notify }) {
  /** The transcript selection, `{ range, text }`, or `null` when nothing in it is selected or focus is in a field. */
  function current() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || inTextField(document.activeElement)) return null;
    const range = selection.getRangeAt(0);
    if (!transcript.contains(range.commonAncestorContainer)) return null;
    const text = selection.toString();
    return text.trim() === "" ? null : { range, text };
  }

  /** The selected markup inside shallow copies of the elements around it, up to its message, so a word in a list item or a code block keeps that form. */
  function contextFragment(range) {
    // A numbered list cut after its first item keeps its numbers: the lists the selection starts inside carry their first number into the copy.
    const numbered = [];
    for (let node = range.startContainer; node && node !== transcript; node = node.parentNode) {
      const list = node.parentElement;
      if (node.nodeName !== "LI" || list?.nodeName !== "OL") continue;
      const index = [...list.children].filter((child) => child.nodeName === "LI").indexOf(node);
      if (index <= 0) continue;
      list.dataset.ampiStart = String((Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1) + index);
      numbered.push(list);
    }
    let wrapped;
    try {
      wrapped = contextClone(range);
    } finally {
      for (const list of numbered) delete list.dataset.ampiStart;
    }
    const lists = [...wrapped.querySelectorAll("ol[data-ampi-start]")];
    if (wrapped.matches?.("ol[data-ampi-start]")) lists.push(wrapped);
    for (const list of lists) {
      list.setAttribute("start", list.dataset.ampiStart);
      delete list.dataset.ampiStart;
    }
    return wrapped;
  }

  function contextClone(range) {
    let wrapped = range.cloneContents();
    let node = range.commonAncestorContainer;
    if (node.nodeType !== ELEMENT) node = node.parentElement;
    for (; node && node !== transcript && transcript.contains(node) && !node.matches(".msg"); node = node.parentElement) {
      const shell = node.cloneNode(false);
      shell.append(wrapped);
      if (node.matches(".code-card") && !shell.querySelector(".code-label")) {
        const label = node.querySelector(":scope > .code-label");
        if (label) shell.prepend(label.cloneNode(true));
      }
      wrapped = shell;
    }
    return wrapped;
  }

  /** The Markdown source of the messages' parts when the selection covers each of them whole and nothing else, else `null`. */
  function wholeSources(range) {
    const units = [...transcript.querySelectorAll('.msg.user .bubble, .msg.assistant .part[data-kind="text"]')].filter(
      (unit) => !unit.closest("[hidden]") && range.intersectsNode(unit),
    );
    if (units.length === 0) return null;
    const squash = (text) => text.replace(/\s+/g, "");
    if (squash(range.toString()) !== units.map((unit) => squash(unit.textContent)).join("")) return null;
    const sources = [];
    for (const unit of units) {
      const message = item(unit.closest(".msg").dataset.id);
      const source = unit.matches(".bubble") ? message?.text : message?.parts?.[Number(unit.dataset.part)]?.text;
      if (typeof source !== "string") return null;
      sources.push(source.trim());
    }
    return sources.join("\n\n");
  }

  const markdownOf = (range) => wholeSources(range) ?? htmlToMarkdown(contextFragment(range));

  /** The id of the message the selection starts in. */
  function anchorOf(range) {
    let start = range.startContainer;
    if (start.nodeType !== ELEMENT) start = start.parentElement;
    let message = start?.closest(".msg");
    if (!message || message.hidden) message = [...transcript.querySelectorAll(".msg")].find((node) => !node.hidden && range.intersectsNode(node));
    return message?.id ?? null;
  }

  async function copy(write, done) {
    try {
      await write();
      notify(done);
    } catch {
      notify("The browser did not allow copying to the clipboard.");
    }
  }

  const actions = {
    reply() {
      const selected = current();
      if (!selected || !composer.writable()) return;
      composer.quote(markdownOf(selected.range));
    },
    markdown() {
      const selected = current();
      if (!selected) return;
      const markdown = markdownOf(selected.range);
      return copy(() => navigator.clipboard.writeText(markdown), "Copied the selection as Markdown");
    },
    styled() {
      const selected = current();
      if (!selected) return;
      if (typeof ClipboardItem !== "function" || !navigator.clipboard?.write) {
        return copy(() => navigator.clipboard.writeText(selected.text), "Copied the selection as plain text: this browser cannot copy the styling");
      }
      const box = document.createElement("div");
      box.append(contextFragment(selected.range));
      const data = {
        "text/html": new Blob([box.innerHTML], { type: "text/html" }),
        "text/plain": new Blob([selected.text], { type: "text/plain" }),
      };
      return copy(() => navigator.clipboard.write([new ClipboardItem(data)]), "Copied the selection with its styling");
    },
    link() {
      const selected = current();
      const anchor = selected && anchorOf(selected.range);
      if (!anchor || linkReason()) return;
      const link = messageLink(location.href, anchor, selected.text);
      return copy(() => navigator.clipboard.writeText(link), "Copied a link to the selection");
    },
  };

  function drawChip() {
    const parts = [];
    for (const [action, key, word] of CHIP_ACTIONS) {
      if (action === "reply" && !composer.writable()) continue;
      if (action === "link" && linkReason()) continue;
      if (parts.length > 0) {
        const dot = document.createElement("span");
        dot.className = "selection-chip-dot";
        dot.setAttribute("aria-hidden", "true");
        dot.textContent = "·";
        parts.push(dot);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      button.append(kbd, ` ${word}`);
      parts.push(button);
    }
    chip.replaceChildren(...parts);
  }

  /** Show the chip under the end of the selection (above it near the bottom of the window), or hide it. */
  function update() {
    const selected = current();
    const rects = selected ? selected.range.getClientRects() : [];
    const end = rects[rects.length - 1] ?? selected?.range.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (!selected || !end || end.bottom < view.top || end.top > view.bottom) {
      chip.hidden = true;
      return;
    }
    drawChip();
    chip.hidden = false;
    const width = chip.offsetWidth;
    const height = chip.offsetHeight;
    let top = end.bottom + 6;
    if (top + height > Math.min(view.bottom, window.innerHeight) - 4) top = end.top - height - 6;
    const left = Math.min(Math.max(8, end.right - width / 2), window.innerWidth - width - 8);
    chip.style.top = `${Math.round(top)}px`;
    chip.style.left = `${Math.round(left)}px`;
  }

  let frame = 0;
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    }
  };
  document.addEventListener("selectionchange", schedule);
  scroller.addEventListener("scroll", () => chip.hidden || schedule(), { passive: true });
  window.addEventListener("resize", () => chip.hidden || schedule());
  // A press on the chip keeps the selection (and focus) where they are and acts at once, for the mouse and touch alike.
  chip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const button = event.target.closest?.("button[data-action]");
    if (button && event.button === 0) actions[button.dataset.action]();
  });
  // Enter or Space on a focused chip button.
  chip.addEventListener("click", (event) => {
    const button = event.target.closest?.("button[data-action]");
    if (button && event.detail === 0) actions[button.dataset.action]();
  });

  return {
    /** Whether a non-empty selection lies in the transcript and focus is not in a field. */
    active: () => current() !== null,
    reply: actions.reply,
    copyMarkdown: actions.markdown,
    copyStyled: actions.styled,
    copyLink: actions.link,
  };
}
