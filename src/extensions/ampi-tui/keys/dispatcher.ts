import { formatMmrKeyChord, type MmrKeyCombo, type MmrResolvedKeymap, parseMmrKeyChord } from "../../ampi-core/keymap.js";

/**
 * Key dispatcher: a pure state machine that turns key combos into command
 * runs, following the resolved keymap.
 *
 * - A complete chord runs its command. A single-key chord whose command is
 *   not available lets the key through, so Home still moves the cursor when
 *   the prompt has text.
 * - A strict prefix (the leader, `ctrl+c` of `ctrl+c ctrl+c`, `esc` of
 *   `esc esc`) arms a pending state with a deadline. The leader always arms;
 *   any other prefix arms only while one of its continuations is available,
 *   so a lone Esc reaches Pi when nothing is running.
 * - While pending, a key that completes a chord runs it; Esc cancels; any
 *   other key cancels and is then handled as a fresh first key, so it is
 *   passed through unless it starts another chord.
 * - Every prefix except Esc asks the host to show a hint listing its
 *   continuations. Esc is a double press, not a menu.
 * - The host feeds `editorFocused`; while a dialog or selector has focus the
 *   dispatcher lets every key through.
 *
 * Time comes from `now()`. The host calls `expire()` when the hint deadline
 * passes; a key that arrives after the deadline finds nothing pending.
 */

export type MmrKeyAvailability = "available" | "unavailable" | "hidden";

export interface MmrKeyHintRow {
  /** Display form of the keys after the prefix, e.g. `Ctrl+C`. */
  readonly key: string;
  readonly description: string;
  readonly id: string;
}

export interface MmrKeyHint {
  /** Display form of the pending prefix, e.g. `Ctrl+X`. */
  readonly prefix: string;
  /** Continuations sorted by key; hidden commands are left out. */
  readonly rows: readonly MmrKeyHintRow[];
  /** `now()` value at which the pending state lapses. */
  readonly deadline: number;
}

export interface MmrKeyInputContext {
  /** False while a dialog, selector or capturing overlay has focus. */
  readonly editorFocused: boolean;
}

export interface MmrKeyDispatcherOptions {
  /** Only `byChord` and `leader` are read. */
  readonly keymap: Pick<MmrResolvedKeymap, "byChord" | "leader">;
  readonly now: () => number;
  readonly onRun: (id: string) => void;
  readonly onHint: (hint: MmrKeyHint) => void;
  readonly onClearHint: () => void;
  /** A completed multi-key chord whose command is not available. */
  readonly onUnavailable?: (id: string) => void;
  /** Defaults to every command being available. */
  readonly availability?: (id: string) => MmrKeyAvailability;
  /** Hint row text; defaults to the command id. */
  readonly describe?: (id: string) => string | undefined;
  readonly chordTimeoutMs?: number;
  readonly escapeWindowMs?: number;
}

export interface MmrKeyDispatcher {
  /** Feed one key; `undefined` stands for input that is not a key. Returns true when the key is consumed. */
  handle(combo: MmrKeyCombo | undefined, context?: MmrKeyInputContext): boolean;
  /** Clear the pending state when its deadline has passed. */
  expire(): void;
  /** Clear the pending state now. */
  cancel(): void;
  setKeymap(keymap: Pick<MmrResolvedKeymap, "byChord" | "leader">): void;
  isPending(): boolean;
  /** Canonical first keys of every chord, plus the leader and `esc`: the keys the host must see raw. */
  rawKeys(): ReadonlySet<string>;
}

const ESC = "esc";

/** Canonical text of one combo, as used in `MmrResolvedKeymap.byChord`. */
export function formatMmrKeyCombo(combo: MmrKeyCombo, style: "canonical" | "display" = "canonical"): string {
  return formatMmrKeyChord({ leader: false, combos: [combo] }, { style });
}

interface Table {
  readonly chords: ReadonlyMap<string, string>;
  /** Strict prefix -> the chords that continue it. */
  readonly continuations: ReadonlyMap<string, readonly { rest: string; id: string }[]>;
  readonly leader: string;
  readonly raw: ReadonlySet<string>;
}

