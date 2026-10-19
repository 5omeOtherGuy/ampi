// The mode picker: a popover under the title bar's mode button (and, later,
// the new-thread composer's mode pill) that lists ampi's modes and Pi's
// models. A search field filters the list; Tab switches between the Modes
// and Models tabs; Up and Down move, Enter chooses, Esc closes. It reads
// GET /api/modes each time it opens and changes the session through
// POST /api/mode, /api/model and /api/fast (modes.ts on the server).
//
// While a turn runs every row is read-only. Once the session's mode is
// locked the rows are read-only too, and Change anyway lifts that for the
// next choice, which then overrides the lock as /mode does in the terminal.
// Choosing a model leaves a locked mode for free, as Pi's own /model does.
// The helpers before `mountModePicker` are pure, so tests load them in Node.

import { escapeHtml } from "./app-mode.js";
import { chordLabels } from "./keys.js";

export const PICKER_TABS = ["modes", "models"];

const TAB_TEXT = {
  modes: { placeholder: "Choose a mode…", list: "Modes", empty: "No mode matches." },
  models: { placeholder: "Choose a model…", list: "Models", empty: "No model matches. Pi lists the models it has credentials for." },
};

/** Whether every word of `query` occurs in one of `fields`, ignoring case. */
function matches(query, fields) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = fields.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * The Modes tab's rows for a GET /api/modes answer, in its order (built-in
 * modes, registered ones, then free), filtered by `query`. Each is the
 * answer's row plus `current`.
 */
export function modeRows(data, query = "") {
  return (data?.modes ?? [])
    .filter((mode) => matches(query, [mode.key, mode.label, mode.description, mode.agentModel?.name, mode.oracleModel?.name]))
    .map((mode) => ({ ...mode, current: mode.key === data.current }));
}

/**
 * The Models tab: `[{ provider, rows }]`, providers in the order the
 * registry lists them, each row `{ provider, id, name, current }`.
 */
export function modelGroups(data, query = "") {
  const groups = new Map();
  for (const model of data?.models ?? []) {
    if (!matches(query, [model.name, model.id, model.provider])) continue;
    const rows = groups.get(model.provider) ?? [];
    rows.push({ ...model, current: data.model === `${model.provider}/${model.id}` });
    groups.set(model.provider, rows);
  }
  return [...groups].map(([provider, rows]) => ({ provider, rows }));
}

/**
 * What the notice under the header says, or `null`: `{ kind, text, action }`.
 * `kind` is `busy`, `locked` (with Change anyway as `action`), `override`
 * after it, or `free` on the Models tab while a mode other than free runs.
 */
export function pickerNotice(data, { tab = "modes", busy = null, override = false } = {}) {
  if (!data) return null;
  if (busy) return { kind: "busy", text: busy, action: null };
  const leavesMode = tab === "modes" || (data.current !== null && data.current !== "free");
  if (data.locked && leavesMode && !override) {
    const reason = data.lockReason ? `${data.lockReason[0].toUpperCase()}${data.lockReason.slice(1).replace(/\.?$/, ".")}` : "The mode is locked.";
    return { kind: "locked", text: reason, action: "Change anyway" };
  }
  if (data.locked && leavesMode) {
    return { kind: "override", text: `Your next choice overrides the lock, as ${tab === "modes" ? "/mode" : "/model"} does in the terminal.`, action: null };
  }
  if (tab === "models" && data.current !== null && data.current !== "free") {
    return { kind: "free", text: `Choosing a model switches this session from ${data.current} to free: ampi's routing, mode prompt and tool rules stop until you choose a mode again.`, action: null };
  }
  return null;
}

/** Whether the rows of `tab` can be chosen now (see pickerNotice). */
export function rowsWritable(data, options = {}) {
  const notice = pickerNotice(data, options);
  return notice?.kind !== "busy" && notice?.kind !== "locked";
}

/** A model as the chip and the title name it: `name`, and `provider/id · thinking`. */
function routeTitle(label, model) {
  if (!model) return `${label}: none`;
  return `${label}: ${model.provider}/${model.id}${model.thinkingLevel ? ` · ${model.thinkingLevel}` : ""}`;
}

const CHECK = '<svg class="icon mode-picker-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';

/** One Modes row as HTML; every text in it is escaped. `readOnly` marks it aria-disabled. */
export function modeOptionHtml(row, index, { readOnly = false } = {}) {
  const disabled = readOnly || !row.available;
  const models = [row.agentModel?.name, row.oracleModel?.name].filter(Boolean);
  const chip = row.agentModel
    ? `<span class="mode-picker-chip" title="${escapeHtml(`${routeTitle("Agent", row.agentModel)}\n${routeTitle("Oracle", row.oracleModel)}`)}">${models.map(escapeHtml).join(" · ")}</span>`
    : "";
  const note = row.available ? row.description : (row.reason ?? row.description);
  return [
    `<div class="mode-picker-option" role="option" id="mode-picker-option-${index}" data-index="${index}" data-kind="mode" data-ampi-mode="${escapeHtml(row.key)}"`,
    ` aria-selected="false"${disabled ? ' aria-disabled="true"' : ""}${row.current ? ' aria-current="true"' : ""}>`,
    `<span class="mode-picker-main"><span class="mode-picker-line"><span class="mode-picker-name">${escapeHtml(row.label)}</span>${chip}</span>`,
    `<span class="mode-picker-description">${escapeHtml(note)}</span></span>`,
    row.current ? CHECK : "",
    "</div>",
  ].join("");
}

