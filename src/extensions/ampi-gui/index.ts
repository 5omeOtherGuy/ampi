import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { registerMmrCommand, unregisterMmrCommand } from "../ampi-core/command-registry.js";
import { getMmrGuiHost, type MmrGuiSessionHost } from "../ampi-core/gui-host.js";
import { flushMmrLiveEntry, readMmrLiveEntries, setMmrLiveFields } from "../ampi-core/live-registry.js";
import { listMmrSessionsInScope } from "../ampi-core/session-catalog.js";
import { createMmrGuiBridge } from "./bridge.js";
import { createMmrGuiCommands } from "./commands.js";
import { loadMmrGuiSettings, type MmrGuiSettings } from "./config.js";
import { mmrGuiRowHosts, startMmrGuiHub } from "./hub.js";
import { type MmrGuiServer, startMmrGuiServer } from "./server.js";
import { createMmrGuiSessions } from "./sessions.js";

/** Palette command that opens the running session in the browser. */
export const MMR_GUI_OPEN_COMMAND_ID = "thread.openInBrowser";

const CLIENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "client");

export interface MmrGuiFactoryOverrides {
  loadSettings?: () => MmrGuiSettings;
  /** Directory of ampi-core's live registry, read for the sessions other processes run; defaults to `<agentDir>/data/ampi/live`. */
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
    // `ampi app` and the sessions it hosts have a GUI whatever the settings say: the user started the app for it.
    const settings = overrides.loadSettings ? overrides.loadSettings() : loadMmrGuiSettings(process.cwd());
    const loadHost = getMmrGuiHost();
    if (!settings.enabled && loadHost === undefined) return;
    // `ampi app`'s own in-memory session serves the app's page instead of a session's.
    const hub = loadHost?.role === "hub" ? loadHost : undefined;

    const bridge = createMmrGuiBridge(pi);
    const sessions = createMmrGuiSessions({
      // Every saved session, from the session directory this Pi uses (a custom one included);
      // the app, whose session has no directory, lists Pi's default one.
      source: {
        listSessions: async () => {
          const ctx = bridge.context();
          if (ctx) return listMmrSessionsInScope(ctx.sessionManager, "all");
          return hub ? SessionManager.listAll() : [];
        },
      },
      current: () => (bridge.context() ? bridge.session() : undefined),
      // Every session file another running process has open: terminal
      // sessions with or without a GUI, and print, JSON and RPC runs.
      elsewhere: async () =>
        (await readMmrLiveEntries({ dir: overrides.registryDir }))
          .filter((entry) => entry.pid !== process.pid && entry.sessionPath !== null)
          .map((entry) => entry.sessionPath as string),
      hosts: hub ? async () => mmrGuiRowHosts(await readMmrLiveEntries({ dir: overrides.registryDir })) : undefined,
    });
    const commands = createMmrGuiCommands(pi, bridge, sessions);
    const openUrl = overrides.openUrl ?? ((url: string) => openMmrGuiUrl(url));
    let server: MmrGuiServer | undefined;
    let hostReady = false;
    /** The host record whose `dialog` and `notice` this session set. */
    let hostedRecord: MmrGuiSessionHost | undefined;

    function warn(ctx: ExtensionContext, what: string, error: unknown): void {
      ctx.ui.notify(`ampi-gui: ${what}: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }

    pi.on("session_start", async (_event, ctx) => {
      if (hub) {
        if (ctx.mode !== "rpc" || server) return;
        try {
          server = await startMmrGuiHub({
            token: hub.token,
            clientDir: CLIENT_DIR,
            startSession: (request) => hub.startSession(request),
            sessions,
            commands,
            registry: { dir: overrides.registryDir },
          });
        } catch (error) {
          warn(ctx, "could not start the app's web GUI", error);
          return;
        }
        setMmrLiveFields({ gui: { port: server.port, token: hub.token } });
        if (!hostReady) {
          hostReady = true;
          await flushMmrLiveEntry();
          hub.ready({ port: server.port });
        }
        return;
      }
      // Only an interactive session gets a GUI: one in the terminal, or one
      // `ampi app` hosts, which Pi runs in RPC mode. Other print, JSON and
      // RPC runs, subagent workers included, never open a port.
      const host = getMmrGuiHost();
      const hosted = host?.role === "session" && ctx.mode === "rpc";
      if ((ctx.mode !== "tui" && !hosted) || server) return;
      const token = hosted ? host.token : overrides.createToken ? overrides.createToken() : randomBytes(32).toString("base64url");
      // Without a terminal, extensions ask the page: the worker's ctx.ui calls these.
      bridge.start(ctx, { dialogs: hosted });
      try {
        server = await startMmrGuiServer({ bridge, commands, sessions, token, clientDir: CLIENT_DIR });
      } catch (error) {
        bridge.stop();
        warn(ctx, "could not start the web GUI", error);
        return;
      }
      if (hosted) {
        hostedRecord = host;
        host.dialog = (request, options) => bridge.ask(request, options);
        host.notice = (message, level) => bridge.notice(message, level);
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
      // ampi-core writes this process's live registry entry; the GUI adds its port, and its token for `ampi app`.
      setMmrLiveFields({ gui: { port: server.port, token } });
      if (!hosted) {
        // Written now, not within the write throttle: an `ampi app` page that
        // read the entry meanwhile would take this terminal for one without
        // the web GUI.
        await flushMmrLiveEntry();
        ctx.ui.notify(`Web GUI: ${url}`, "info");
      } else if (!hostReady) {
        // The host already holds the token; it builds the link itself. The
        // entry is written first, so a host that reads the registry on ready
        // finds the GUI there. A host whose runtime can replace the session
        // (none binds command actions yet) would need each new port too.
        hostReady = true;
        await flushMmrLiveEntry();
        host.ready({ port: server.port });
      }
    });

    pi.on("session_shutdown", async () => {
      if (!server) return;
      const closing = server;
      server = undefined;
      if (hostedRecord) {
        hostedRecord.dialog = undefined;
        hostedRecord.notice = undefined;
        hostedRecord = undefined;
      }
      if (!hub) unregisterMmrCommand(MMR_GUI_OPEN_COMMAND_ID);
      setMmrLiveFields({ gui: null });
      bridge.stop();
      await closing.close();
    });
  };
}

export const createAmpiGuiExtension = createMmrGuiExtension;

const ampiGuiExtension = createMmrGuiExtension();

export default ampiGuiExtension;
