// Shared mock Pi host and ExtensionContext factories used across mmr-core tests.
//
// These stubs deliberately expose the union of Pi-host capabilities the
// extension code reads from, rather than a per-test minimal slice, so adding a
// new capability to the production code does not silently bypass existing
// tests. Tests opt into observed-behavior assertions by reading the returned
// `calls`/`commands`/`shortcuts`/`handlers`/`emits` recorders.

/**
 * Build a mock Pi host with recorders for every observable side effect.
 *
 * Options:
 *  - `activeTools` (default `["read", "bash"]`): initial set returned by `getActiveTools`.
 *  - `allTools` (default = `activeTools`): array of tool names or `{name, sourceInfo}` entries.
 *  - `thinkingLevel` (default `undefined`): initial value for `getThinkingLevel`.
 *  - `flagValue` (default `undefined`): legacy single value returned by `getFlag` for any
 *    name. Used by mmr-core tests that read a single flag (`mmr-mode`). When set, it
 *    takes priority over per-name values and seeded defaults so existing tests behave
 *    identically.
 *  - `flags` (default `{}`): per-flag-name initial values. Use this instead of `flagValue`
 *    when an extension reads more than one flag (e.g. mmr-tasks reads
 *    `task-widget-toggle-key`). Per-name explicit values override seeded defaults from
 *    `registerFlag(name, { default })`.
 *  - `shortcutsThrowOn` (default `[]`): array of shortcut keys for which
 *    `registerShortcut` will throw, simulating Pi's duplicate-binding rejection.
 *    Used to exercise the toolbox's fallback chain (`ctrl+t` -> `ctrl+shift+t` -> `alt+t`).
 *  - `settings` (default `{}`): object returned (as a copy) by `getSettings`.
 *  - `setModelResult` (default `true`): boolean returned by `setModel`.
 *  - `mcpServers` (default `[]`): servers returned (as copies) by `getMcpServers`.
 *  - `initialModel` (default `undefined`): initial value tracked by `getModel`.
 *  - `onModelSet(model, { handlers, eventContext })` (optional): async hook
 *    invoked after `setModel`, used to simulate Pi emitting downstream events.
 *  - `onThinkingLevelSet(level, { handlers, eventContext })` (optional): hook
 *    invoked after `setThinkingLevel`.
 *  - `onSendUserMessage(content, options)` (optional): hook invoked after
 *    `sendUserMessage` is recorded, used to simulate Pi queueing the message.
 *  - `onRegisterMcpServer(name, config)` (optional): hook invoked before
 *    `registerMcpServer` is recorded; throw from it to simulate Pi rejecting the config.
 *
 * Returns `{ pi, calls, commands, shortcuts, handlers, tools, flagDefs, emits,
 * toolRenderers, setEventContext }`. `toolRenderers` lists the resolvers passed
 * to `registerToolRenderer`, in registration order. `tools`, `commands`, and `flagDefs` are also exposed as
 * `pi.tools` / `pi.commands` / `pi.flagDefs` so tests can drive registered
 * tools (`pi.tools.get(name).execute(...)`) and assert on the declarative
 * surfaces the extension exposes to Pi (e.g. the description+type of a
 * registered CLI flag).
 */
/** Call each handler in turn; once one returns a promise, chain the rest after it. */
function runHandlers(list, args) {
  for (const [index, handler] of list.entries()) {
    const result = handler(...args);
    if (typeof result?.then === "function") {
      return list.slice(index + 1).reduce((chain, next) => chain.then(() => next(...args)), result);
    }
  }
  return undefined;
}

