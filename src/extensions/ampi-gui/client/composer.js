// The composer: the text area under the transcript, its send and stop
// button, and the queued messages above it. The helpers at the top are pure,
// so tests run them without a browser; `mountComposer` wires them to the page.

/** Window for the second Escape of Esc Esc, as for the terminal's key chords. */
export const ESCAPE_CHORD_MS = 1500;

/**
 * What a key press in the text area does: `send` (Enter), `queue`
 * (Ctrl+Enter, or ⌘+Enter), `escape`, or `null` for typing as usual
 * (Shift+Enter is a line break; Enter while an input method composes
 * belongs to it).
 */
export function composerKeyAction(event) {
  if (event.key === "Escape") return "escape";
  if (event.key !== "Enter" || event.isComposing || event.shiftKey || event.altKey) return null;
  return event.ctrlKey || event.metaKey ? "queue" : "send";
}

/** Counts Escape presses: `press()` is true for the second one within `windowMs` of the first. */
export function createEscapeChord(now = () => Date.now(), windowMs = ESCAPE_CHORD_MS) {
  let first;
  return {
    press() {
      const at = now();
      if (first !== undefined && at - first <= windowMs) {
        first = undefined;
        return true;
      }
      first = at;
      return false;
    },
    reset() {
      first = undefined;
    },
  };
}

/**
 * Whether a key press counts toward Esc Esc: an Escape nothing else took,
 * while the live session's turn runs and its composer can be used. An Escape
 * that closes a dialog, and any Escape while another session or the sidebar
 * sheet covers the composer, does not count.
 */
export function escapeCounts(event, { busy, usable }) {
  return event.key === "Escape" && !event.defaultPrevented && busy && usable && !event.target?.closest?.("dialog[open]");
}

/**
 * The `/api/send` body for `text`: a new prompt when idle; while a turn runs,
 * a steering message, or a follow-up for `queue`. `null` when there is
 * nothing to send.
 */
export function sendBody(text, queue) {
  return text.trim() === "" ? null : { text, deliverAs: queue ? "followUp" : "steer" };
}

/**
 * The queued messages as bubbles, steering ones first. Only the next
 * follow-up can be sent to steer now, as in the terminal.
 */
export function queueEntries(queue) {
  if (!queue) return [];
  return [
    ...queue.steering.map((text, index) => ({ kind: "steering", index, text, label: "Steering", canSteer: false })),
    ...queue.followUp.map((text, index) => ({ kind: "followUp", index, text, label: "Queued", canSteer: index === 0 })),
  ];
}

/** The round button: stop while a turn runs and nothing is typed, send otherwise. */
export function submitState({ busy, text, connected }) {
  if (busy && text.trim() === "") return { mode: "stop", label: "Interrupt (Esc Esc)", disabled: !connected };
  const label = busy ? "Send to steer (Enter)" : "Send (Enter)";
  return { mode: "send", label, disabled: !connected || text.trim() === "" };
}

/** The text area's placeholder, which names the keys while a turn runs. */
export function placeholderFor(busy, mac) {
  if (!busy) return "Write a message";
  return `Enter steers, ${mac ? "⌘" : "Ctrl"}+Enter queues, Esc Esc interrupts`;
}

// ---------------------------------------------------------------------------
// The page

const ICONS = {
  delete: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  edit: '<path d="M10.5 2.75 13.25 5.5 6 12.75H3.25V10z"/>',
  steer: '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
}

/**
 * Wire the composer. `post(route, body)` resolves `{ ok, body }`; the
 * returned object takes the session's status and queue as they change.
 */
