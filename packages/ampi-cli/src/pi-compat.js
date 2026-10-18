// Pi surface the `ampi` command uses besides `main()`. Pi exports these
// classes but does not document them, so every call stays in this module and
// tests/mmr-cli-pi-compat.test.mjs fails when their shape changes. Pi's piped
// stdin read is not exported, so the spawn tests in
// tests/mmr-cli-execute.test.mjs are the probe for hidePipedStdinFromPi, and
// those in tests/mmr-cli-stream-json.test.mjs for capturePiJsonOutput. Pi's
// RPC mode reads process.stdin and exits the process itself, so the spawn
// tests in tests/mmr-cli-stream-json-input.test.mjs are the probe for
// feedPiRpcInput, exitWithCodeAfterPiRpc and capturePiJsonOutput in RPC mode.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * @typedef {object} PiSessionInfo The parts of Pi's `SessionInfo` the `ampi` command reads.
 * @property {string} path
 * @property {string} id
 * @property {string} cwd
 * @property {string} [name]
 * @property {string} [parentSessionPath]
 * @property {Date} created
 * @property {Date} modified Last activity.
 * @property {number} messageCount
 * @property {string} firstMessage
 */

/**
 * Pi's configuration directory (`PI_CODING_AGENT_DIR`, else Pi's default).
 *
 * @param {any} pi The `@earendil-works/pi-coding-agent` module.
 * @returns {string}
 */
export function piAgentDir(pi) {
  return pi.getAgentDir();
}

/**
 * The session directory Pi uses, from `PI_CODING_AGENT_SESSION_DIR` or the
 * `sessionDir` setting, in Pi's order; `undefined` for Pi's default layout.
 *
 * @param {any} pi
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function piSessionDir(pi, cwd, env) {
  const fromEnv = env.PI_CODING_AGENT_SESSION_DIR;
  if (fromEnv) return fromEnv === "~" || fromEnv.startsWith("~/") ? path.join(homedir(), fromEnv.slice(1)) : fromEnv;
  return pi.SettingsManager.create(cwd, pi.getAgentDir()).getSessionDir();
}

/**
 * The sessions Pi would offer to resume: those of `cwd`, or of every directory.
 * A session id can appear more than once (a copied file).
 *
 * @param {any} pi
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, scope: "workspace" | "all" }} options
 * @returns {Promise<PiSessionInfo[]>}
 */
export async function listPiSessions(pi, { cwd, env, scope }) {
  const { SessionManager } = pi;
  const sessionDir = piSessionDir(pi, cwd, env);
  if (scope === "workspace") return SessionManager.list(cwd, sessionDir);
  // A directory directly in <agentDir>/sessions is Pi's own layout: list every directory there.
  const usesDefault = sessionDir === undefined || path.dirname(path.resolve(sessionDir)) === path.resolve(pi.getAgentDir(), "sessions");
  return usesDefault ? SessionManager.listAll() : SessionManager.listAll(sessionDir);
}

/**
 * Set a session's name (a `session_info` entry appended to its file).
 *
 * @param {any} pi
 * @param {string} file
 * @param {string} name
 */
export function setPiSessionName(pi, file, name) {
  pi.SessionManager.open(file).appendSessionInfo(name);
}

/**
 * A session's entries without its header, as Pi reads them: older file
 * versions are migrated first, in memory only. Opening the file through
 * `SessionManager.open` would write the migrated entries back to it, and the
 * reports never write to a session.
 *
 * @param {any} pi
 * @param {string} file
 * @returns {unknown[]}
 */
export function readPiSessionEntries(pi, file) {
  /** @type {{ type: string }[]} */
  const entries = pi.parseSessionEntries(readFileSync(file, "utf8"));
  pi.migrateSessionEntries(entries);
  return entries.filter((entry) => entry.type !== "session");
}

/**
 * @typedef {object} PiModelInfo What the commands read of a model in Pi's registry.
 * @property {string} [name] Display name.
 * @property {number} [contextWindow] Tokens.
 * @property {{ input: number, output: number, cacheRead: number, cacheWrite: number }} [cost] Dollars per
 *   million tokens; all zero when Pi has no price.
 */

/** A credential store that holds nothing, so building the registry never reads or writes credentials. */
const NO_CREDENTIALS = {
  read: async () => undefined,
  list: async () => [],
  modify: async () => undefined,
  delete: async () => {},
};

/**
 * Look models up in Pi's model registry: its built-in catalogue and the
 * models of `models.json` in Pi's configuration directory. Offline whatever
 * PI_OFFLINE says: the registry is built without credentials, without a
 * catalogue refresh and without network access, so nothing authenticates or
 * calls a model. Models that only an extension registers, or only a
 * refreshed catalogue lists, are unknown here.
 *
 * @param {any} pi
 * @returns {Promise<(provider: string, model: string) => PiModelInfo | undefined>}
 */
