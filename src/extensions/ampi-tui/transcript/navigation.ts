import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  parseSkillBlock,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import {
  type MmrCommandAvailability,
  type MmrCommandDefinition,
  registerMmrCommand,
  unregisterMmrCommand,
} from "../../ampi-core/command-registry.js";
import { getMmrLatestUserMessageNumber } from "../pi-compat/messages.js";
import { getMmrTranscriptScroller, type MmrTranscriptRows, revealMmrTranscriptRows } from "../pi-compat/scroll.js";
import type { MmrUserMessageSelected } from "./messages.js";

/**
 * Message navigation: Shift+Tab on an empty prompt selects the newest user
 * message and then earlier ones, Tab moves back towards the newest and past
 * it clears the selection, Esc clears it too, and `e` edits the selected
 * message. The selected message is drawn in a heavy frame with an
 * `e to edit` hint (see `renderMmrUserMessage`), and the transcript scrolls
 * to keep it in view.
 *
 * Editing goes through Pi's session tree: the thread moves back to the point
 * just before the message and its text goes into the prompt. Sending it
 * starts a new branch; the old branch stays in the session, and `/tree`
 * returns to it.
 */

/** Slash command `e` runs; Pi's tree navigation is only offered to commands. */
export const MMR_EDIT_MESSAGE_COMMAND = "ampi-edit-message";

/** A user message the transcript shows. */
export interface MmrEditableMessage {
  /** Session entry id. */
  readonly id: string;
  /** The message's text, as it goes back into the prompt. */
  readonly text: string;
  /** What the transcript draws for it: the text, or a skill call's own words. */
  readonly shown: string;
}