export function mountComposer({ root, post, mac = false, now }) {
  const field = root.querySelector("#prompt");
  const submit = root.querySelector("#submit");
  const queueList = root.querySelector("#queue");
  const notice = root.querySelector("#composer-notice");
  const approval = root.querySelector("#approval-note");
  const attach = root.querySelector("#attach");
  const chord = createEscapeChord(now);
  let busy = false;
  let queued = 0;
  let connected = false;
  /** False while the page shows another session read-only. */
  let enabled = true;
  /** Sends run one after another, in the order they were typed. */
  let sends = Promise.resolve();

  function showNotice(text) {
    notice.textContent = text;
    notice.hidden = text === "";
  }

  function refresh() {
    const state = submitState({ busy, text: field.value, connected });
    submit.dataset.mode = state.mode;
    submit.setAttribute("aria-label", state.label);
    submit.title = state.label;
    submit.disabled = state.disabled;
    field.placeholder = placeholderFor(busy, mac);
  }

  function grow() {
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 240)}px`;
  }

  async function run(route, body) {
    const result = await post(route, body);
    if (!result.ok) showNotice(result.body?.error ?? "Pi did not take that.");
    else showNotice("");
    return result;
  }

  function sendTyped(queue) {
    const body = sendBody(field.value, queue);
    if (!body || !connected) return;
    field.value = "";
    grow();
    refresh();
    sends = sends.then(async () => {
      const result = await run("send", body);
      // Put the text back when Pi refused it, unless the user typed something new.
      if (result.ok || field.value !== "") return;
      field.value = body.text;
      grow();
      refresh();
    });
  }

  async function interrupt() {
    if (!busy) return;
    const waiting = queued;
    const result = await run("interrupt", {});
    // Pi hands what was still queued back to the terminal's prompt, as on the terminal's own Esc Esc.
    if (result.ok && waiting > 0) showNotice("Interrupted. The queued messages went back into the terminal's prompt.");
  }

  field.addEventListener("keydown", (event) => {
    const action = composerKeyAction(event);
    if (action === "send" || action === "queue") {
      event.preventDefault();
      sendTyped(action === "queue");
    }
  });
  field.addEventListener("input", () => {
    grow();
    refresh();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // The sidebar sheet makes the page around the composer inert.
    if (!escapeCounts(event, { busy, usable: enabled && !root.closest("[inert]") })) {
      chord.reset();
      return;
    }
    if (chord.press()) {
      showNotice("");
      interrupt();
    } else {
      const hint = "Press Esc again to interrupt";
      showNotice(hint);
      setTimeout(() => notice.textContent === hint && showNotice(""), ESCAPE_CHORD_MS);
    }
  });
  submit.addEventListener("click", () => {
    if (submit.dataset.mode === "stop") interrupt();
    else sendTyped(false);
  });
  attach.addEventListener("click", () => showNotice("Attachments are not supported in the web GUI yet."));

  queueList.addEventListener("click", async (event) => {
    const button = event.target.closest?.("button[data-action]");
    const entry = button?.closest("[data-kind]");
    if (!button || !entry) return;
    const target = { kind: entry.dataset.kind, index: Number(entry.dataset.index), text: entry.dataset.text };
    if (button.dataset.action === "steer") {
      await run("steer-next", {});
      return;
    }
    const result = await run("dequeue", target);
    if (result.ok && button.dataset.action === "edit") {
      field.value = field.value.trim() ? `${target.text}\n\n${field.value}` : target.text;
      grow();
      refresh();
      field.focus();
    }
  });

  function renderQueue(queue) {
    const entries = queueEntries(queue);
    queued = entries.length;
    queueList.hidden = entries.length === 0;
    queueList.replaceChildren(
      ...entries.map((entry) => {
        const item = document.createElement("li");
        item.className = "queued";
        item.dataset.kind = entry.kind;
        item.dataset.index = String(entry.index);
        item.dataset.text = entry.text;
        const text = document.createElement("span");
        text.className = "queued-text";
        text.textContent = entry.text;
        const label = document.createElement("span");
        label.className = "queued-label";
        label.textContent = entry.label;
        const actions = document.createElement("span");
        actions.className = "queued-actions";
        const buttons = [
          ["delete", "Delete queued message"],
          ["edit", "Edit queued message"],
          ...(entry.canSteer ? [["steer", "Send now to steer the turn"]] : []),
        ];
        actions.innerHTML = buttons
          .map(([action, title]) => `<button class="icon-button" type="button" data-action="${action}" aria-label="${title}" title="${title}">${icon(action)}</button>`)
          .join("");
        item.append(label, text, actions);
        return item;
      }),
    );
  }

  refresh();
  return {
    setStatus(status) {
      busy = status.busy;
      if (!busy) chord.reset();
      approval.hidden = status.phase !== "waitingApproval";
      refresh();
    },
    setQueue: renderQueue,
    setConnected(value) {
      connected = value;
      refresh();
    },
    /** Hidden behind another session's read-only view, Esc Esc must not interrupt the live turn. */
    setEnabled(value) {
      enabled = value;
      chord.reset();
    },
    focus() {
      field.focus({ preventScroll: true });
    },
  };
}
