import type { MmrGuiDialogAnswer, MmrGuiDialogOptions, MmrGuiDialogRequest } from "../ampi-core/gui-host.js";
import { MMR_GUI_MAX_PROMPT_LENGTH } from "./commands.js";
import { MMR_GUI_HUB_IDLE_MS } from "./hub.js";

/**
 * The questions extensions ask through `ctx.ui` in a session `ampi app`
 * hosts, held until the page answers them.
 *
 * The bridge owns one queue and sends what it emits as client events:
 *
 * | Client event    | Data                                                         |
 * | --------------- | ------------------------------------------------------------ |
 * | `dialog`        | `{ id, kind, title, message, options, placeholder, initial }` |
 * | `dialog_closed` | `{ id, answeredBy }`                                         |
 *
 * A question closes once: the first answer wins, and every later one finds
 * no open question. It also closes, as cancelled, when the extension's
 * `timeout` passes or its `signal` aborts, on an interrupt, at the end of
 * the session, and when nobody watches: once no page has had the session's
 * event stream open for {@link MMR_GUI_UNATTENDED_MS} (the same window after
 * which `ampi app` stops an idle worker), every open question is cancelled,
 * so a tool that waits for approval is refused instead of blocking the
 * worker for good.
 */

/** No page watched this long: open questions are cancelled. */
export const MMR_GUI_UNATTENDED_MS = MMR_GUI_HUB_IDLE_MS;

/** A question as the page gets it. Fields a kind does not use are `null` (`options` is empty). */
export interface MmrGuiDialog {
  id: string;
  kind: MmrGuiDialogRequest["kind"];
  title: string;
  message: string | null;
  options: string[];
  placeholder: string | null;
  initial: string | null;
}

/** What closed a question: the page's answer or cancel, or a cancel for one of the other reasons. */
export type MmrGuiDialogCloser = "page" | "timeout" | "abort" | "interrupt" | "unattended" | "shutdown";

export interface MmrGuiDialogQueueOptions {
  emit(event: "dialog" | "dialog_closed", data: unknown): void;
  now: () => number;
  setTimer: (callback: () => unknown, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Defaults to {@link MMR_GUI_UNATTENDED_MS}. */
  unattendedMs?: number;
}

export interface MmrGuiDialogQueue {
  ask(request: MmrGuiDialogRequest, options?: MmrGuiDialogOptions): Promise<MmrGuiDialogAnswer>;
  /** Answer an open question; `unknown` when there is none with this id, `invalid` when the value does not fit it. */
  answer(id: string, answer: { cancelled: true } | { value: unknown }): "answered" | "unknown" | "invalid";
  /** Cancel every open question; returns how many there were. */
  cancelAll(by: MmrGuiDialogCloser): number;
  /** The open questions, oldest first. */
  pending(): MmrGuiDialog[];
  /** A page opened the session's event stream; call the returned function when it closes. */
  watch(): () => void;
}

const KINDS = new Set<string>(["select", "confirm", "input", "editor"]);
const CANCELLED: MmrGuiDialogAnswer = Object.freeze({ cancelled: true as const });

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function normalize(id: string, request: MmrGuiDialogRequest): MmrGuiDialog {
  const kind = KINDS.has(request.kind) ? request.kind : "input";
  return {
    id,
    kind,
    title: String(request.title ?? ""),
    message: kind === "confirm" ? text(request.message) : null,
    options: kind === "select" && Array.isArray(request.options) ? request.options.map(String) : [],
    placeholder: kind === "input" ? text(request.placeholder) : null,
    initial: kind === "editor" ? text(request.initial) : null,
  };
}

function fits(dialog: MmrGuiDialog, value: unknown): boolean {
  if (dialog.kind === "confirm") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  if (dialog.kind === "select") return dialog.options.includes(value);
  return value.length <= MMR_GUI_MAX_PROMPT_LENGTH;
}

interface Open {
  dialog: MmrGuiDialog;
  resolve(answer: MmrGuiDialogAnswer): void;
  cleanup(): void;
}

export function createMmrGuiDialogQueue(options: MmrGuiDialogQueueOptions): MmrGuiDialogQueue {
  const { emit, now, setTimer, clearTimer } = options;
  const unattendedMs = options.unattendedMs ?? MMR_GUI_UNATTENDED_MS;
  const open = new Map<string, Open>();
  let nextId = 1;
  let watchers = 0;
  let unwatchedSince = now();
  let unattendedTimer: unknown;

  function disarm(): void {
    if (unattendedTimer === undefined) return;
    clearTimer(unattendedTimer);
    unattendedTimer = undefined;
  }

  /** While questions are open and no page watches, cancel them once the window has passed. */
  function arm(): void {
    if (open.size === 0 || watchers > 0 || unattendedTimer !== undefined) return;
    const left = unwatchedSince + unattendedMs - now();
    if (left <= 0) {
      cancelAll("unattended");
      return;
    }
    unattendedTimer = setTimer(() => {
      unattendedTimer = undefined;
      arm();
    }, left);
  }

  function close(id: string, answer: MmrGuiDialogAnswer, by: MmrGuiDialogCloser): boolean {
    const entry = open.get(id);
    if (!entry) return false;
    open.delete(id);
    entry.cleanup();
    if (open.size === 0) disarm();
    emit("dialog_closed", { id, answeredBy: by });
    entry.resolve(answer);
    return true;
  }

  function cancelAll(by: MmrGuiDialogCloser): number {
    const ids = [...open.keys()];
    for (const id of ids) close(id, CANCELLED, by);
    return ids.length;
  }

  return {
    ask(request, dialogOptions = {}) {
      const { signal, timeout } = dialogOptions;
      if (signal?.aborted) return Promise.resolve(CANCELLED);
      const dialog = normalize(`dialog-${nextId++}`, request);
      return new Promise((resolve) => {
        let timer: unknown;
        const onAbort = () => close(dialog.id, CANCELLED, "abort");
        signal?.addEventListener("abort", onAbort, { once: true });
        if (typeof timeout === "number" && timeout > 0) timer = setTimer(() => close(dialog.id, CANCELLED, "timeout"), timeout);
        open.set(dialog.id, {
          dialog,
          resolve,
          cleanup() {
            if (timer !== undefined) clearTimer(timer);
            signal?.removeEventListener("abort", onAbort);
          },
        });
        emit("dialog", dialog);
        arm();
      });
    },
    answer(id, answer) {
      const entry = open.get(id);
      if (!entry) return "unknown";
      if ("cancelled" in answer) {
        close(id, CANCELLED, "page");
        return "answered";
      }
      if (!fits(entry.dialog, answer.value)) return "invalid";
      close(id, { value: answer.value as string | boolean }, "page");
      return "answered";
    },
    cancelAll,
    pending: () => [...open.values()].map((entry) => ({ ...entry.dialog, options: [...entry.dialog.options] })),
    watch() {
      watchers++;
      disarm();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        watchers--;
        if (watchers > 0) return;
        unwatchedSince = now();
        arm();
      };
    },
  };
}
