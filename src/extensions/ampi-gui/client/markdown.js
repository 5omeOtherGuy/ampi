// A small Markdown renderer for the transcript.
//
// It covers what models write: paragraphs, ATX headings, fenced code (an
// unclosed fence runs to the end, so streaming text renders as it grows),
// block quotes, nested bullet and numbered lists, pipe tables, rules, and
// inline code, bold, italic, strikethrough and links. Every piece of source
// text is HTML-escaped before any tag is added, and links keep only http,
// https and mailto targets, so model output can never inject markup.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const SAFE_URL = /^(https?:|mailto:)/i;

/** Inline Markdown to HTML. */
export function renderInline(source) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let text = String(source).replace(/\u0000/g, "");
  // Code spans first, so nothing inside them is touched.
  text = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks, code) => hold(`<code>${escapeHtml(code.replace(/^ (.*) $/, "$1"))}</code>`));
  // Links: [label](url). The label keeps its inline formatting.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label, url) => {
    if (!SAFE_URL.test(url)) return match;
    return hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${renderInline(label)}</a>`);
  });
  text = text.replace(/<(https?:\/\/[^\s>]+)>/g, (_m, url) => hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)}</a>`));
  text = escapeHtml(text);
  text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
  text = text.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  // Slots may hold other slots (a link around inline code), so restore until none are left.
  while (text.includes("\u0000")) text = text.replace(/\u0000(\d+)\u0000/g, (_m, index) => slots[Number(index)]);
  return text;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isBlockStart(line, next) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes("-"))
  );
}

function renderCode(lines, language) {
  const label = language ? `<div class="code-label">${escapeHtml(language)}</div>` : "";
  return `<div class="code-card">${label}<pre><code>${escapeHtml(lines.join("\n"))}</code></pre></div>`;
}

function renderTable(header, aligns, rows) {
  const cell = (tag, text, index) => {
    const align = aligns[index];
    return `<${tag}${align ? ` class="align-${align}"` : ""}>${renderInline(text)}</${tag}>`;
  };
  const head = `<tr>${header.map((text, i) => cell("th", text, i)).join("")}</tr>`;
  const body = rows.map((row) => `<tr>${header.map((_h, i) => cell("td", row[i] ?? "", i)).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** A list starting at `start`; returns its HTML and the index after it. */
function renderList(lines, start) {
  const items = [];
  let index = start;
  const first = LIST_ITEM.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  while (index < lines.length) {
    const line = lines[index];
    const match = LIST_ITEM.exec(line);
    if (match && match[1].length === baseIndent && /\d/.test(match[2]) === ordered) {
      items.push({ text: [match[3]], children: [] });
      index++;
      continue;
    }
    const current = items[items.length - 1];
    if (match && match[1].length > baseIndent) {
      const nested = renderList(lines, index);
      current.children.push(nested.html);
      index = nested.next;
      continue;
    }
    if (line.trim() === "") {
      // A blank line ends the list unless the next line continues it.
      const next = lines[index + 1];
      const nextMatch = next !== undefined ? LIST_ITEM.exec(next) : null;
      if (next !== undefined && ((nextMatch && nextMatch[1].length >= baseIndent) || /^\s{2,}\S/.test(next))) {
        index++;
        continue;
      }
      break;
    }
    if (/^\s+\S/.test(line) && !match) {
      current.text.push(line.trim());
      index++;
      continue;
    }
    break;
  }
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : "";
  const body = items.map((item) => `<li>${renderInline(item.text.join("\n"))}${item.children.join("")}</li>`).join("");
  return { html: `<${tag}${startAttr}>${body}</${tag}>`, next: index };
}

/** Block Markdown to HTML. */
export function renderMarkdown(source) {
  const lines = String(source ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) body.push(lines[index++]);
      index++;
      out.push(renderCode(body, fence[2]));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      index++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (index < lines.length && QUOTE.test(lines[index])) body.push(lines[index++].replace(QUOTE, ""));
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = renderList(lines, index);
      out.push(list.html);
      index = list.next;
      continue;
    }
    const next = lines[index + 1];
    if (line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes("-")) {
      const header = splitRow(line);
      const aligns = splitRow(next).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : "";
      });
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") rows.push(splitRow(lines[index++]));
      out.push(renderTable(header, aligns, rows));
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() !== "" && !isBlockStart(lines[index], lines[index + 1])) paragraph.push(lines[index++]);
    out.push(`<p>${renderInline(paragraph.map((text) => text.trim()).join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("");
}
