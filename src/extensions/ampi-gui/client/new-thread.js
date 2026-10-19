// The new-thread composer, in `ampi app` only: a card on the home page and
// at /new with a prompt, three pills (where it runs, its directory, its
// mode), an options menu with Labels, and a round send button whose menu
// (a long press, a right click or Down) offers the three ways to create:
//
// | Variant      | Key                                      | Then |
// | ------------ | ---------------------------------------- | ---- |
// | `open`       | Enter                                    | the new thread opens |
// | `background` | Mod+Shift+Enter                          | the prompt clears, a toast links the thread |
// | `another`    | Ctrl+Alt+Enter (⌃⌘Enter on macOS)        | a fresh composer: prompt, labels and mode reset, a toast links the thread |
//
// POST /api/threads starts the thread (hub.ts). The helpers before
// `mountNewThread` are pure, so tests load them in Node.

import { escapeHtml } from "./app-mode.js";
import { chordLabels } from "./keys.js";

/** The prompt's placeholder. */
export const NEW_THREAD_PLACEHOLDER = "What should the new thread do?";

/** How long a press on the send button opens its menu instead of creating. */
export const LONG_PRESS_MS = 500;

/** The ways to create, in the send menu's order; `keys` by platform where they differ. */
export const SUBMIT_VARIANTS = [
  { id: "open", label: "Create", keys: "enter" },
  { id: "background", label: "Create in Background", keys: "mod+shift+enter" },
  { id: "another", label: "Create and New Thread", keys: { mac: "meta+ctrl+enter", other: "ctrl+alt+enter" } },
];

/** A variant's key on this platform, in the chord grammar of keys.js. */
export function variantKeys(variant, mac = false) {
  return typeof variant.keys === "string" ? variant.keys : mac ? variant.keys.mac : variant.keys.other;
}

/**
 * Which variant a key press in the prompt creates, or `null` for typing as
 * usual (Shift+Enter is a new line; Enter while an input method composes
 * belongs to it).
 */
export function submitVariantFor(event, mac = false) {
  if (event.key !== "Enter" || event.isComposing) return null;
  const ctrl = Boolean(event.ctrlKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);
  const meta = Boolean(event.metaKey);
  if (!ctrl && !alt && !shift && !meta) return "open";
  const mod = mac ? meta && !ctrl : ctrl && !meta;
  if (mod && shift && !alt) return "background";
  if (!shift && (mac ? meta && ctrl && !alt : ctrl && alt && !meta)) return "another";
  return null;
}

/** The composer before and between creates. */
export const IDLE = Object.freeze({ phase: "idle", variant: null, error: null, effect: null });

/**
 * What the composer does once the hub answered `sessionId` for `variant`:
 * `open` the thread or not, `toast` a link to it or not, and which parts
 * of the card to `reset` (`prompt`, `labels`, `mode`, `from`).
 */
export function afterCreate(variant, sessionId) {
  const fresh = ["prompt", "labels", "mode", "from"];
  if (variant === "background") return { open: null, toast: sessionId, reset: ["prompt"] };
  if (variant === "another") return { open: null, toast: sessionId, reset: fresh };
  return { open: sessionId, toast: null, reset: fresh };
}

/**
 * The composer's next state: `submit` starts creating (a second submit
 * while one runs changes nothing), `failed` goes back with the error and
 * keeps the text, `created` goes back with the `effect` of {@link afterCreate}.
 */
export function newThreadTransition(state, event) {
  switch (event.type) {
    case "submit":
      return state.phase === "creating" ? { ...state, effect: null } : { phase: "creating", variant: event.variant, error: null, effect: null };
    case "failed":
      return { phase: "idle", variant: null, error: event.error, effect: null };
    case "created":
      return { phase: "idle", variant: null, error: null, effect: afterCreate(state.variant, event.sessionId) };
    default:
      return state;
  }
}

