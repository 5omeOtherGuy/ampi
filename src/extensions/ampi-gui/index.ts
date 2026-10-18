import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMmrCommand, unregisterMmrCommand } from "../ampi-core/command-registry.js";
import { createMmrGuiBridge } from "./bridge.js";
import { loadMmrGuiSettings, type MmrGuiSettings } from "./config.js";
import { removeMmrGuiLiveEntry, writeMmrGuiLiveEntry } from "./registry.js";
import { hashMmrGuiToken, type MmrGuiServer, startMmrGuiServer } from "./server.js";

/** Palette command that opens the running session in the browser. */
export const MMR_GUI_OPEN_COMMAND_ID = "thread.openInBrowser";

const CLIENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "client");

export interface MmrGuiFactoryOverrides {
  loadSettings?: () => MmrGuiSettings;
  /** Directory of the live registry; defaults to `<agentDir>/data/ampi/live`. */
  registryDir?: string;
  /** Opens a URL in a browser; resolves `false` when no browser could be started. */
  openUrl?: (url: string) => Promise<boolean>;
  /** The access token; defaults to 32 random bytes. */
  createToken?: () => string;
}

/** Start the platform's URL opener, where there is one and a desktop to show it on. */
export function openMmrGuiUrl(url: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<boolean> {
  const command = platform === "darwin" ? "open" : platform === "win32" ? undefined : "xdg-open";
  if (!command || (platform !== "darwin" && !env.DISPLAY && !env.WAYLAND_DISPLAY)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export function createMmrGuiExtension(overrides: MmrGuiFactoryOverrides = {}) {
  return function ampiGuiExtension(pi: ExtensionAPI): void {
    const settings = overrides.loadSettings ? overrides.loadSettings() : loadMmrGuiSettings(process.cwd());
    if (!settings.enabled) return;

    const bridge = createMmrGuiBridge(pi);
    const openUrl = overrides.openUrl ?? ((url: string) => openMmrGuiUrl(url));
    const registry = { baseDir: overrides.registryDir };
    let server: MmrGuiServer | undefined;

    function warn(ctx: ExtensionContext, what: string, error: unknown): void {
      ctx.ui.notify(`ampi-gui: ${what}: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }

    pi.on("session_start", async (_event, ctx) => {
      // Only an interactive terminal session gets a GUI. Print, JSON and RPC
      // runs, subagent workers included, never open a port.
      if (ctx.mode !== "tui" || server) return;
      const token = overrides.createToken ? overrides.createToken() : randomBytes(32).toString("base64url");
      bridge.start(ctx);
      try {
        server = await startMmrGuiServer({ bridge, token, clientDir: CLIENT_DIR });
      } catch (error) {
        bridge.stop();
        warn(ctx, "could not start the web GUI", error);
        return;
      }
      const url = server.url;
      registerMmrCommand({
        id: MMR_GUI_OPEN_COMMAND_ID,
        noun: "thread",
        verb: "open in browser",
        description: "Open this session in the local web GUI",
        keywords: ["web", "gui", "browser"],
        run: async (current) => {
          const opened = await openUrl(url).catch(() => false);
          current.ui.notify(opened ? `Opening the web GUI: ${url}` : `Open this link in a browser: ${url}`, "info");
        },
      });
      try {
        await writeMmrGuiLiveEntry(
          {
            pid: process.pid,
            sessionPath: ctx.sessionManager.getSessionFile() ?? null,
            cwd: ctx.cwd,
            port: server.port,
            tokenHash: hashMmrGuiToken(token),
            startedAt: new Date().toISOString(),
          },
          registry,
        );
      } catch (error) {
        warn(ctx, "could not record the session in the live registry", error);
      }
      ctx.ui.notify(`Web GUI: ${url}`, "info");
    });

    pi.on("session_shutdown", async () => {
      if (!server) return;
      const closing = server;
      server = undefined;
      unregisterMmrCommand(MMR_GUI_OPEN_COMMAND_ID);
      bridge.stop();
      await closing.close();
      await removeMmrGuiLiveEntry(process.pid, registry).catch(() => {});
    });
  };
}

export const createAmpiGuiExtension = createMmrGuiExtension;

const ampiGuiExtension = createMmrGuiExtension();

export default ampiGuiExtension;