/** One Models row as HTML; every text in it is escaped. */
export function modelOptionHtml(row, index, { readOnly = false } = {}) {
  return [
    `<div class="mode-picker-option" role="option" id="mode-picker-option-${index}" data-index="${index}" data-kind="model"`,
    ` aria-selected="false"${readOnly ? ' aria-disabled="true"' : ""}${row.current ? ' aria-current="true"' : ""}>`,
    `<span class="mode-picker-main"><span class="mode-picker-line"><span class="mode-picker-name">${escapeHtml(row.name)}</span></span>`,
    `<span class="mode-picker-description">${escapeHtml(`${row.provider}/${row.id}`)}</span></span>`,
    row.current ? CHECK : "",
    "</div>",
  ].join("");
}

/** The Fast row: fast speed on or off, with why it cannot be turned on. */
export function fastOptionHtml(fast, index) {
  const note = fast.available ? "Ask the provider for priority serving: answers sooner, costs more" : (fast.reason ?? "Not available now");
  return [
    `<div class="mode-picker-option mode-picker-fast" role="option" id="mode-picker-option-${index}" data-index="${index}" data-kind="fast"`,
    ` aria-selected="false"${fast.available ? "" : ' aria-disabled="true"'}>`,
    `<span class="mode-picker-main"><span class="mode-picker-line"><span class="mode-picker-name">Fast</span></span>`,
    `<span class="mode-picker-description">${escapeHtml(note)}</span></span>`,
    `<span class="mode-picker-state" data-on="${fast.on}">${fast.on ? "On" : "Off"}</span>`,
    "</div>",
  ].join("");
}

// ---------------------------------------------------------------------------
// The page

/**
 * Wire the picker to its dialog. `notify(text)` shows a toast. `open(anchor,
 * source)` reads and changes the modes through `source`:
 * `{ load(): Promise<{ ok, body }>, change(route, body): Promise<{ ok, body }>, busy(): string | null }`.
 */
