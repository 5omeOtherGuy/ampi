import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMmrAnimationDisabled } from "../../ampi-core/animation.js";
import { registerMmrChangelogPresenter } from "../../ampi-core/changelog.js";
import type { MmrTuiSettings } from "../config.js";
import { subscribeMmrTerminalInput } from "../pi-compat/terminal-input.js";
import { keepMmrTuiTheme } from "../theme/select.js";
import { createMmrTuiMessageStyle, type MmrUserMessageSelected } from "../transcript/messages.js";
import { buildMmrWelcomeCard, isMmrKeyInput, MmrWelcomeHeader, type MmrWelcomeCard } from "./welcome.js";

export interface MmrTuiLook {
  /** Apply the theme, message styling and welcome header to an interactive session. */
  start(ctx: ExtensionContext): void;
  /** Undo everything `installMmrTuiLook` set up; the next extension load installs it again. */
  stop(): void;
}

/**
 * Install ampi's look: the `ampi` theme, the transcript message styling and
 * the welcome header with its changelog card. Called when the extension loads,
 * because Pi rebuilds the chat on `/reload` before `session_start` and the
 * user message patch must already be in place. The changelog presenter takes
 * over ampi-core's new-version notification; with Pi's `quietStartup` it
 * declines, so the notification still shows.
 */
export function installMmrTuiLook(
  pi: ExtensionAPI,
  settings: MmrTuiSettings,
  isSelectedMessage?: MmrUserMessageSelected,
): MmrTuiLook {
  const messages = createMmrTuiMessageStyle(isSelectedMessage);
  let pendingCard: MmrWelcomeCard | undefined;
  let header: MmrWelcomeHeader | undefined;
  let stopListening: (() => void) | undefined;

  // ampi-core runs its session_start first and hands over the notice here.
  const releasePresenter = registerMmrChangelogPresenter((display) => {
    if (settings.quietStartup) return false;
    pendingCard = buildMmrWelcomeCard(display);
    return pendingCard !== undefined;
  });

  // Only the user's own first message settles the header; a prompt another
  // extension sends at startup leaves it for the user to see.
  pi.on("input", (event) => {
    if (event.source === "interactive") header?.settle();
  });

  const stopKeyListener = () => {
    stopListening?.();
    stopListening = undefined;
  };

  return {
    start(ctx) {
      keepMmrTuiTheme(ctx);
      messages.start(ctx);
      if (settings.quietStartup) return;

      const card = pendingCard;
      pendingCard = undefined;
      // Pi records the startup model and thinking level before session_start;
      // only a message means the session is already under way.
      const fresh = !ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
      // With animations off the mark rests on its first frame.
      const animate = fresh && !isMmrAnimationDisabled({ cwd: ctx.cwd });
      ctx.ui.setHeader((tui, theme) => {
        header = new MmrWelcomeHeader({
          theme,
          card,
          animate,
          rows: () => tui.terminal.rows,
          requestRender: () => tui.requestRender(),
        });
        return header;
      });

      stopKeyListener();
      if (card) {
        stopListening = subscribeMmrTerminalInput(ctx.ui, (data) => {
          if (isMmrKeyInput(data)) {
            header?.dismiss();
            stopKeyListener();
          }
          return false;
        });
      }
    },
    stop() {
      releasePresenter();
      messages.dispose();
      stopKeyListener();
      header?.dispose();
      header = undefined;
    },
  };
}
