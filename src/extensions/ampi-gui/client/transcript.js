// Drawing the transcript: prose, thinking and tool rows, the work groups
// that fold a run of tool calls into one line, and the work fold that hides
// a finished turn's work behind "Worked for <duration>". Pure functions over
// the server's items and groups, so the page and the tests share them.

import { escapeHtml, renderMarkdown } from "./markdown.js";

export const CHEVRON = '<svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

/** What a message's element id starts with, so a link's `#m-<item id>` can never name another element of the page. */
export const MESSAGE_ANCHOR_PREFIX = "m-";

/** The element id of the message for item `id`. */
export function messageAnchorId(id) {
  return `${MESSAGE_ANCHOR_PREFIX}${id}`;
}

/** The item id a message anchor names, or `null` for any other fragment. */
export function anchorItemId(anchor) {
  return anchor.startsWith(MESSAGE_ANCHOR_PREFIX) && anchor.length > MESSAGE_ANCHOR_PREFIX.length ? anchor.slice(MESSAGE_ANCHOR_PREFIX.length) : null;
}

// ---------------------------------------------------------------------------
// The transcript's items and groups, indexed for drawing

/** An empty transcript: items by id in order, groups by id, and which group and item each call belongs to. */
export function createTranscript() {
  return { items: new Map(), groups: new Map(), callGroup: new Map(), callItem: new Map() };
}

/** Add or replace an item. */
export function setItem(transcript, item) {
  transcript.items.set(item.id, item);
  for (const part of item.parts ?? []) if (part.type === "tool") transcript.callItem.set(part.toolCallId, item.id);
}

/** Apply changed groups and drop removed ones. */
export function setGroups(transcript, groups, removed = []) {
  for (const id of removed) transcript.groups.delete(id);
  for (const group of groups) {
    transcript.groups.set(group.id, group);
    for (const callId of group.callIds) transcript.callGroup.set(callId, group.id);
  }
}

/** The group a call belongs to, or undefined for a call that keeps its own row. */
export function groupOf(transcript, callId) {
  const group = transcript.groups.get(transcript.callGroup.get(callId));
  return group?.callIds.includes(callId) ? group : undefined;
}

/** The ids of the items holding a group's calls. */
export function groupItemIds(transcript, group) {
  return new Set(group.callIds.map((callId) => transcript.callItem.get(callId)).filter(Boolean));
}

function toolPart(transcript, callId) {
  const item = transcript.items.get(transcript.callItem.get(callId));
  return item?.parts?.find((part) => part.type === "tool" && part.toolCallId === callId);
}

// ---------------------------------------------------------------------------
// Rows

export function titleHtml(parts) {
  return parts.map((part) => `<span class="part-${escapeHtml(part.role)}">${escapeHtml(part.text)}</span>`).join("");
}

/** One line, expandable when it has a body. `name` makes the rows sharing it an accordion: one open at a time. */
export function rowHtml(key, status, line, body, open, name) {
  if (!body) return `<div class="row" data-status="${escapeHtml(status)}"><div class="row-line">${CHEVRON}<span class="row-text">${line}</span></div></div>`;
  const attrs = `${name ? ` name="${escapeHtml(name)}"` : ""}${open?.has(key) ? " open" : ""}`;
  return `<details class="row" data-status="${escapeHtml(status)}" data-key="${escapeHtml(key)}"${attrs}><summary>${CHEVRON}<span class="row-text">${line}</span></summary><div class="row-body">${body}</div></details>`;
}

/** A file change as lines: additions and removals coloured, everything escaped. */
export function diffHtml(diff) {
  const lines = String(diff)
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : /^(\*\*\*|@@)/.test(line) ? "meta" : "context";
      return `<span class="diff-line diff-${kind}">${escapeHtml(line) || " "}</span>`;
    });
  return `<pre class="tool-diff">${lines.join("")}</pre>`;
}

/** What an expanded call shows: the full command, the arguments, the change, the output. */
export function toolBodyHtml(part) {
  const sections = [];
  if (part.command) sections.push(`<pre class="tool-command"><span class="part-muted">$ </span>${escapeHtml(part.command)}</pre>`);
  if (part.args) sections.push(`<pre class="tool-args">${escapeHtml(part.args)}</pre>`);
  if (part.diff) sections.push(diffHtml(part.diff));
  else if (part.output) sections.push(`<pre class="tool-output">${escapeHtml(part.output)}${part.outputTruncated ? "\n…" : ""}</pre>`);
  return sections.length > 0 ? `<div class="tool-card">${sections.join("")}</div>` : "";
}

export function toolHtml(part, open, name) {
  return rowHtml(`tool:${part.toolCallId}`, part.status, titleHtml(part.title), toolBodyHtml(part), open, name);
}

/** A work group: its label on one line, its calls below it, one of them open at a time. */
export function groupHtml(transcript, group, open) {
  const key = `group:${group.id}`;
  const children = group.callIds
    .map((callId) => toolPart(transcript, callId))
    .filter(Boolean)
    .map((part) => toolHtml(part, open, key))
    .join("");
  const took = group.endedAt !== undefined && group.startedAt !== undefined ? ` title="Took ${formatWorkDuration(group.endedAt - group.startedAt)}"` : "";
  return `<details class="work-group" data-status="${escapeHtml(group.status)}" data-key="${escapeHtml(key)}"${open?.has(key) ? " open" : ""}><summary${took}><span class="work-label">${escapeHtml(group.label)}</span>${CHEVRON}</summary><div class="work-children">${children}</div></details>`;
}