export function createMockPi(options = {}) {
  const initialActiveTools = options.activeTools ?? ["read", "bash"];
  const rawAllTools = options.allTools ?? [...initialActiveTools];
  const allTools = rawAllTools.map((entry) =>
    typeof entry === "string" ? { name: entry } : { ...entry },
  );

  const tools = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const handlers = new Map();
  const handlerLists = new Map();
  // Records the raw `opts` passed to `registerFlag(name, opts)` so tests
  // can assert on declared metadata (description, type, default) without
  // round-tripping through the resolved `getFlag` value.
  const flagDefs = new Map();
  const emits = [];
  const toolRenderers = [];
  const calls = {
    setActiveTools: [],
    setModel: [],
    setThinkingLevel: [],
    appendEntry: [],
    sendUserMessage: [],
    registerMcpServer: [],
  };

  // Per-name flag values. Seeded from `options.flags` (explicit per-test
  // overrides) and from `registerFlag(name, { default })` declarations. The
  // legacy `options.flagValue` is consulted first in `getFlag` so mmr-core
  // tests that pass a single value for the mmr-mode flag keep working.
  const flagValues = new Map(Object.entries(options.flags ?? {}));
  const shortcutsThrowOn = new Set(options.shortcutsThrowOn ?? []);

  let activeTools = [...initialActiveTools];
  let thinkingLevel = options.thinkingLevel;
  let currentModel = options.initialModel;
  let eventContext;

  const pi = {
    registerFlag: (name, opts) => {
      flagDefs.set(name, opts);
      // Pi's real CLI parser exposes the declared default via `getFlag` when
      // the user did not pass the flag. Mirror that here so extensions that
      // do `registerFlag(...); getFlag(...)` at load time get the default.
      // `options.flags` takes priority over the seeded default.
      if (opts && opts.default !== undefined && !flagValues.has(name)) {
        flagValues.set(name, opts.default);
      }
    },
    getFlag: (name) => {
      // Legacy single-value compatibility: when callers pass `flagValue`,
      // every `getFlag(...)` returns it. mmr-core tests rely on this.
      if (options.flagValue !== undefined) return options.flagValue;
      return flagValues.get(name);
    },
    registerTool: (def) => tools.set(def.name, def),
    registerToolRenderer: (resolver) => toolRenderers.push(resolver),
    tools,
    toolRenderers,
    commands,
    flagDefs,
    shortcuts,
    handlers,
    getActiveTools: () => [...activeTools],
    getAllTools: () => allTools.map((tool) => ({ ...tool })),
    // Servers extensions registered, as Pi lists them (copies).
    getMcpServers: () => structuredClone(options.mcpServers ?? []),
    setActiveTools: (toolList) => {
      calls.setActiveTools.push([...toolList]);
      activeTools = [...toolList];
    },
    setModel: async (model) => {
      currentModel = model;
      calls.setModel.push(model);
      if (options.onModelSet) await options.onModelSet(model, { handlers, eventContext });
      return options.setModelResult ?? true;
    },
    getModel: () => currentModel,
    // A copy, as Pi returns one: callers cannot change the stored settings.
    getSettings: () => structuredClone(options.settings ?? {}),
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level) => {
      thinkingLevel = level;
      calls.setThinkingLevel.push(level);
      if (options.onThinkingLevelSet) {
        options.onThinkingLevelSet(level, { handlers, eventContext });
      }
    },
    appendEntry: (...entry) => calls.appendEntry.push(entry),
    sendUserMessage: (content, opts) => {
      calls.sendUserMessage.push({ content, options: opts });
      options.onSendUserMessage?.(content, opts);
    },
    registerMcpServer: (name, config) => {
      options.onRegisterMcpServer?.(name, config);
      calls.registerMcpServer.push({ name, config });
    },
    registerCommand: (name, command) => commands.set(name, command),
    // Registered commands as Pi lists them (extension commands only).
    getCommands: () =>
      [...commands].map(([name, command]) => ({ name, description: command.description, source: "extension" })),
    registerShortcut: (key, definition) => {
      if (shortcutsThrowOn.has(key)) {
        throw new Error(`mock pi: shortcut already bound: ${key}`);
      }
      shortcuts.set(key, definition);
    },
    on: (name, handler) => {
      // Pi runs every handler for an event in registration order; with more
      // than one, `handlers.get(name)` does the same, awaiting async ones.
      const list = handlerLists.get(name) ?? [];
      list.push(handler);
      handlerLists.set(name, list);
      handlers.set(name, list.length === 1 ? handler : (...args) => runHandlers(list, args));
    },
    events: {
      emit: (name, data) => emits.push({ name, data }),
      on: () => () => {},
      off: () => {},
    },
  };

  return {
    pi,
    calls,
    commands,
    shortcuts,
    handlers,
    tools,
    flagDefs,
    emits,
    toolRenderers,
    setEventContext: (ctx) => {
      eventContext = ctx;
    },
  };
}

