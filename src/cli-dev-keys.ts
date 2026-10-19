import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveMmrEffectiveKeymap } from "./config-keymap.js";
import { decodeMmrTerminalKeyEvent, type MmrKeyEventType } from "./extensions/ampi-tui/keys/decode.js";
import { createMmrKeyDispatcher, formatMmrKeyCombo } from "./extensions/ampi-tui/keys/dispatcher.js";

/**
 * The key reader of `ampi dev keys`: what ampi makes of each chunk of terminal
 * input, outside a Pi session.
 *
 * Each chunk is decoded with ampi-tui's key decoder and fed to a key
 * dispatcher over the keymap `ampi config keymap` prints, so a line says which
 * keys ampi read, which command id the keymap runs and which prefix it waits
 * on. Every command counts as available and the prompt as focused, so a lone
 * Esc waits for a second one as while a turn runs. Commands are only named,
 * never run. Releases are reported but do not reach the dispatcher, and
 * input that is not a key cancels a pending prefix, as in a session.
 */

/** What the reader reports for one chunk, in the order the command prints the fields. */
export type MmrDevKeyRecord =
  | {
      /** Canonical combos: two for a merged double Escape, otherwise one (none for a release without a keymap name). */
      readonly keys: readonly string[];
      readonly event: MmrKeyEventType;
      /** The command id the keymap runs on this chunk, else `null`; left out without a keymap. */
      readonly command?: string | null;
      /** The prefix waiting for its next key after this chunk, else `null`; left out without a keymap. */
      readonly pending?: string | null;
    }
  | { readonly keys: readonly []; readonly paste: true }
  | { readonly keys: readonly []; readonly unknown: true };

export interface MmrDevKeyReader {
  /** Keymap problems and the ampi-tui-off note, as `ampi config keymap` reports them; empty without a keymap. */
  readonly problems: readonly string[];
  /** Read one chunk of input: one key sequence, or one bracketed paste with its markers. */
  feed(chunk: string): MmrDevKeyRecord;
}

export interface MmrDevKeyReaderOptions {
  /** Pi's settings, user and project merged; read only with a keymap. */
  readonly settings?: unknown;
  readonly cwd?: string;
  /** Resolve the keymap and report commands and pending prefixes; `false` reports keys only. */
  readonly keymap?: boolean;
  /** Clock of the dispatcher's chord and Esc deadlines, in milliseconds. */
  readonly now?: () => number;
}

/** A bracketed paste reaches the reader as one chunk wrapped in its markers, as Pi's terminal forwards it. */
const PASTE_START = "\x1b[200~";

/** Build a key reader. Nothing it does touches a session or runs a command. */
export function createMmrDevKeyReader(options: MmrDevKeyReaderOptions = {}): MmrDevKeyReader {
  const effective = options.keymap === false ? undefined : resolveMmrEffectiveKeymap(options.settings, options.cwd);
  let ran: string | undefined;
  const dispatcher =
    effective &&
    createMmrKeyDispatcher({
      keymap: effective.keymap,
      now: options.now ?? Date.now,
      onRun: (id) => {
        ran = id;
      },
      onHint: () => {},
      onClearHint: () => {},
    });

  return {
    problems: effective?.problems ?? [],
    feed(chunk) {
      const paste = chunk.startsWith(PASTE_START);
      const decoded = paste ? undefined : decodeMmrTerminalKeyEvent(chunk);
      if (decoded === undefined) {
        dispatcher?.handle(undefined);
        return paste ? { keys: [], paste: true } : { keys: [], unknown: true };
      }
      const keys = decoded.combos.map((combo) => formatMmrKeyCombo(combo));
      if (!dispatcher) return { keys, event: decoded.event };
      ran = undefined;
      if (decoded.event !== "release") {
        for (const combo of decoded.combos) dispatcher.handle(combo);
      }
      return { keys, event: decoded.event, command: ran ?? null, pending: dispatcher.pendingKeys() ?? null };
    },
  };
}

/** Event channel on which this module's extension entry hands `ampi dev keys` its key reader. */
export const MMR_CLI_DEV_KEYS_EVENT = "ampi:cli-dev-keys";

/**
 * Entry for Pi's extension loader, used by `ampi dev keys`: the command loads
 * this file with it and receives `createMmrDevKeyReader` on Pi's event bus.
 * It is not one of the package's extensions and registers nothing.
 */
export default function ampiCliDevKeysEntry(pi: ExtensionAPI): void {
  pi.events.emit(MMR_CLI_DEV_KEYS_EVENT, { createKeyReader: createMmrDevKeyReader });
}