// ---------------------------------------------------------------------------
// Items

function partHtml(transcript, item, part, index, open) {
  if (part.type === "text") return part.text.trim() ? `<div class="prose">${renderMarkdown(part.text)}</div>` : "";
  if (part.type === "thinking") {
    if (part.redacted) return rowHtml("", "done", '<span class="part-muted">Thinking (hidden by the provider)</span>', "");
    const body = part.text.trim() ? `<div class="thinking-text">${escapeHtml(part.text.trim())}</div>` : "";
    return rowHtml(`thinking:${item.id}:${index}`, "done", '<span class="part-muted">Thinking</span>', body, open);
  }
  if (part.type !== "tool") return "";
  const group = groupOf(transcript, part.toolCallId);
  if (!group) return toolHtml(part, open);
  // The group's first call draws the group; the others are drawn inside it.
  return group.id === part.toolCallId ? groupHtml(transcript, group, open) : undefined;
}

/** One part of an assistant item in its wrapper, or "" for a call drawn inside its group. */
export function partNodeHtml(transcript, item, index, open) {
  const part = item.parts[index];
  const html = partHtml(transcript, item, part, index, open);
  if (html === undefined) return "";
  return `<div class="part" data-part="${index}" data-kind="${escapeHtml(part.type)}">${html}</div>`;
}

/**
 * An item's markup. As in the terminal, an assistant message's text and
 * thinking come before its tool calls, which is where a run of calls ends.
 */
export function itemHtml(transcript, item, open) {
  if (item.type === "user") {
    const images = item.images > 0 ? `<div class="attachments">${item.images === 1 ? "1 image" : `${item.images} images`}</div>` : "";
    return `<div class="bubble">${escapeHtml(item.text)}</div>${images}`;
  }
  const indexes = item.parts.map((_part, index) => index);
  const order = [...indexes.filter((i) => item.parts[i].type !== "tool"), ...indexes.filter((i) => item.parts[i].type === "tool")];
  const parts = order.map((index) => partNodeHtml(transcript, item, index, open)).join("");
  const stopped = item.stopReason === "aborted" ? '<p class="msg-error">Interrupted</p>' : "";
  const error = item.error && item.stopReason !== "aborted" ? `<p class="msg-error">${escapeHtml(item.error)}</p>` : "";
  return parts + stopped + error;
}

// ---------------------------------------------------------------------------
// The work fold

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "45 seconds", "2 minutes", "1 hour 5 minutes": at least one second, minutes rounded down. */
export function formatWorkDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return plural(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? plural(hours, "hour") : `${plural(hours, "hour")} ${plural(minutes % 60, "minute")}`;
}

function visibleText(part) {
  return part.type === "text" && part.text.trim() !== "";
}

/**
 * The work folds of a transcript. A turn is a user message and the
 * assistant messages after it; once it has finished (a later turn exists,
 * or `busy` is false), the work before its final answer folds behind one
 * line. The final answer is the text of the turn's last message when that
 * message calls no tools. A turn whose work is one line on its own (one
 * group, one call, one note) keeps that line instead of a fold.
 *
 * Each fold names its first and last item, the items it covers, whether the
 * last item holds the final answer, and its label.
 */
export function planWorkFolds(transcript, busy) {
  const folds = [];
  const turns = [];
  let turn;
  for (const item of transcript.items.values()) {
    if (item.type === "user") {
      turn = { user: item, items: [] };
      turns.push(turn);
    } else {
      if (!turn) {
        turn = { user: undefined, items: [] };
        turns.push(turn);
      }
      turn.items.push(item);
    }
  }
  for (const [index, { user, items }] of turns.entries()) {
    if (items.length === 0 || (busy && index === turns.length - 1)) continue;
    const last = items.at(-1);
    const answer = !last.parts.some((part) => part.type === "tool") && last.parts.some(visibleText);
    let lines = 0;
    let ended = last.timestamp;
    for (const item of items) {
      for (const part of item.parts) {
        if (part.type === "tool") {
          const group = groupOf(transcript, part.toolCallId);
          if (!group || group.id === part.toolCallId) lines++;
          if (group?.endedAt !== undefined) ended = Math.max(ended, group.endedAt);
        } else if (part.type === "thinking" || (visibleText(part) && !(answer && item === last))) {
          lines++;
        }
      }
    }
    if (lines < 2) continue;
    const started = user?.timestamp ?? items[0].timestamp;
    const end = answer ? last.timestamp : ended;
    const label = Number.isFinite(end - started) ? `Worked for ${formatWorkDuration(end - started)}` : "Show the work";
    folds.push({ key: `work:${items[0].id}`, firstId: items[0].id, lastId: last.id, itemIds: items.map((item) => item.id), answer, label });
  }
  return folds;
}