/** The `POST /api/threads` body, or the reason the composer cannot create yet. */
export function threadRequest({ prompt, cwd, mode, labels }) {
  if (prompt.trim() === "") return { error: "Write a prompt first." };
  if (!cwd) return { error: "Choose a directory first." };
  return { body: { prompt, cwd, ...(mode ? { mode } : {}), labels: [...labels] } };
}

/**
 * Insert a mention of thread `id` (`@<id> `, as the terminal's `@@` picker
 * inserts it) over the selection `start`…`end` of `text`, with a space
 * before it when it would touch a word. Answers the text and the caret.
 */
export function insertMention(text, start, end, id) {
  const before = text.slice(0, start);
  const mention = `${before === "" || /\s$/.test(before) ? "" : " "}@${id} `;
  return { text: `${before}${mention}${text.slice(end)}`, caret: before.length + mention.length };
}

/** "1 thread", "3 threads", "No threads". */
export function threadCount(count) {
  return count === 0 ? "No threads" : count === 1 ? "1 thread" : `${count} threads`;
}

const BRANCH = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="3.75" r="1.5"/><circle cx="5" cy="12.25" r="1.5"/><circle cx="11" cy="5.75" r="1.5"/><path d="M5 5.25v5.5M11 7.25c0 2.5-6 1.75-6 3.5"/></svg>';
const CHECK = '<svg class="icon mode-picker-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';

/**
 * One directory row as HTML; every text in it is escaped. A typed path
 * reads `Use <path>`; a listed one its name over its path, with its Git
 * branch and how many threads ran there.
 */
export function directoryOptionHtml(entry, index, { checked = false, typed = false } = {}) {
  const title = typed ? `Use ${entry.path}` : entry.label;
  const branch = entry.git ? `<span class="place-branch" title="Git branch">${BRANCH}${escapeHtml(entry.branch ?? "Git")}</span>` : "";
  return [
    `<div class="mode-picker-option place-option" role="option" id="place-option-${index}" data-index="${index}" aria-selected="false"${checked ? ' aria-current="true"' : ""}>`,
    `<span class="mode-picker-main"><span class="mode-picker-line"><span class="mode-picker-name">${escapeHtml(title)}</span></span>`,
    typed ? "" : `<span class="mode-picker-description">${escapeHtml(entry.path)}</span>`,
    "</span>",
    `<span class="place-meta">${branch}${typed ? "" : `<span>${threadCount(entry.sessions)}</span>`}</span>`,
    checked ? CHECK : "",
    "</div>",
  ].join("");
}

/** The executor row: this machine, by its host name. */
export function executorOptionHtml(hostname, index = 0) {
  return [
    `<div class="mode-picker-option place-option" role="option" id="place-option-${index}" data-index="${index}" aria-selected="false" aria-current="true">`,
    `<span class="mode-picker-main"><span class="mode-picker-line"><span class="mode-picker-name">This machine</span></span>`,
    `<span class="mode-picker-description">${escapeHtml(hostname || "localhost")}</span></span>`,
    CHECK,
    "</div>",
  ].join("");
}

// ---------------------------------------------------------------------------
// The page

/**
 * The executor and directory pickers share one popover under their pill:
 * a field, a key chip and a list. `open(anchor, view)` takes `{ label,
 * placeholder, key, load(query) → Promise<{ sections: [{ label, rows:
 * [{ html, value }] }], empty }>, choose(value) }`; typing loads again,
 * Up and Down move, Enter or a click chooses, Esc or a click outside closes.
 */