function userText(entry: SessionEntry | undefined): string | undefined {
  if (entry?.type !== "message" || entry.message.role !== "user") return undefined;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function editableMessage(entry: SessionEntry | undefined): MmrEditableMessage | undefined {
  const text = userText(entry);
  if (!entry || !text) return undefined;
  // Pi draws a skill call as its own block and the words typed with it as a
  // user message; without words there is no user message on screen.
  const skill = parseSkillBlock(text);
  const shown = skill ? skill.userMessage : text;
  return shown ? { id: entry.id, text, shown } : undefined;
}

/**
 * The user messages Pi draws in the transcript, oldest first: user entries of
 * the session's context with text. Images alone draw nothing.
 */
export function collectMmrEditableMessages(entries: readonly SessionEntry[]): MmrEditableMessage[] {
  return entries.flatMap((entry) => editableMessage(entry) ?? []);
}

/** Shift+Tab: the newest message when none is selected, otherwise the one before it; the oldest stays selected. */
export function selectPreviousMmrMessage(count: number, current: number | undefined): number | undefined {
  if (count <= 0) return undefined;
  if (current === undefined) return count - 1;
  return Math.max(0, Math.min(current, count) - 1);
}

/** Tab: the next newer message; past the newest, no selection. */
export function selectNextMmrMessage(count: number, current: number | undefined): number | undefined {
  if (current === undefined) return undefined;
  return current + 1 < count ? current + 1 : undefined;
}

const TOP_BORDER = /^\s*┏━*┓\s*$/;
const BOTTOM_BORDER = /^\s*┗.*┛\s*$/;

/** The rows of the selected message's frame in the drawn transcript. */
export function locateMmrSelectedMessage(lines: readonly string[]): MmrTranscriptRows | undefined {
  const plain = lines.map((line) => stripTerminalSequences(line));
  const start = plain.findIndex((line) => TOP_BORDER.test(line));
  if (start < 0) return undefined;
  const end = plain.findIndex((line, row) => row > start && BOTTOM_BORDER.test(line));
  return end < 0 ? undefined : { start, end };
}

export interface MmrMessageNavigationOptions {
  /** Number of the newest user message drawn; defaults to the pi-compat counter. */
  readonly latestNumber?: () => number;
}

export interface MmrMessageNavigation {
  /** Start for a TUI session: register the commands and drop any selection. */
  start(ctx: ExtensionContext, getTui: () => TUI | undefined): void;
  stop(): void;
  /** For the user message drawing: whether this message is the selected one. */
  readonly isSelected: MmrUserMessageSelected;
  /** Esc: drop the selection and return to the end of the transcript. True when there was one. */
  clear(): boolean;
}

interface Selection {
  readonly id: string;
  readonly shown: string;
  /** The drawn component's number; see `getMmrLatestUserMessageNumber`. */
  readonly number: number;
}

const AVAILABLE: MmrCommandAvailability = { state: "available" };
const PROMPT_HAS_TEXT: MmrCommandAvailability = { state: "unavailable", reason: "the prompt has text" };
const NOTHING_SELECTED: MmrCommandAvailability = { state: "unavailable", reason: "no message is selected" };

export function createMmrMessageNavigation(
  pi: Pick<ExtensionAPI, "on" | "registerCommand" | "sendUserMessage">,
  options: MmrMessageNavigationOptions = {},
): MmrMessageNavigation {
  const latestNumber = options.latestNumber ?? (() => getMmrLatestUserMessageNumber());
  let ctx: ExtensionContext | undefined;
  let getTui: () => TUI | undefined = () => undefined;
  let selection: Selection | undefined;
  let unregister: (() => void) | undefined;

  function messages(current: ExtensionContext): MmrEditableMessage[] {
    try {
      return collectMmrEditableMessages(current.sessionManager.buildContextEntries());
    } catch {
      return [];
    }
  }

  function selectedIndex(list: readonly MmrEditableMessage[]): number | undefined {
    const index = selection ? list.findIndex((message) => message.id === selection?.id) : -1;
    return index < 0 ? undefined : index;
  }

  function select(list: readonly MmrEditableMessage[], index: number | undefined): void {
    if (index === undefined) {
      clear();
      return;
    }
    // The last N user message components are the last N messages, so the
    // one at `index` has this number.
    selection = { id: list[index].id, shown: list[index].shown, number: latestNumber() - (list.length - 1 - index) };
    const tui = getTui();
    tui?.requestRender();
    revealMmrTranscriptRows(tui, locateMmrSelectedMessage);
  }

  function clear(): boolean {
    if (!selection) return false;
    selection = undefined;
    const tui = getTui();
    tui?.requestRender();
    getMmrTranscriptScroller(tui)?.toBottom();
    return true;
  }

  function promptEmpty(current: ExtensionContext): boolean {
    return current.ui.getEditorText().length === 0;
  }

  const commands: MmrCommandDefinition[] = [
    {
      id: "thread.selectPreviousMessage",
      noun: "thread",
      // Short verbs keep the shortcuts help in two columns.
      verb: "previous message",
      description: "Select the previous user message of the thread; e then edits it",
      defaultKey: "shift+tab",
      // With text in the prompt, Shift+Tab stays Pi's thinking level cycle.
      availability: (current) => {
        if (!promptEmpty(current)) return PROMPT_HAS_TEXT;
        return messages(current).length > 0 ? AVAILABLE : { state: "unavailable", reason: "the thread has no messages yet" };
      },
      run: (current) => {
        const list = messages(current);
        select(list, selectPreviousMmrMessage(list.length, selectedIndex(list)));
      },
    },
    {
      id: "thread.selectNextMessage",
      noun: "thread",
      verb: "next message",
      description: "Select the next user message; past the newest, clear the selection",
      defaultKey: "tab",
      availability: (current) => (!promptEmpty(current) ? PROMPT_HAS_TEXT : selection ? AVAILABLE : NOTHING_SELECTED),
      run: (current) => {
        const list = messages(current);
        select(list, selectNextMmrMessage(list.length, selectedIndex(list)));
      },
    },
    {
      id: "thread.editSelectedMessage",
      noun: "thread",
      verb: "edit message",
      description: "Put the selected message into the prompt and continue the thread from before it, on a new branch",
      defaultKey: "e",
      availability: (current) => {
        if (!promptEmpty(current)) return PROMPT_HAS_TEXT;
        if (!selection) return NOTHING_SELECTED;
        return current.isIdle() ? AVAILABLE : { state: "unavailable", reason: "wait for the turn to finish" };
      },
      run: () => {
        const id = selection?.id;
        if (id === undefined) return;
        clear();
        pi.sendUserMessage(`/${MMR_EDIT_MESSAGE_COMMAND} ${id}`, { expandPromptTemplates: true });
      },
    },
  ];

  pi.registerCommand(MMR_EDIT_MESSAGE_COMMAND, {
    description: "Edit an earlier user message by its entry id: the thread continues from before it on a new branch",
    handler: async (args: string, current: ExtensionCommandContext) => {
      const id = args.trim();
      const message = editableMessage(id ? current.sessionManager.getEntry(id) : undefined);
      if (!message) {
        current.ui.notify(`No user message ${id ? `"${id}" ` : ""}to edit.`, "warning");
        return;
      }
      // Pi moves the thread to the message's parent, keeps the old branch in
      // the session and puts the text into an empty prompt.
      const result = await current.navigateTree(message.id);
      if (result.cancelled) return;
      current.ui.setEditorText(message.text);
      // Pi's setEditorText does not redraw.
      getTui()?.requestRender();
    },
  });

  // Another tree move (/tree, a fork) rebuilds the transcript under the selection.
  pi.on("session_tree", () => {
    selection = undefined;
  });

  return {
    start(nextCtx, nextGetTui) {
      ctx = nextCtx;
      getTui = nextGetTui;
      selection = undefined;
      if (!unregister) {
        for (const command of commands) registerMmrCommand(command);
        unregister = () => {
          for (const command of commands) unregisterMmrCommand(command.id);
        };
      }
    },
    stop() {
      unregister?.();
      unregister = undefined;
      selection = undefined;
      ctx = undefined;
    },
    isSelected(number, text) {
      if (!selection) return false;
      // Typing into the prompt ends the selection.
      if (ctx && !promptEmpty(ctx)) {
        selection = undefined;
        return false;
      }
      return number === selection.number && text === selection.shown;
    },
    clear,
  };
}
