import { copyToClipboard, type ExtensionAPI, type ExtensionContext, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { markAmpiPartLoaded } from "../ampi-core/parts.js";
import { registerMmrPromptHistory } from "../ampi-core/prompt-history.js";
import { MMR_THREAD_SLASH_COMMAND, registerMmrThreadIndex } from "../ampi-core/thread-index.js";
import { registerMmrThreadReports, summarizeMmrThreadCost } from "../ampi-core/thread-reports.js";
import {
  archiveMmrSession,
  createMmrThreadSlashHandler,
  hasMmrSessionMessages,
  type MmrThreadCommandHost,
  registerMmrThreadCommands,
} from "./commands.js";
import { loadMmrThreadsSettings, type MmrThreadsSettings } from "./config.js";
import { analyzeMmrContext, type MmrContextAnalysisInput } from "./context-analysis.js";
import { createMmrPromptHistoryStore, type MmrPromptHistoryStore } from "./history-store.js";
import { createMmrThreadIndexStore, type MmrThreadIndexStore, type MmrThreadIndexStoreOptions } from "./index-store.js";
import { formatMmrThreadMarkdown } from "./markdown.js";
import { type MmrThreadTitlesOptions, registerMmrThreadTitles } from "./title.js";

export interface MmrThreadsFactoryOverrides {
  loadSettings?: () => MmrThreadsSettings;
  /** Builds the index store; receives the warning callback the extension wires to the UI. */
  createStore?: (options: Pick<MmrThreadIndexStoreOptions, "onWarning">) => MmrThreadIndexStore;
  /** Builds the prompt history store. */
  createHistoryStore?: () => MmrPromptHistoryStore;
  /** Archive timestamps; defaults to the current time. */
  now?: () => string;
  /** Puts text on the clipboard; defaults to Pi's `copyToClipboard`. */
  copyText?: (text: string) => Promise<void>;
  /** Reads `ampi-core` settings for the title model override; defaults to `loadMmrCoreSettings`. */
  loadCoreSettings?: MmrThreadTitlesOptions["loadCoreSettings"];
}

/** Pi's MCP adapter registers its tools from the `builtin:mcp` extension, in `mcp__<server>` namespaces. */
function isMcpTool(tool: ToolInfo): boolean {
  return tool.sourceInfo?.path === "builtin:mcp" || tool.namespace?.name.startsWith("mcp__") === true;
}

/** The context analysis' input for the current session. */
function contextInput(pi: ExtensionAPI, ctx: ExtensionContext): MmrContextAnalysisInput {
  const usage = ctx.getContextUsage();
  const tools = pi.getAllTools();
  const active = new Set(pi.getActiveTools());
  return {
    entries: ctx.sessionManager.getBranch(),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
    measuredTokens: usage?.tokens ?? undefined,
    mcpTools: new Set(tools.filter(isMcpTool).map((tool) => tool.name)),
    pending: { systemPrompt: ctx.getSystemPrompt(), tools: tools.filter((tool) => active.has(tool.name)) },
  };
}

export function createMmrThreadsExtension(overrides: MmrThreadsFactoryOverrides = {}) {
  return function ampiThreadsExtension(pi: ExtensionAPI): void {
    markAmpiPartLoaded(pi, "ampi-threads");
    const settings = overrides.loadSettings ? overrides.loadSettings() : loadMmrThreadsSettings(process.cwd());
    if (!settings.enabled) return;

    let ctx: ExtensionContext | undefined;
    const onWarning = (message: string) => {
      if (ctx?.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(`[ampi-threads] ${message}`);
    };
    const store = overrides.createStore ? overrides.createStore({ onWarning }) : createMmrThreadIndexStore({ onWarning });
    const host: MmrThreadCommandHost = {
      pi,
      store,
      now: overrides.now ?? (() => new Date().toISOString()),
      copyText: overrides.copyText ?? copyToClipboard,
    };

    // The store works in every run mode; the commands only matter where a
    // palette or key dispatcher shows them, and are harmless elsewhere.
    const releaseIndex = registerMmrThreadIndex(store);
    const history = overrides.createHistoryStore ? overrides.createHistoryStore() : createMmrPromptHistoryStore();
    const releaseHistory = registerMmrPromptHistory(history);
    const releaseReports = registerMmrThreadReports({
      showCosts: settings.showCosts,
      cost: (current) =>
        summarizeMmrThreadCost(current.sessionManager.getEntries(), (provider, model) => current.modelRegistry.find(provider, model)?.cost),
      // Prices from the running session's model registry; none before the session starts.
      costOfEntries: (entries) => summarizeMmrThreadCost(entries, (provider, model) => ctx?.modelRegistry.find(provider, model)?.cost),
      analyzeContext: (current) => analyzeMmrContext(contextInput(pi, current)),
      markdown: (entries, options) => formatMmrThreadMarkdown(entries, options),
    });
    const unregisterCommands = registerMmrThreadCommands(host);
    if (settings.titles) registerMmrThreadTitles({ pi, index: store, loadCoreSettings: overrides.loadCoreSettings });
    pi.registerCommand(MMR_THREAD_SLASH_COMMAND, {
      description: "Start, archive or switch sessions (used by the thread commands and the thread picker)",
      handler: createMmrThreadSlashHandler(host),
    });

    pi.on("session_start", async (_event, next) => {
      ctx = next;
      // Load this session's record, so the commands' availability (read
      // synchronously) knows whether it is archived.
      try {
        await store.get(next.sessionManager.getSessionId());
      } catch (error) {
        onWarning(`Could not read the thread index: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // Prompt history keeps what you type into the terminal prompt: not slash
    // commands or prompt templates, and not prompts that extensions, RPC
    // clients or print runs send. The prompt is not held up while the file
    // is written.
    pi.on("input", (event, current) => {
      if (event.source !== "interactive" || current.mode !== "tui") return;
      if (event.text.trimStart().startsWith("/")) return;
      history.append(current.cwd, event.text).catch((error: unknown) => {
        onWarning(`Could not record the prompt history: ${error instanceof Error ? error.message : String(error)}`);
      });
    });

    pi.on("session_shutdown", async (event, current) => {
      try {
        // Quitting an interactive session, by any route, archives it when
        // asked to. Switching sessions, reloading, and print, JSON and RPC
        // runs (subagent workers included) never do.
        if (settings.autoArchiveOnQuit && event.reason === "quit" && current.mode === "tui" && hasMmrSessionMessages(current)) {
          await archiveMmrSession(host, current).catch((error: unknown) => {
            // The terminal is already closed, so the error goes to stderr.
            console.warn(`[ampi-threads] Could not archive the session: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      } finally {
        unregisterCommands();
        releaseIndex();
        releaseHistory();
        releaseReports();
        ctx = undefined;
      }
    });
  };
}

export const createAmpiThreadsExtension = createMmrThreadsExtension;

const ampiThreadsExtension = createMmrThreadsExtension();

export default ampiThreadsExtension;
