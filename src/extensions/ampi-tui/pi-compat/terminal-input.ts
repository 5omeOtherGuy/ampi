import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/**
 * Raw terminal input. Pi calls the listener with each key chunk before the
 * focused component sees it; returning true consumes the chunk.
 *
 * Quirks the caller must expect (see `keys/decode.ts`): two quick Escapes
 * can arrive as one `\x1b\x1b` chunk, Esc then Enter typed quickly arrives as
 * `\x1b\r` (the same bytes as Alt+Enter), kitty key-release reports reach
 * the listener too, and keys that Pi's fullscreen transcript claims first
 * (PageUp, PageDown) never arrive.
 *
 * Returns an unsubscribe function, or `undefined` when this Pi build offers no
 * raw input (RPC and print modes).
 */
export function subscribeMmrTerminalInput(
  ui: Pick<ExtensionUIContext, "onTerminalInput">,
  listener: (data: string) => boolean,
): (() => void) | undefined {
  if (typeof ui.onTerminalInput !== "function") return undefined;
  return ui.onTerminalInput((data) => (listener(data) ? { consume: true } : undefined));
}