export async function createPiModelLookup(pi) {
  const runtime = await pi.ModelRuntime.create({ credentials: NO_CREDENTIALS, allowModelNetwork: false, refreshOnCreate: false });
  const registry = new pi.ModelRegistry(runtime);
  return (provider, model) => {
    /** @type {{ name?: string, contextWindow?: number, cost?: PiModelInfo["cost"] } | undefined} */
    const found = registry.find(provider, model);
    return found === undefined ? undefined : { name: found.name, contextWindow: found.contextWindow, cost: found.cost };
  };
}

/**
 * @typedef {object} PiExtensionSources
 * @property {{ path: string, source: string }[]} enabled Extension entries Pi loads from its user and
 *   project settings (`packages` and `extensions`) and its extension directories.
 * @property {string[]} missing Package sources in the settings that are not installed yet; Pi installs
 *   them when it starts.
 * @property {(source: string) => string | undefined} cachedPathOf Where Pi keeps a `-e` package source
 *   between runs, when it is there.
 */

/**
 * What Pi will load besides `-e` arguments, read without installing anything.
 * Project settings are read as if the project were trusted: once trust is
 * granted Pi loads them.
 *
 * @param {any} pi The `@earendil-works/pi-coding-agent` module.
 * @param {string} cwd
 * @returns {Promise<PiExtensionSources>}
 */
