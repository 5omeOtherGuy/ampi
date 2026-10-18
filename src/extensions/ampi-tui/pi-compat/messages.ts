/**
 * Adapter for the one piece of undocumented Pi surface that ampi's message
 * styling needs: Pi offers no API to draw user messages, so ampi replaces
 * `UserMessageComponent.prototype.rebuild`, the method the component calls
 * from its constructor and whenever its padding changes.
 *
 * Everything that depends on the class's shape lives here. When a Pi release
 * changes it, `probeMmrUserMessageComponent` names the difference, the
 * install becomes a no-op, and Pi's own user message box stays on screen.
 */
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";

/** Draws one user message: its raw text, the width available, and Pi's left margin setting. */
export type MmrUserMessageDraw = (text: string, width: number, outputPad: number) => string[];

interface UserMessageInstance {
  text: unknown;
  outputPad: unknown;
  clear(): void;
  addChild(component: { render(width: number): string[]; invalidate(): void }): void;
}

interface PatchState {
  readonly original: (this: UserMessageInstance) => void;
  readonly draw: MmrUserMessageDraw;
}

type UserMessagePrototype = Record<PropertyKey, unknown> & {
  rebuild: (this: UserMessageInstance) => void;
  [PATCH_KEY]?: PatchState;
};

// Symbol.for, so a module loaded again by /reload finds the state an earlier
// copy left on the shared prototype instead of wrapping its own patch.
const PATCH_KEY = Symbol.for("ampi.tui.userMessagePatch.v1");

/**
 * Check that `target` still has the shape the patch relies on. Returns
 * `undefined` when it does, or a sentence naming what changed.
 */
export function probeMmrUserMessageComponent(target: unknown = UserMessageComponent): string | undefined {
  if (typeof target !== "function") return "UserMessageComponent is no longer exported as a class";
  const proto = target.prototype as Record<string, unknown> | undefined;
  for (const method of ["rebuild", "clear", "addChild", "render"]) {
    if (typeof proto?.[method] !== "function") return `UserMessageComponent.prototype.${method} is missing`;
  }
  let instance: Partial<UserMessageInstance>;
  try {
    instance = new (target as new (text: string) => Partial<UserMessageInstance>)("ampi probe");
  } catch (error) {
    return `UserMessageComponent can no longer be built from text alone (${error instanceof Error ? error.message : String(error)})`;
  }
  if (instance.text !== "ampi probe") return "UserMessageComponent no longer keeps its text in `text`";
  if (typeof instance.outputPad !== "number") return "UserMessageComponent no longer keeps its margin in `outputPad`";
  return undefined;
}

/**
 * Draw every user message Pi creates from now on with `draw`. Returns a
 * function that restores Pi's own drawing, or `undefined` (and changes
 * nothing) when the class shape no longer matches. Installing again replaces
 * the previous `draw` rather than stacking on it.
 */
export function installMmrUserMessageDraw(
  draw: MmrUserMessageDraw,
  target: unknown = UserMessageComponent,
): (() => void) | undefined {
  if (probeMmrUserMessageComponent(target) !== undefined) return undefined;
  const proto = (target as { prototype: UserMessagePrototype }).prototype;
  const state: PatchState = { original: proto[PATCH_KEY]?.original ?? proto.rebuild, draw };
  proto[PATCH_KEY] = state;
  proto.rebuild = function rebuildWithAmpiDraw(this: UserMessageInstance) {
    this.clear();
    const message = this;
    this.addChild({
      render: (width) => state.draw(String(message.text), width, typeof message.outputPad === "number" ? message.outputPad : 0),
      invalidate() {},
    });
  };
  return () => {
    if (proto[PATCH_KEY] !== state) return;
    proto.rebuild = state.original;
    delete proto[PATCH_KEY];
  };
}
