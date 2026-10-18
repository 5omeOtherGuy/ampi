/**
 * The sessions you switched away from and back, for `thread switch to
 * previous` and `thread switch to next`. It works like a browser's back and
 * forward lists: switching to a session puts the one you left first in the
 * previous list and empties the next list; going back moves the session you
 * leave to the front of the next list, and going forward the reverse.
 *
 * Entries are session file paths, most recent first. The history lasts as
 * long as the Pi process: it is anchored on `globalThis`, because Pi loads
 * the extension afresh for every session it switches to.
 */

export type MmrThreadSwitchDirection = "previous" | "next";

export interface MmrThreadSwitchHistory {
  /** Sessions to go back to, most recent first. */
  readonly previous: string[];
  /** Sessions to go forward to, most recent first. */
  readonly next: string[];
}

const SWITCH_HISTORY_GLOBAL_KEY = "__pi_ampi_thread_switch_history_v1__";
const globalStore = globalThis as typeof globalThis & { [SWITCH_HISTORY_GLOBAL_KEY]?: MmrThreadSwitchHistory };

/** This process's switch history. */
export function getMmrThreadSwitchHistory(): MmrThreadSwitchHistory {
  let history = globalStore[SWITCH_HISTORY_GLOBAL_KEY];
  if (!history) {
    history = { previous: [], next: [] };
    globalStore[SWITCH_HISTORY_GLOBAL_KEY] = history;
  }
  return history;
}

/** Forget every entry. For tests. */
export function __resetMmrThreadSwitchHistoryForTests(): void {
  const history = getMmrThreadSwitchHistory();
  history.previous.length = 0;
  history.next.length = 0;
}

/** The session `direction` leads to, skipping `current` itself; `undefined` when there is none. */
export function peekMmrThreadSwitch(direction: MmrThreadSwitchDirection, current: string | undefined): string | undefined {
  return getMmrThreadSwitchHistory()[direction].find((entry) => entry !== current);
}

/**
 * Record a switch from `from` (`undefined` for a session that cannot be
 * reopened, such as an unsaved one) to `to`. `direction` says whether the
 * switch went back or forward through the history; a plain switch leaves it
 * out.
 */
export function recordMmrThreadSwitch(from: string | undefined, to: string, direction?: MmrThreadSwitchDirection): void {
  const history = getMmrThreadSwitchHistory();
  if (direction === undefined) {
    history.next.length = 0;
    if (from !== undefined && from !== to) history.previous.unshift(from);
    return;
  }
  const source = history[direction];
  const target = direction === "previous" ? history.next : history.previous;
  // Drop the target and the entries skipped on the way to it (the current session).
  source.splice(0, source.indexOf(to) + 1);
  if (from !== undefined && from !== to) target.unshift(from);
}

/** Drop a session that can no longer be opened from both lists. */
export function forgetMmrThreadSwitchTarget(entry: string): void {
  const history = getMmrThreadSwitchHistory();
  for (const list of [history.previous, history.next]) {
    for (let position = list.indexOf(entry); position !== -1; position = list.indexOf(entry)) list.splice(position, 1);
  }
}
