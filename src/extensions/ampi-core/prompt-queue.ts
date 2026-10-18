/**
 * Core-owned seam for the prompt queue: the messages a user sent while a turn
 * ran, waiting in Pi's queue.
 *
 * Pi's extension API says only whether messages are queued. The extension
 * that reads Pi's queue (`ampi-tui`, through its `pi-compat` layer) registers
 * here as its owner and publishes every change; other extensions, such as
 * the web GUI, read the texts and take a message back through the owner, so
 * only one place ever touches Pi's queue internals. Without an owner the
 * queue is unknown (`undefined`).
 *
 * globalThis-anchored so the owner and its readers share one store even when
 * Pi loads each extension entrypoint with its own copy of this module.
 */

/** Queued messages: those that steer the running turn, then those that follow it. */
export interface MmrQueuedPrompts {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}

export type MmrQueuedPromptKind = "steering" | "followUp";

export interface MmrPromptQueueOwner {
  /**
   * Take the `index`-th message of the `kind` list out of the queue, if it
   * still reads `text`. Returns false when it is no longer queued.
   */
  remove(kind: MmrQueuedPromptKind, index: number, text: string): boolean;
}

export interface MmrPromptQueueRegistration {
  /** Publish the queue after a change. */
  update(queue: MmrQueuedPrompts): void;
  /** Stop owning the queue; readers see `undefined` again. Idempotent. */
  release(): void;
}

interface Store {
  owner: MmrPromptQueueOwner | undefined;
  queue: MmrQueuedPrompts | undefined;
  readonly listeners: Set<() => void>;
}

const PROMPT_QUEUE_GLOBAL_KEY = "__pi_ampi_prompt_queue_v1__";
const globalStore = globalThis as typeof globalThis & { [PROMPT_QUEUE_GLOBAL_KEY]?: Store };
const store: Store = globalStore[PROMPT_QUEUE_GLOBAL_KEY] ?? { owner: undefined, queue: undefined, listeners: new Set() };
globalStore[PROMPT_QUEUE_GLOBAL_KEY] = store;

const EMPTY: MmrQueuedPrompts = { steering: [], followUp: [] };

function notify(): void {
  for (const listener of [...store.listeners]) {
    try {
      listener();
    } catch {}
  }
}

/** Become the owner of the prompt queue, starting empty. A later registration replaces this one. */
export function registerMmrPromptQueue(owner: MmrPromptQueueOwner): MmrPromptQueueRegistration {
  store.owner = owner;
  store.queue = EMPTY;
  notify();
  return {
    update(queue) {
      if (store.owner !== owner) return;
      store.queue = { steering: [...queue.steering], followUp: [...queue.followUp] };
      notify();
    },
    release() {
      if (store.owner !== owner) return;
      store.owner = undefined;
      store.queue = undefined;
      notify();
    },
  };
}

/** The queued messages, or `undefined` when no extension can read Pi's queue. */
export function getMmrPromptQueue(): MmrQueuedPrompts | undefined {
  return store.queue;
}

/** Take one queued message back; see {@link MmrPromptQueueOwner.remove}. False without an owner. */
export function removeMmrQueuedPrompt(kind: MmrQueuedPromptKind, index: number, text: string): boolean {
  return store.owner?.remove(kind, index, text) ?? false;
}

/** Call `listener` after every change of the queue or its owner. Returns the unsubscribe function. */
export function onMmrPromptQueueChanged(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}
