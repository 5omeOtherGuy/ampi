import type { OverlayOptions } from "@earendil-works/pi-tui";

/**
 * Overlay placement that follows the screen while the overlay stays open.
 * Pi resolves `overlayOptions` once, when the overlay opens, but keeps the
 * object and reads its fields again on every frame, so an `offsetY` getter
 * moves the overlay with a value that changes later, such as the prompt
 * box's height. Not part of Pi's extension API: Pi documents only
 * `visible()` as called on each frame.
 */
export function withMmrLiveOffsetY(options: Omit<OverlayOptions, "offsetY">, offsetY: () => number): OverlayOptions {
  return Object.defineProperty({ ...options }, "offsetY", { get: offsetY, enumerable: true });
}