/**
 * Build a mock ExtensionContext for shortcut/command/lifecycle handlers.
 *
 * Options:
 *  - `models` (default `[]`): provider/model registrations seen by modelRegistry.
 *  - `authenticated` (default `true`): drives `hasConfiguredAuth`.
 *  - `hasUI` (default `true`): controls `ctx.hasUI` for code that gates on it.
 *  - `mode` (default `"tui"` with a UI, `"print"` without): Pi's run mode, `ctx.mode`.
 *  - `sessionId`, `sessionName`, `cwd`: identity-shaped fields.
 *  - `model`: the `ctx.model` currently selected by Pi.
 *  - `getContextUsage` (default returns `undefined`): hook for token-usage info.
 *  - `entries` (default `[]`): mutable list returned by `sessionManager.getEntries`.
 *  - `idle` (default `true`): what `isIdle()` returns; change it later through `state.idle`.
 *  - `editorText` (default `""`): what `ui.getEditorText()` returns; change it through
 *   `state.editorText` (`ui.setEditorText` writes it too).
 *  - `state.pendingMessages` (default `false`): what `hasPendingMessages()` returns.
 *  - `themeName` (default `undefined`): `ctx.ui.theme.name`, the active theme.
 *  - `themes` (default `{}`): theme objects by name, returned by `ctx.ui.getTheme`.
 *  - `toolsExpanded` (default `false`): what `ui.getToolsExpanded()` returns; `ui.setToolsExpanded` updates `state.toolsExpanded`.
 *  - `projectTrusted` (default `true`, Pi's answer for a folder with nothing to trust): what
 *   `isProjectTrusted()` returns; change it later through `state.projectTrusted`.
 *
 * Returns the ctx and the recorders it populates:
 *   `{ ctx, notifications, statuses, footers, headers, widgets, themeChanges,
 *   thinkingLabels, selectCalls, entries, compactCalls, terminalInput, overlays,
 *   editors, workingVisible, titles, lifecycle, state, pastes, autocompleteProviders }`.
 *   `pastes` records `ui.pasteToEditor` texts (appended to `state.editorText`),
 *   `autocompleteProviders` the factories passed to `ui.addAutocompleteProvider`.
 *   `editors` records `ui.setEditorComponent` factories, `workingVisible` the
 *   values passed to `ui.setWorkingVisible`, `titles` those passed to `ui.setTitle`. `terminalInput.send(data)` feeds the
 *   listeners registered with `ui.onTerminalInput` and returns true when one consumed it.
 *   `overlays` records `ui.custom` calls as `{ options, component, theme, closed }`;
 *   `lifecycle` counts `abort()` and `shutdown()` calls.
 *   `widgets` maps each `setWidget` key to `{ content, options }`.
 *
 * `ctx.ui.select` returns `undefined` by default; assign a custom impl on
 * `ctx.ui.select` if a test needs to drive the picker.
 */