export async function listPiExtensionSources(pi, cwd) {
  const agentDir = pi.getAgentDir();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const packageManager = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager });
  /** @type {string[]} */
  const missing = [];
  const resolved = await packageManager.resolve(async (/** @type {string} */ source) => {
    missing.push(source);
    return "skip";
  });
  /** @type {{ path: string, enabled: boolean, metadata: { source: string, origin: string } }[]} */
  const extensions = resolved.extensions;
  return {
    // A package names its settings source; a file or directory entry names itself.
    enabled: extensions
      .filter((entry) => entry.enabled)
      .map((entry) => ({ path: entry.path, source: entry.metadata.origin === "package" ? entry.metadata.source : entry.path })),
    missing,
    cachedPathOf: (source) => {
      try {
        return packageManager.getInstalledPath(source, "temporary");
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Stop Pi from reading stdin after execute mode has read it. Pi reads piped
 * stdin into the first message whenever `process.stdin.isTTY` is not true; on
 * a stream that has already been read to its end it would never see the end
 * and send nothing. tests/mmr-cli-execute.test.mjs pipes stdin through the
 * command and fails when this stops working.
 */
export function hidePipedStdinFromPi() {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
}

/**
 * Give Pi's RPC mode (`--mode rpc`) commands from this process instead of
 * stdin. RPC mode reads its commands from `process.stdin` when it starts and
 * shuts the session down when that stream ends, so this puts a stream the
 * caller writes to in its place before Pi's `main()` runs. Read the real stdin
 * before calling it: afterwards `process.stdin` is the new stream.
 *
 * @returns {{ send: (command: Record<string, unknown>) => void, end: () => void }} `send` writes one
 *   command as a JSON line; `end` ends Pi's input.
 */
export function feedPiRpcInput() {
  const input = new PassThrough();
  Object.defineProperty(process, "stdin", { value: input, configurable: true, writable: true });
  return {
    send: (command) => {
      input.write(`${JSON.stringify(command)}\n`);
    },
    end: () => {
      input.end();
    },
  };
}

/**
 * Exit with `exitCode()` when Pi's RPC mode ends the process. Once its input
 * ends, RPC mode disposes the session and calls `process.exit(0)` itself, so
 * no code after its `main()` runs; this replaces that 0. Any other exit code
 * (Pi failing on its own) stays.
 *
 * @param {() => number} exitCode
 */
export function exitWithCodeAfterPiRpc(exitCode) {
  process.on("exit", (code) => {
    if (code === 0) process.exitCode = exitCode();
  });
}

/**
 * Take Pi's JSON event stream (`--mode json`), or the records of its RPC mode
 * (`--mode rpc`), off stdout and write what `convert` makes of each one
 * instead. Pi keeps the stdout write function it finds when it starts and
 * sends its JSON lines through it, so this replaces that function before Pi's
 * `main()` runs. A line that is not JSON goes to stderr. The stream JSON spawn
 * tests in tests/mmr-cli-stream-json.test.mjs and
 * tests/mmr-cli-stream-json-input.test.mjs fail when Pi stops writing through it.
 *
 * @param {(event: any) => string} convert Text to write for one Pi event; may be empty.
 * @returns {{ write: (text: string) => Promise<void>, restore: () => void }} `write` writes to the real
 *   stdout; `restore` puts stdout back.
 */
export function capturePiJsonOutput(convert) {
  const stdout = process.stdout;
  const original = stdout.write;
  const write = original.bind(stdout);
  let pending = "";
  stdout.write = /** @type {any} */ (
    (/** @type {unknown} */ chunk, /** @type {unknown} */ encodingOrCallback, /** @type {unknown} */ callback) => {
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      const lines = (pending + String(chunk)).split("\n");
      pending = lines.pop() ?? "";
      let text = "";
      for (const line of lines.map((raw) => raw.replace(/\r$/, ""))) {
        if (line === "") continue;
        /** @type {unknown} */
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          process.stderr.write(`${line}\n`);
          continue;
        }
        text += convert(event);
      }
      if (text !== "") return write(text, /** @type {any} */ (done));
      if (typeof done === "function") process.nextTick(done);
      return true;
    }
  );
  return {
    write: (text) => new Promise((resolve, reject) => write(text, (error) => (error ? reject(error) : resolve()))),
    restore: () => {
      stdout.write = original;
    },
  };
}

/**
 * Pi's settings for `cwd`, with the project's settings read only when Pi would
 * read them: the project has nothing that needs trust, its stored trust
 * decision is yes, or there is none and the user setting
 * `defaultProjectTrust` is `"always"`. Pi asks first when the setting is
 * `"ask"`, which counts as not trusted here. An extension can also decide
 * trust through Pi's `project_trust` event; that needs the extensions loaded,
 * so it is not followed here. createPiSessionServices hands it to SDK sessions.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {any} Pi's `SettingsManager`.
 */
export function piSettingsManager(pi, cwd) {
  const agentDir = pi.getAgentDir();
  /** @type {boolean | null} */
  const decision = new pi.ProjectTrustStore(agentDir).get(cwd);
  const projectTrusted =
    !pi.hasTrustRequiringProjectResources(cwd) ||
    (decision ?? pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always");
  return pi.SettingsManager.create(cwd, agentDir, { projectTrusted });
}

/**
 * Services for an SDK session in `cwd`: Pi's settings as piSettingsManager
 * reads them, and a resource loader that also loads `extensionPaths` and
 * `extensionFactories`. Pi's SDK documentation covers neither the
 * `resourceLoaderOptions` of createAgentSessionServices nor the loader's
 * `getExtensions().errors`, so the returned diagnostics carry each extension
 * that failed to load as an error next to Pi's own diagnostics.
 *
 * @param {any} pi
 * @param {{ cwd: string, agentDir: string, extensionPaths: string[], extensionFactories: unknown[] }} options
 * @returns {Promise<{ services: any, diagnostics: { type: string, message: string }[] }>} Pi's
 *   `AgentSessionServices` and the diagnostics.
 */
export async function createPiSessionServices(pi, { cwd, agentDir, extensionPaths, extensionFactories }) {
  const services = await pi.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: piSettingsManager(pi, cwd),
    resourceLoaderOptions: { additionalExtensionPaths: extensionPaths, extensionFactories },
  });
  /** @type {{ path: string, error: string }[]} */
  const errors = services.resourceLoader.getExtensions().errors;
  return {
    services,
    diagnostics: [
      ...services.diagnostics,
      ...errors.map(({ path: file, error }) => ({ type: "error", message: `Failed to load extension "${file}": ${error}` })),
    ],
  };
}

/**
 * The settings Pi runs with in `cwd`: user and project settings merged, as an
 * extension's `pi.getSettings()` returns them.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {unknown}
 */
export function readPiSettings(pi, cwd) {
  return piSettingsManager(pi, cwd).getSettings();
}

/**
 * The command Pi opens its external editor with: the `externalEditor`
 * setting, else `$VISUAL`, else `$EDITOR`, else Pi's platform default.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {string}
 */
export function piExternalEditorCommand(pi, cwd) {
  return piSettingsManager(pi, cwd).getExternalEditorCommand();
}

/**
 * Pi's settings file: the user settings in Pi's configuration directory, or
 * the project's in `cwd`.
 *
 * @param {any} pi
 * @param {string} cwd
 * @param {"user" | "project"} scope
 * @returns {string}
 */
export function piSettingsPath(pi, cwd, scope) {
  return scope === "project" ? path.join(cwd, pi.CONFIG_DIR_NAME, "settings.json") : path.join(pi.getAgentDir(), "settings.json");
}

/**
 * Load one TypeScript file through Pi's extension loader, the only way to
 * import ampi's TypeScript, and return what its factory emits on `channel` of
 * Pi's event bus. Pi also looks for extension directories under the working
 * and configuration directories it is given; this module's directory has
 * none, so only `file` loads.
 *
 * @param {any} pi
 * @param {string} file
 * @param {string} channel
 * @returns {Promise<unknown>}
 */
export async function loadThroughPi(pi, file, channel) {
  const events = pi.createEventBus();
  /** @type {unknown} */
  let received;
  events.on(channel, (/** @type {unknown} */ data) => {
    received = data;
  });
  const here = path.dirname(fileURLToPath(import.meta.url));
  /** @type {{ errors: { error: string }[] }} */
  const result = await pi.discoverAndLoadExtensions([file], here, here, events);
  if (result.errors.length > 0) throw new Error(result.errors[0].error);
  return received;
}