function buildTable(keymap: Pick<MmrResolvedKeymap, "byChord" | "leader">): Table {
  const leader = formatMmrKeyCombo(keymap.leader);
  const continuations = new Map<string, { rest: string; id: string }[]>();
  const raw = new Set<string>([leader, ESC]);
  for (const [chord, id] of keymap.byChord) {
    const keys = chord.split(" ");
    raw.add(keys[0]);
    for (let length = 1; length < keys.length; length++) {
      const prefix = keys.slice(0, length).join(" ");
      const list = continuations.get(prefix) ?? [];
      list.push({ rest: keys.slice(length).join(" "), id });
      continuations.set(prefix, list);
    }
  }
  return { chords: keymap.byChord, continuations, leader, raw };
}

/**
 * Display form of a canonical chord, for hint rows, the command palette's
 * key column and the shortcuts help. A plain character stays as typed (`v`,
 * not `V`, which would read as Shift+V); everything else uses the keymap's
 * display form (`Ctrl+C`, `Shift+Z`, `Esc`).
 */
export function displayMmrKeyChord(canonical: string): string {
  const parsed = parseMmrKeyChord(canonical);
  if ("error" in parsed) return canonical;
  return parsed.combos
    .map((combo) => {
      const plain = !combo.ctrl && !combo.alt && !combo.shift && !combo.meta && [...combo.key].length === 1;
      return plain ? combo.key : formatMmrKeyCombo(combo, "display");
    })
    .join(" ");
}

export function createMmrKeyDispatcher(options: MmrKeyDispatcherOptions): MmrKeyDispatcher {
  const chordTimeoutMs = options.chordTimeoutMs ?? 1500;
  const escapeWindowMs = options.escapeWindowMs ?? 500;
  const availability = options.availability ?? (() => "available" as const);
  let table = buildTable(options.keymap);
  let pending: { keys: string[]; deadline: number; hinted: boolean } | undefined;

  function clearPending(): void {
    const hinted = pending?.hinted ?? false;
    pending = undefined;
    if (hinted) options.onClearHint();
  }

  function expireIfDue(): void {
    if (pending && options.now() >= pending.deadline) clearPending();
  }

  function canArm(prefix: string): boolean {
    if (prefix === table.leader) return true;
    return (table.continuations.get(prefix) ?? []).some(({ id }) => availability(id) === "available");
  }

  function arm(keys: string[]): void {
    const prefix = keys.join(" ");
    const isEscape = prefix === ESC;
    const deadline = options.now() + (isEscape ? escapeWindowMs : chordTimeoutMs);
    pending = { keys, deadline, hinted: !isEscape };
    if (isEscape) return;
    const rows = (table.continuations.get(prefix) ?? [])
      .filter(({ id }) => availability(id) !== "hidden")
      .sort((a, b) => (a.rest < b.rest ? -1 : a.rest > b.rest ? 1 : 0))
      .map(({ rest, id }) => ({ key: displayMmrKeyChord(rest), description: options.describe?.(id) ?? id, id }));
    options.onHint({ prefix: displayMmrKeyChord(prefix), rows, deadline });
  }

  function complete(id: string): boolean {
    if (availability(id) === "available") options.onRun(id);
    else options.onUnavailable?.(id);
    return true;
  }

  function fresh(key: string): boolean {
    if (table.continuations.has(key) || key === table.leader) {
      // A key that is both a chord and a prefix acts as the prefix; the
      // keymap reports that as a conflict.
      if (!canArm(key)) return false;
      arm([key]);
      return true;
    }
    const id = table.chords.get(key);
    if (id === undefined || availability(id) !== "available") return false;
    options.onRun(id);
    return true;
  }

  return {
    handle(combo, context = { editorFocused: true }) {
      expireIfDue();
      if (!context.editorFocused || combo === undefined) {
        clearPending();
        return false;
      }
      const key = formatMmrKeyCombo(combo);
      if (pending) {
        const sequence = [...pending.keys, key];
        const text = sequence.join(" ");
        if (table.continuations.has(text)) {
          arm(sequence);
          return true;
        }
        const id = table.chords.get(text);
        if (id !== undefined) {
          clearPending();
          return complete(id);
        }
        const escapeCancels = key === ESC && pending.keys[0] !== ESC;
        clearPending();
        if (escapeCancels) return true;
      }
      return fresh(key);
    },
    expire: expireIfDue,
    cancel: clearPending,
    setKeymap(keymap) {
      clearPending();
      table = buildTable(keymap);
    },
    isPending() {
      expireIfDue();
      return pending !== undefined;
    },
    rawKeys() {
      return table.raw;
    },
  };
}