function mountPlacePicker(dialog, mac) {
  const input = dialog.querySelector(".mode-picker-input");
  const list = dialog.querySelector(".mode-picker-list");
  const empty = dialog.querySelector(".mode-picker-empty");
  const key = dialog.querySelector(".mode-picker-key");
  let view = null;
  let values = [];
  let active = -1;
  let returnFocus = null;
  let loads = 0;

  function setActive(index) {
    active = index;
    for (const node of list.querySelectorAll('[role="option"]')) node.setAttribute("aria-selected", String(node.id === `place-option-${index}`));
    const node = index >= 0 ? dialog.querySelector(`#place-option-${index}`) : null;
    if (node) {
      input.setAttribute("aria-activedescendant", node.id);
      node.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  async function load() {
    const turn = ++loads;
    const answer = await view.load(input.value);
    // A later keystroke's answer wins.
    if (turn !== loads || !dialog.open) return;
    values = [];
    const html = [];
    for (const section of answer.sections) {
      if (section.rows.length === 0) continue;
      if (section.label) html.push(`<div class="mode-picker-section" role="presentation">${escapeHtml(section.label)}</div>`);
      for (const row of section.rows) {
        html.push(row.html);
        values.push(row.value);
      }
    }
    list.innerHTML = html.join("");
    empty.textContent = answer.empty;
    empty.hidden = values.length > 0;
    const current = [...list.querySelectorAll('[role="option"]')].findIndex((node) => node.getAttribute("aria-current") === "true");
    setActive(values.length === 0 ? -1 : input.value.trim() === "" ? Math.max(0, current) : 0);
  }

  function close() {
    const back = returnFocus;
    returnFocus = null;
    if (dialog.open) dialog.close();
    back?.focus?.({ preventScroll: true });
  }

  function choose(index) {
    if (index < 0 || index >= values.length) return;
    const value = values[index];
    const chosen = view;
    close();
    chosen.choose(value);
  }

  function place(anchor) {
    const box = anchor?.getBoundingClientRect?.();
    if (!box || window.innerWidth < 768) {
      dialog.style.left = "";
      dialog.style.top = "";
      return;
    }
    const width = dialog.offsetWidth;
    dialog.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
    dialog.style.top = `${box.bottom + 6}px`;
  }

  input.addEventListener("input", () => load());
  dialog.addEventListener("keydown", (event) => {
    if (event.isComposing || event.target !== input) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (values.length > 0) setActive(Math.max(0, Math.min(values.length - 1, active + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Tab") event.preventDefault();
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest?.('[role="option"]');
    if (option) choose(Number(option.dataset.index));
  });
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
    open(anchor, next) {
      if (dialog.open) {
        const same = view?.label === next.label;
        close();
        if (same) return;
      }
      returnFocus = document.activeElement;
      view = next;
      dialog.setAttribute("aria-label", next.label);
      input.setAttribute("aria-label", next.label);
      input.placeholder = next.placeholder;
      key.textContent = chordLabels(next.key, { mac }).join(" ");
      input.value = "";
      list.replaceChildren();
      empty.textContent = "Loading…";
      empty.hidden = false;
      dialog.showModal();
      place(anchor);
      input.focus();
      load();
    },
    close,
  };
}

/** Wire a menu of buttons (`[role=menuitem]`) to the button that opens it: arrows move, Esc and a click outside close. */
function mountMenu(menu, opener, onChoose) {
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
  const isOpen = () => !menu.hidden;
  function close({ focus = true } = {}) {
    if (!isOpen()) return;
    menu.hidden = true;
    opener.setAttribute("aria-expanded", "false");
    if (focus) opener.focus({ preventScroll: true });
  }
  function open() {
    menu.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    items()[0]?.focus();
  }
  menu.addEventListener("keydown", (event) => {
    const list = items();
    const index = list.indexOf(document.activeElement);
    const delta = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (delta) {
      event.preventDefault();
      list[(index + delta + list.length) % list.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") close({ focus: false });
  });
  menu.addEventListener("click", (event) => {
    const item = event.target.closest?.('[role="menuitem"]');
    if (!item) return;
    close();
    onChoose(item.dataset.value);
  });
  document.addEventListener("pointerdown", (event) => {
    if (isOpen() && !menu.contains(event.target) && !opener.contains(event.target)) close({ focus: false });
  });
  return { open, close, isOpen, toggle: () => (isOpen() ? close() : open()) };
}

function keyChips(keys, mac) {
  return chordLabels(keys, { mac })
    .map((chip) => `<kbd>${escapeHtml(chip)}</kbd>`)
    .join("");
}

/**
 * Wire the composer in `root` (`#new-thread`). `post(url, body)` resolves
 * `{ ok, status, body }`; `getJson(url)` resolves a JSON answer or
 * `undefined`; `openThread(id)` shows a thread; `threadHref(id)` is its
 * address; `close(from)` leaves the composer for the thread it was opened
 * from; `forgetOrigin()` drops that thread from the page's history entry;
 * `modePicker` is the page's (mode-picker.js); `editLabels(session, from,
 * save)` the More Actions labels editor.
 */
export function mountNewThread({ root, pickerDialog, modePicker, editLabels, post, getJson, notify, openThread, threadHref, close, forgetOrigin, mac = false }) {
  const $ = (selector) => root.querySelector(selector);
  const field = $("#new-thread-prompt");
  const closeButton = $("#new-thread-close");
  const insertButton = $("#new-thread-insert");
  const notice = $("#new-thread-notice");
  const errorLine = $("#new-thread-error");
  const executorPill = $("#pill-executor");
  const directoryPill = $("#pill-directory");
  const modePill = $("#pill-mode");
  const labelList = $("#new-thread-labels");
  const optionsButton = $("#new-thread-options");
  const submit = $("#new-thread-submit");
  const sendMenuNode = $("#new-thread-send-menu");
  const picker = mountPlacePicker(pickerDialog, mac);

  let state = IDLE;
  let hostname = "";
  /** The thread the composer was opened from: `{ id, cwd }`, or `null`. */
  let from = null;
  /** The chosen directory: `{ path, label }`, or `null` until one is known. */
  let directory = null;
  /** The chosen mode key, and the modes answer it is described by. */
  let mode = null;
  let modes = null;
  let labels = [];

  field.placeholder = NEW_THREAD_PLACEHOLDER;
  insertButton.querySelector("kbd").textContent = chordLabels("ctrl+i", { mac }).join(" ");
  $("#new-thread-labels-keys").innerHTML = keyChips("ctrl+l", mac);
  for (const variant of SUBMIT_VARIANTS) {
    sendMenuNode.querySelector(`[data-value="${variant.id}"] .menu-keys`).innerHTML = keyChips(variantKeys(variant, mac), mac);
  }

  function say(text) {
    notice.textContent = text;
    notice.hidden = text === "";
  }

  function drawPills() {
    executorPill.title = `Runs on this machine${hostname ? ` (${hostname})` : ""} · ${chordLabels("ctrl+m", { mac })[0]}`;
    $("#pill-directory-label").textContent = directory?.label ?? "Choose a directory";
    directoryPill.title = `${directory?.path ?? "No directory chosen"} · ${chordLabels("ctrl+j", { mac })[0]}`;
    const row = modes?.modes.find((candidate) => candidate.key === mode);
    $("#pill-mode-label").textContent = row?.label ?? mode ?? "Mode";
    modePill.dataset.ampiMode = mode ?? "";
    if (row?.color) modePill.style.setProperty("--ampi-mode-tint", row.color);
    else modePill.style.removeProperty("--ampi-mode-tint");
    modePill.title = `Mode ${row?.label ?? mode ?? ""} · ${chordLabels("ctrl+s", { mac })[0]}`;
    modePill.setAttribute("aria-label", `Mode: ${row?.label ?? mode ?? "default"}`);
    directoryPill.setAttribute("aria-label", `Directory: ${directory?.path ?? "none chosen"}`);
    labelList.replaceChildren(
      ...labels.map((label) => {
        const item = document.createElement("li");
        item.className = "label-chip";
        item.textContent = label;
        return item;
      }),
    );
    labelList.hidden = labels.length === 0;
    $("#new-thread-labels-detail").textContent = labels.length > 0 ? String(labels.length) : "";
  }

  function drawSubmit() {
    const creating = state.phase === "creating";
    submit.dataset.state = creating ? "creating" : "idle";
    submit.dataset.empty = String(!creating && field.value.trim() === "");
    submit.setAttribute("aria-busy", String(creating));
    const label = creating ? "Creating…" : `Create thread (${chordLabels("enter", { mac })[0]})`;
    submit.setAttribute("aria-label", label);
    submit.title = creating ? label : `${label}. Hold or right-click for more ways to create.`;
    $("#new-thread-submit-text").textContent = creating ? "Creating…" : "";
    errorLine.textContent = state.error ?? "";
    errorLine.hidden = !state.error;
  }

  function grow() {
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 320)}px`;
  }

  async function loadModes() {
    const answer = await getJson("/api/modes");
    if (!answer) return;
    modes = answer;
    if (mode === null) mode = answer.current ?? null;
    drawPills();
  }

  /** The directories, most recent first, and the path typed in `query` when it names an unlisted directory. */
  async function directories(query = "") {
    return (await getJson(`/api/directories?q=${encodeURIComponent(query)}`)) ?? { directories: [], typed: null };
  }

  async function defaultDirectory() {
    if (directory) return;
    const first = (await directories()).directories[0];
    if (first && !directory) {
      directory = { path: first.path, label: first.label };
      drawPills();
    }
  }

  function reset(parts) {
    if (parts.includes("prompt")) {
      field.value = "";
      grow();
    }
    if (parts.includes("labels")) labels = [];
    if (parts.includes("mode")) mode = modes?.current ?? null;
    if (parts.includes("from") && from) {
      from = null;
      insertButton.hidden = true;
      forgetOrigin();
    }
    drawPills();
    drawSubmit();
  }

  async function create(variant) {
    if (state.phase === "creating") return;
    const request = threadRequest({ prompt: field.value, cwd: directory?.path, mode, labels });
    if (request.error) {
      state = newThreadTransition(state, { type: "failed", error: request.error });
      drawSubmit();
      if (!directory && field.value.trim() !== "") openDirectory();
      return;
    }
    state = newThreadTransition(state, { type: "submit", variant });
    drawSubmit();
    const result = await post("/api/threads", request.body);
    if (!result.ok) {
      state = newThreadTransition(state, { type: "failed", error: result.body?.error ?? "Could not start the thread." });
      drawSubmit();
      return;
    }
    state = newThreadTransition(state, { type: "created", sessionId: result.body.sessionId });
    const { effect } = state;
    reset(effect.reset);
    if (result.body.warning) notify(result.body.warning, "warning");
    if (effect.open) return openThread(effect.open);
    notify("Started a new thread.", "info", { label: "Open it", href: threadHref(effect.toast), open: () => openThread(effect.toast) });
    field.focus();
  }

  function openExecutor() {
    picker.open(executorPill, {
      label: "Where the thread runs",
      placeholder: "Run on…",
      key: "ctrl+m",
      load: async () => ({ sections: [{ label: "", rows: [{ html: executorOptionHtml(hostname), value: "local" }] }], empty: "No other machine is set up." }),
      choose: () => field.focus(),
    });
  }

  function openDirectory() {
    picker.open(directoryPill, {
      label: "Directory",
      placeholder: "Find a directory, or type a path…",
      key: "ctrl+j",
      async load(query) {
        const answer = await directories(query);
        let index = 0;
        const row = (entry, typed = false) => ({ html: directoryOptionHtml(entry, index++, { typed, checked: !typed && entry.path === directory?.path }), value: entry });
        const typed = answer.typed ? [row(answer.typed, true)] : [];
        return {
          sections: [
            { label: "Path", rows: typed },
            { label: "Directories", rows: answer.directories.map((entry) => row(entry)) },
          ],
          empty: query.trim() === "" ? "No session has run anywhere yet. Type the path of a directory." : "No directory matches. Type an absolute path or one starting with ~.",
        };
      },
      choose(entry) {
        directory = { path: entry.path, label: entry.label };
        drawPills();
        field.focus();
      },
    });
  }

  function openMode() {
    modePicker.open(
      modePill,
      {
        async load() {
          const answer = await getJson("/api/modes");
          if (!answer) return { ok: false, body: { error: "Could not read the modes." } };
          modes = answer;
          return { ok: true, body: { ...answer, current: mode } };
        },
        async change(route, body) {
          if (route !== "mode") return { ok: false, body: { error: "A new thread starts in a mode; choose its model in the thread." } };
          mode = body.mode;
          drawPills();
          return { ok: true, body: { mode } };
        },
        busy: () => null,
      },
      { only: "modes" },
    );
  }

  function openLabels() {
    editLabels({ id: "", title: "New thread", labels }, optionsButton, (next) => {
      labels = [...next];
      drawPills();
    });
  }

  function insertThread() {
    if (!from) return;
    const next = insertMention(field.value, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, from.id);
    field.value = next.text;
    field.focus();
    field.setSelectionRange(next.caret, next.caret);
    grow();
    drawSubmit();
  }

  const optionsMenu = mountMenu($("#new-thread-menu"), optionsButton, (value) => {
    if (value === "labels") openLabels();
  });
  const sendMenu = mountMenu(sendMenuNode, submit, (value) => create(value));

  field.addEventListener("keydown", (event) => {
    const variant = submitVariantFor(event, mac);
    if (!variant) return;
    event.preventDefault();
    create(variant);
  });
  field.addEventListener("input", () => {
    grow();
    if (state.error) state = { ...state, error: null };
    drawSubmit();
  });
  closeButton.addEventListener("click", () => {
    if (from) return close(from.id);
    reset(["prompt", "labels"]);
    say("");
    field.focus();
  });
  insertButton.addEventListener("click", insertThread);
  $("#new-thread-attach").addEventListener("click", () => say("Attachments are not supported in the web GUI yet."));
  executorPill.addEventListener("click", openExecutor);
  directoryPill.addEventListener("click", openDirectory);
  modePill.addEventListener("click", openMode);
  optionsButton.addEventListener("click", () => optionsMenu.toggle());

  // A long press, a right click, or Down on the send button opens its menu; a short press creates.
  let pressTimer = 0;
  let pressed = false;
  const endPress = () => clearTimeout(pressTimer);
  submit.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pressed = false;
    pressTimer = setTimeout(() => {
      pressed = true;
      sendMenu.open();
    }, LONG_PRESS_MS);
  });
  for (const name of ["pointerup", "pointerleave", "pointercancel"]) submit.addEventListener(name, endPress);
  submit.addEventListener("click", () => {
    if (pressed) {
      pressed = false;
      return;
    }
    if (!sendMenu.isOpen()) create("open");
  });
  submit.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    endPress();
    sendMenu.open();
  });
  submit.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      sendMenu.open();
    }
  });

  drawPills();
  drawSubmit();
  return {
    /**
     * Show the composer: `from` is the thread it was opened from (`{ id, cwd }`)
     * or `null`, `text` a prompt to start with. The directory defaults to
     * that thread's, else to the most recently used one.
     */
    show({ from: origin = null, text, host } = {}) {
      if (host !== undefined) hostname = host;
      // Opened from another thread: its directory; shown again for the same one, the choice stays.
      const moved = (origin?.id ?? null) !== (from?.id ?? null);
      from = origin;
      insertButton.hidden = !from;
      if (moved && from?.cwd) directory = { path: from.cwd, label: from.cwd.split(/[\\/]/).filter(Boolean).pop() ?? from.cwd };
      if (typeof text === "string" && text !== "") {
        field.value = text;
        grow();
      }
      say("");
      drawPills();
      drawSubmit();
      if (!modes) loadModes();
      defaultDirectory();
      field.focus({ preventScroll: true });
    },
    /** The thread the composer was opened from, or `null`. */
    fromId: () => from?.id ?? null,
    /** A composer key (commands.js `new-thread-*`): `executor`, `directory`, `mode`, `labels` or `insert`. */
    control(kind) {
      ({ executor: openExecutor, directory: openDirectory, mode: openMode, labels: openLabels, insert: insertThread })[kind]?.();
    },
  };
}