export function createMockExtensionContext(options = {}) {
  const models = options.models ?? [];
  const authenticated = options.authenticated ?? true;
  const hasUI = options.hasUI ?? true;
  const entries = options.entries ?? [];
  const cwd = options.cwd ?? process.cwd();
  const getContextUsage = options.getContextUsage ?? (() => undefined);

  const notifications = [];
  const statuses = [];
  const footers = [];
  const headers = [];
  const widgets = new Map();
  const themeChanges = [];
  const thinkingLabels = [];
  const selectCalls = [];
  const themes = options.themes ?? {};
  const compactCalls = [];
  const state = {
    idle: options.idle ?? true,
    editorText: options.editorText ?? "",
    toolsExpanded: options.toolsExpanded ?? false,
    pendingMessages: false,
    projectTrusted: options.projectTrusted ?? true,
  };
  const lifecycle = { abort: 0, shutdown: 0 };
  const inputListeners = new Set();
  const terminalInput = {
    listeners: inputListeners,
    send(data) {
      for (const listener of [...inputListeners]) {
        if (listener(data)?.consume) return true;
      }
      return false;
    },
  };
  const overlays = [];
  const editors = [];
  const pastes = [];
  const autocompleteProviders = [];
  const workingVisible = [];
  const titles = [];
  const plainTheme = { fg: (_name, value) => value, bold: (value) => value, style: (value) => value, colors: {} };

  const ctx = {
    cwd,
    hasUI,
    mode: options.mode ?? (hasUI ? "tui" : "print"),
    sessionId: options.sessionId,
    sessionName: options.sessionName,
    model: options.model,
    sessionManager: {
      getEntries: () => entries,
      // The transcript group store rebuilds from the context entries at session
      // start; only entries shaped like Pi messages take part, as Pi's converter
      // reads `message.role`.
      buildContextEntries: () => entries.filter((entry) => entry?.type === "message" && typeof entry?.message?.role === "string"),
      // The entries double as the current branch, root first.
      getBranch: () => entries,
      getCwd: () => cwd,
      getSessionFile: () => options.sessionFile,
      getSessionId: () => options.sessionId,
      getSessionName: () => options.sessionName,
    },
    modelRegistry: {
      getAll: () => models,
      find: (provider, modelId) =>
        models.find((model) => model.provider === provider && model.id === modelId),
      hasConfiguredAuth: () => authenticated,
      isUsingOAuth: (model) =>
        model.provider.endsWith("subscription") || model.provider.endsWith("codex"),
    },
    getContextUsage,
    isProjectTrusted: () => state.projectTrusted,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pendingMessages,
    abort: () => {
      lifecycle.abort += 1;
    },
    shutdown: () => {
      lifecycle.shutdown += 1;
    },
    compact: (opts) => {
      compactCalls.push(opts);
    },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      onTerminalInput: (listener) => {
        inputListeners.add(listener);
        return () => inputListeners.delete(listener);
      },
      getEditorText: () => state.editorText,
      setEditorText: (text) => {
        state.editorText = text;
      },
      getToolsExpanded: () => state.toolsExpanded,
      setToolsExpanded: (expanded) => {
        state.toolsExpanded = expanded;
      },
      // Pasting appends: the stub keeps no cursor.
      pasteToEditor: (text) => {
        pastes.push(text);
        state.editorText += text;
      },
      addAutocompleteProvider: (factory) => autocompleteProviders.push(factory),
      setEditorComponent: (factory) => editors.push(factory),
      setWorkingVisible: (visible) => workingVisible.push(visible),
      setTitle: (title) => titles.push(title),
      custom: (factory, customOptions) =>
        new Promise((resolve) => {
          const record = { options: customOptions, theme: plainTheme, closed: false };
          overlays.push(record);
          record.component = factory(undefined, plainTheme, undefined, (result) => {
            record.closed = true;
            resolve(result);
          });
        }),
      setStatus: (key, value) => statuses.push({ key, value }),
      setFooter: (factory) => footers.push(factory),
      setHeader: (factory) => headers.push(factory),
      setWidget: (key, content, widgetOptions) => widgets.set(key, { content, options: widgetOptions }),
      setHiddenThinkingLabel: (label) => thinkingLabels.push(label),
      getTheme: (name) => themes[name],
      setTheme: (theme) => {
        themeChanges.push(theme);
        if (typeof theme === "object") ctx.ui.theme = theme;
        return { success: true };
      },
      select: async (title, choices) => {
        selectCalls.push({ title, options: choices });
        return undefined;
      },
      theme: { name: options.themeName, fg: (_name, value) => value, bold: (value) => value, italic: (value) => value },
    },
  };

  return {
    ctx,
    notifications,
    statuses,
    footers,
    headers,
    widgets,
    themeChanges,
    thinkingLabels,
    selectCalls,
    entries,
    compactCalls,
    terminalInput,
    overlays,
    editors,
    workingVisible,
    titles,
    lifecycle,
    state,
    pastes,
    autocompleteProviders,
  };
}

/**
 * Record ampi-core as loaded in this test process, as it is in Pi, where it
 * loads before every other part. Tests that run another extension on its own
 * call this first, so its "loaded without ampi-core" warning
 * (ampi-core/parts.ts) stays out of what they observe.
 */
export async function markAmpiCoreLoaded() {
  const { importSource } = await import("./load-src.mjs");
  const { AMPI_CORE_PART, markAmpiPartLoaded } = await importSource("extensions/ampi-core/parts.ts");
  markAmpiPartLoaded(createMockPi().pi, AMPI_CORE_PART);
}