export function mountModePicker({ dialog, notify, mac = false }) {
  const input = dialog.querySelector(".mode-picker-input");
  const list = dialog.querySelector(".mode-picker-list");
  const empty = dialog.querySelector(".mode-picker-empty");
  const notice = dialog.querySelector(".mode-picker-notice");
  const noticeText = dialog.querySelector(".mode-picker-notice-text");
  const overrideButton = dialog.querySelector(".mode-picker-override");
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  dialog.querySelector(".mode-picker-key").textContent = chordLabels("ctrl+s", { mac }).join(" ");

  let source = null;
  let data = null;
  let tab = "modes";
  let override = false;
  let rows = [];
  let active = -1;
  let returnFocus = null;
  let pointer = null;
  let working = false;

  const options = () => ({ tab, busy: source?.busy() ?? null, override });

  function setActive(index) {
    active = index;
    for (const node of list.querySelectorAll('[role="option"]')) node.setAttribute("aria-selected", String(node.id === `mode-picker-option-${index}`));
    const node = index >= 0 ? dialog.querySelector(`#mode-picker-option-${index}`) : null;
    if (node) {
      input.setAttribute("aria-activedescendant", node.id);
      node.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function drawNotice() {
    const shown = pickerNotice(data, options());
    notice.hidden = !shown;
    notice.dataset.kind = shown?.kind ?? "";
    noticeText.textContent = shown?.text ?? "";
    overrideButton.hidden = !shown?.action;
  }

  function draw() {
    for (const button of tabs) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    input.placeholder = TAB_TEXT[tab].placeholder;
    list.setAttribute("aria-label", TAB_TEXT[tab].list);
    drawNotice();
    if (!data) {
      list.replaceChildren();
      rows = [];
      empty.hidden = false;
      setActive(-1);
      return;
    }
    const readOnly = !rowsWritable(data, options());
    const html = [];
    rows = [];
    if (tab === "modes") {
      for (const row of modeRows(data, input.value)) {
        html.push(modeOptionHtml(row, rows.length, { readOnly }));
        rows.push({ kind: "mode", row, enabled: !readOnly && row.available });
      }
      if (data.fast && input.value.trim() === "") {
        html.push(fastOptionHtml(data.fast, rows.length));
        rows.push({ kind: "fast", row: data.fast, enabled: data.fast.available });
      }
    } else {
      for (const group of modelGroups(data, input.value)) {
        html.push(`<div class="mode-picker-section" role="presentation">${escapeHtml(group.provider)}</div>`);
        for (const row of group.rows) {
          html.push(modelOptionHtml(row, rows.length, { readOnly }));
          rows.push({ kind: "model", row, enabled: !readOnly });
        }
      }
    }
    list.innerHTML = html.join("");
    // A registered mode's colour: set through the CSSOM, which the page's style policy allows.
    for (const node of list.querySelectorAll('[data-kind="mode"]')) {
      const color = rows[Number(node.dataset.index)]?.row.color;
      if (color) node.style.setProperty("--ampi-mode-tint", color);
    }
    list.parentElement.scrollTop = 0;
    empty.textContent = TAB_TEXT[tab].empty;
    empty.hidden = rows.length > 0;
    const current = rows.findIndex((entry) => entry.row.current);
    setActive(rows.length === 0 ? -1 : Math.max(0, input.value.trim() === "" ? current : 0));
  }

  function place(anchor) {
    // Under the anchor, its right edges lined up, inside the window; a phone shows it as a sheet (CSS).
    const box = anchor?.getBoundingClientRect?.();
    if (!box || window.innerWidth < 768) {
      dialog.style.left = "";
      dialog.style.top = "";
      return;
    }
    const width = dialog.offsetWidth;
    dialog.style.left = `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`;
    dialog.style.top = `${box.bottom + 6}px`;
  }

  async function load() {
    data = null;
    empty.textContent = "Loading…";
    draw();
    const result = await source.load();
    if (!dialog.open) return;
    if (!result.ok) {
      empty.textContent = result.body?.error ?? "Could not read the modes.";
      return;
    }
    data = result.body;
    draw();
  }

  function close() {
    const back = returnFocus;
    returnFocus = null;
    if (dialog.open) dialog.close();
    back?.focus?.({ preventScroll: true });
  }

  function showError(text) {
    notice.hidden = false;
    notice.dataset.kind = "error";
    noticeText.textContent = text;
    overrideButton.hidden = true;
  }

  async function change(route, body, done) {
    working = true;
    const result = await source.change(route, override ? { ...body, override: true } : body);
    working = false;
    if (!result.ok) {
      showError(result.body?.error ?? "Pi did not take that.");
      return;
    }
    close();
    done?.(result.body);
  }

  function choose(index) {
    const entry = rows[index];
    if (!entry || working) return;
    if (!entry.enabled) {
      // A locked row: Change anyway is one key away.
      if (!overrideButton.hidden) overrideButton.focus();
      return;
    }
    if (entry.kind === "fast") {
      change("fast", {}, (body) => notify(body.fast ? "Fast speed on" : "Fast speed off"));
      return;
    }
    if (entry.row.current) return close();
    if (entry.kind === "mode") {
      change("mode", { mode: entry.row.key });
      return;
    }
    const before = data.current;
    change("model", { provider: entry.row.provider, id: entry.row.id }, (body) => {
      const left = before && before !== "free" && body.mode === "free";
      notify(left ? `${entry.row.name} selected. This session now runs in free mode.` : `${entry.row.name} selected.`);
    });
  }

  function switchTab(next) {
    tab = next;
    input.value = "";
    draw();
  }

  input.addEventListener("input", draw);
  dialog.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Tab" && event.target === input) {
      event.preventDefault();
      switchTab(PICKER_TABS[(PICKER_TABS.indexOf(tab) + 1) % PICKER_TABS.length]);
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && event.target === input) {
      event.preventDefault();
      if (rows.length > 0) setActive(Math.max(0, Math.min(rows.length - 1, active + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter" && event.target === input) {
      event.preventDefault();
      choose(active);
    }
  });
  for (const button of tabs) {
    button.addEventListener("click", () => {
      switchTab(button.dataset.tab);
      input.focus();
    });
  }
  overrideButton.addEventListener("click", () => {
    override = true;
    draw();
    input.focus();
  });
  list.addEventListener("pointermove", (event) => {
    // Only a real move picks a row, not the rows shifting under a resting pointer.
    const at = `${event.screenX},${event.screenY}`;
    const moved = pointer !== null && pointer !== at;
    pointer = at;
    const option = moved && event.target.closest?.('[role="option"]');
    if (option) setActive(Number(option.dataset.index));
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest?.('[role="option"]');
    if (!option) return;
    setActive(Number(option.dataset.index));
    choose(Number(option.dataset.index));
  });
  // A click outside the card closes it.
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });

  return {
    /** Open under `anchor` on `initialTab`, reading and changing the modes through `next`; open already, close it. */
    open(anchor, next, { initialTab = "modes" } = {}) {
      if (dialog.open) return close();
      returnFocus = document.activeElement;
      source = next;
      tab = initialTab;
      override = false;
      pointer = null;
      input.value = "";
      dialog.showModal();
      place(anchor);
      input.focus();
      load();
    },
    close,
    isOpen: () => dialog.open,
    /** The session's status changed: redraw which rows can be chosen. */
    refresh() {
      if (dialog.open && data && !working) draw();
    },
  };
}
