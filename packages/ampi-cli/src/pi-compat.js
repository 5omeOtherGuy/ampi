// Pi surface the `ampi` command uses besides `main()`. Pi exports these
// classes but does not document them, so every call stays in this module and
// tests/mmr-cli-pi-compat.test.mjs fails when their shape changes. Pi's piped
// stdin read is not exported, so the spawn tests in
// tests/mmr-cli-execute.test.mjs are the probe for hidePipedStdinFromPi, and
// those in tests/mmr-cli-stream-json.test.mjs for capturePiJsonOutput. Pi's
// RPC mode reads process.stdin and exits the process itself, so the spawn
// tests in tests/mmr-cli-stream-json-input.test.mjs are the probe for
// feedPiRpcInput, exitWithCodeAfterPiRpc and capturePiJsonOutput in RPC mode.
// `ampi review` (review.js) relies on Pi's print mode running an extension
// command with no model turn, and on how it fails on an unknown flag; spawn
// tests in tests/mmr-cli-pi-compat.test.mjs probe both.
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
 * @typedef {object} PiSessionWriter The parts of Pi's `SessionManager` that write a new session.
 * @property {() => string} getSessionId
 * @property {() => string} getSessionFile
 * @property {(message: object) => string} appendMessage Appends a user, assistant or tool result message.
 * @property {(name: string) => string} appendSessionInfo Names the session.
 * @property {(customType: string, data: unknown) => string} appendCustomEntry
 * @property {(customType: string, content: string, display: boolean, details: unknown) => string} appendCustomMessageEntry
 *   Appends an extension message (a `custom_message` entry), shown in the session when `display` is true.
 */

/**
 * Start a new session of `cwd` in the session directory Pi uses for it (as
 * `listPiSessions` finds it), under `id` when one is given. Pi creates the
 * file with the first user or assistant message and appends every entry
 * after it; entries before it are written along with it.
 *
 * @param {any} pi
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, id?: string }} options
 * @returns {PiSessionWriter}
 */
export function createPiSessionWriter(pi, { cwd, env, id }) {
  return pi.SessionManager.create(cwd, piSessionDir(pi, cwd, env), id === undefined ? undefined : { id });
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
 * granted Pi loads them. `readOnly` reads the settings files without Pi's
 * file locks, which create a lock directory next to each settings file, and
 * lists a package source that is not installed as missing whether or not
 * PI_OFFLINE is set: the next online start installs it.
 *
 * @param {any} pi The `@earendil-works/pi-coding-agent` module.
 * @param {string} cwd
 * @param {{ readOnly?: boolean }} [options]
 * @returns {Promise<PiExtensionSources>}
 */
export async function listPiExtensionSources(pi, cwd, { readOnly = false } = {}) {
  const agentDir = pi.getAgentDir();
  const settingsManager = readOnly ? readOnlyPiSettingsManager(pi, cwd) : pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const packageManager = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager });
  /** @type {string[]} */
  const missing = [];
  const resolved = await packageManager.resolve(async (/** @type {string} */ source) => {
    missing.push(source);
    return "skip";
  });
  if (readOnly) {
    // With PI_OFFLINE set, Pi skips missing sources without asking; an online start installs them.
    /** @type {{ source: string, installedPath?: string }[]} */
    const configured = packageManager.listConfiguredPackages();
    for (const { source, installedPath } of configured) {
      if (installedPath === undefined && REMOTE_PACKAGE_SOURCE.test(source) && !missing.includes(source)) missing.push(source);
    }
  }
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

/** Package sources Pi installs itself (npm and git), as opposed to local paths. */
const REMOTE_PACKAGE_SOURCE = /^(?:npm:|git:|git@|https?:|ssh:)/;

/**
 * Pi's `SettingsManager` over the user and project settings files, reading
 * them without the lock Pi takes and never writing: a manager for reports
 * that must leave Pi's configuration directory as it is. Project settings are
 * read as if the project were trusted.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {any}
 */
function readOnlyPiSettingsManager(pi, cwd) {
  /** @type {Record<string, string>} */
  const files = { global: piSettingsPath(pi, cwd, "user"), project: piSettingsPath(pi, cwd, "project") };
  const storage = {
    withLock: (/** @type {string} */ scope, /** @type {(current: string | undefined) => unknown} */ fn) => {
      /** @type {string | undefined} */
      let current;
      try {
        current = readFileSync(files[scope], "utf8");
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
      }
      fn(current);
    },
  };
  return pi.SettingsManager.fromStorage(storage, { projectTrusted: true });
}

/**
 * The settings files Pi cannot load in `cwd`, read as Pi reads them (without
 * writing anything): the user settings and the project's, whether or not Pi
 * trusts the project. A JSON error names its line and column but never quotes
 * the file.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {{ scope: "user" | "project", path: string, message: string }[]}
 */
export function readPiSettingsErrors(pi, cwd) {
  /** @type {{ scope: "global" | "project", error: Error }[]} */
  const errors = readOnlyPiSettingsManager(pi, cwd).drainErrors();
  return errors.map(({ scope, error }) => {
    const where = /line (\d+) column (\d+)/.exec(error.message);
    const message =
      error instanceof SyntaxError ? (where ? `invalid JSON at line ${where[1]}, column ${where[2]}` : "invalid JSON") : error.message;
    const which = scope === "global" ? "user" : "project";
    return { scope: which, path: piSettingsPath(pi, cwd, which), message };
  });
}

/**
 * The directory Pi keeps the `fd` and `rg` it downloads in, and looks in
 * before PATH: `bin` in its configuration directory. Pi does not export its
 * own function for it from the package root.
 *
 * @param {any} pi
 * @returns {string}
 */
export function piBinDir(pi) {
  return path.join(pi.getAgentDir(), "bin");
}

/**
 * How many models Pi's catalogue offers with credentials, and from how many
 * providers: credentials in Pi's `auth.json` or a provider's environment
 * variable, as Pi checks them. Offline whatever PI_OFFLINE says, and read
 * only: `auth.json` is read once without Pi's lock, an OAuth token counts as
 * it is stored (it is never refreshed), and a key given as a `!command` counts
 * without the command being run. Pi's own credential store would run it.
 * Models that only an extension registers are not counted.
 *
 * @param {any} pi
 * @returns {Promise<{ models: number, providers: number }>}
 */
export async function countPiCredentialedModels(pi) {
  const file = path.join(pi.getAgentDir(), "auth.json");
  /** @type {Record<string, { type: string, key?: unknown }>} */
  let stored = {};
  /** @type {string} */
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
  if (text.trim() !== "") {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      // JSON.parse quotes the text around an error, which may be a key.
      throw new Error(`${file} is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} does not hold an object`);
    stored = /** @type {typeof stored} */ (parsed);
  }
  const credentials = {
    read: async (/** @type {string} */ providerId) => {
      const credential = Object.hasOwn(stored, providerId) ? stored[providerId] : undefined;
      if (credential === null || typeof credential !== "object") return undefined;
      if (credential.type === "api_key" && typeof credential.key === "string" && credential.key.startsWith("!")) {
        return { ...credential, key: "(command not run)" };
      }
      return credential;
    },
    list: async () => Object.entries(stored).map(([providerId, credential]) => ({ providerId, type: credential?.type })),
    modify: async () => {
      throw new Error("the credential store is read only here");
    },
    delete: async () => {
      throw new Error("the credential store is read only here");
    },
  };
  const runtime = await pi.ModelRuntime.create({ credentials, allowModelNetwork: false, refreshOnCreate: false });
  // Without a refresh on create, the availability snapshot (ModelRegistry.getAvailable) starts empty; this call fills it.
  /** @type {{ provider: string }[]} */
  const available = await runtime.getAvailable();
  return { models: available.length, providers: new Set(available.map((model) => model.provider)).size };
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
 * reads them, a resource loader that also loads `extensionPaths` and
 * `extensionFactories`, and `flagValues` as the values of extension flags
 * (as `--<name> <value>` sets them on Pi's command line). Pi's SDK
 * documentation covers neither the `resourceLoaderOptions` and
 * `extensionFlagValues` of createAgentSessionServices nor the loader's
 * `getExtensions().errors`, so the returned diagnostics carry each extension
 * that failed to load as an error next to Pi's own diagnostics.
 *
 * @param {any} pi
 * @param {{ cwd: string, agentDir: string, extensionPaths: string[], extensionFactories: unknown[], flagValues?: Map<string, string> }} options
 * @returns {Promise<{ services: any, diagnostics: { type: string, message: string }[] }>} Pi's
 *   `AgentSessionServices` and the diagnostics.
 */
export async function createPiSessionServices(pi, { cwd, agentDir, extensionPaths, extensionFactories, flagValues }) {
  const services = await pi.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: piSettingsManager(pi, cwd),
    extensionFlagValues: flagValues,
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

/**
 * @typedef {{ builtin: string } | { file: string, packageRoot?: string, packageSource?: string }} PiToolOrigin
 *   Where a tool comes from: a Pi built-in by name (`read`, or `mcp` for the built-in MCP extension),
 *   or the extension file that registered it, with its package's root and settings source when it
 *   came from a package.
 */

/**
 * Where Pi says a tool comes from, read from its `ToolInfo.sourceInfo`: Pi's
 * own tools and built-in extensions have the path `builtin:<name>`, inline
 * extensions `<inline:name>`, and extension files their absolute path.
 *
 * @param {{ sourceInfo?: { path: string, source: string, origin: string, baseDir?: string } }} info
 * @returns {PiToolOrigin}
 */
export function piToolOrigin(info) {
  const source = info.sourceInfo;
  if (source === undefined) return { file: "" };
  if (source.path.startsWith("builtin:")) return { builtin: source.path.slice("builtin:".length) };
  const synthetic = /^<[^:>]+:([^>]*)>$/.exec(source.path);
  if (synthetic) return { file: synthetic[1] };
  return source.origin === "package"
    ? { file: source.path, packageRoot: source.baseDir, packageSource: source.source }
    : { file: source.path };
}

/**
 * Whether Pi trusts the project in `cwd`, decided as piSettingsManager does.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {boolean}
 */
export function isPiProjectTrusted(pi, cwd) {
  return piSettingsManager(pi, cwd).isProjectTrusted();
}

/**
 * @typedef {object} PiSkill The parts of Pi's `Skill` the skill commands read.
 * @property {string} name
 * @property {string} description
 * @property {string} filePath The skill's `SKILL.md` (or Markdown file).
 * @property {string} baseDir The skill's directory.
 * @property {import("./skill-sources.js").PiSkillSourceInfo} sourceInfo
 * @property {boolean} disableModelInvocation
 *
 * @typedef {{ path: string, message: string }} PiSkillProblem A skill file Pi did not load as it is,
 *   and why: a name collision, invalid frontmatter, a missing description.
 */

/**
 * The skills a session loaded (its resource loader's, after extensions added
 * their folders) and the problems Pi reported while loading them. A name
 * collision is reported on the skill that lost, naming the one Pi kept.
 *
 * @param {any} session Pi's `AgentSession`.
 * @returns {{ skills: PiSkill[], problems: PiSkillProblem[] }}
 */
export function readPiSessionSkills(session) {
  /** @type {{ skills: PiSkill[], diagnostics: { message: string, path?: string, collision?: { name: string, winnerPath: string, loserPath: string } }[] }} */
  const { skills, diagnostics } = session.resourceLoader.getSkills();
  const problems = diagnostics.map(({ message, path: file, collision }) =>
    collision
      ? { path: collision.loserPath, message: `another skill named "${collision.name}" is loaded from ${collision.winnerPath}` }
      : { path: file ?? "", message },
  );
  return { skills, problems };
}

/**
 * The frontmatter of a `SKILL.md` text, parsed as Pi parses it. Throws when
 * the YAML is malformed.
 *
 * @param {any} pi
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parsePiFrontmatter(pi, text) {
  return pi.parseFrontmatter(text).frontmatter;
}

/**
 * Check a skill directory (one holding `SKILL.md`) with Pi's own loader: the
 * name Pi would load it under, if it loads it at all, and every warning Pi
 * raises about it (a missing description, a name outside Pi's rules, YAML it
 * cannot parse).
 *
 * @param {any} pi
 * @param {string} dir
 * @returns {{ name: string | undefined, problems: string[] }}
 */
export function checkPiSkillDir(pi, dir) {
  /** @type {{ skills: PiSkill[], diagnostics: { message: string }[] }} */
  const { skills, diagnostics } = pi.loadSkillsFromDir({ dir, source: "path" });
  return { name: skills[0]?.name, problems: diagnostics.map((diagnostic) => diagnostic.message) };
}

/**
 * The names of the MCP servers Pi's MCP extension would connect in `cwd`:
 * the enabled servers of `mcp.json` in Pi's configuration directory and, when
 * the project is trusted, of the project's `.pi/mcp.json` (Pi's docs/mcp.md).
 * A project entry with neither `command`, `url` nor `type` only overrides
 * settings such as `enabled` of the user server with that name.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {string[]}
 */
export function listPiMcpServers(pi, cwd) {
  /** @type {Map<string, Record<string, unknown>>} */
  const servers = new Map();
  const files = [path.join(pi.getAgentDir(), "mcp.json")];
  if (piSettingsManager(pi, cwd).isProjectTrusted()) files.push(path.join(cwd, pi.CONFIG_DIR_NAME, "mcp.json"));
  for (const [index, file] of files.entries()) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")).mcpServers;
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    for (const [name, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== "object") continue;
      const override = index > 0 && !("command" in value || "url" in value || "type" in value);
      const base = servers.get(name);
      if (override && base === undefined) continue;
      servers.set(name, override ? { ...base, ...value } : value);
    }
  }
  return [...servers].filter(([, config]) => config.enabled !== false).map(([name]) => name);
}

/**
 * @typedef {object} PiMcpServerReport One server of `pi mcp list --json`, as the mcp commands read it.
 * @property {string} name
 * @property {string} scope `global` (Pi's configuration directory) or `project`.
 * @property {string} source The `mcp.json` file the server's configuration comes from.
 * @property {boolean} enabled
 * @property {"stdio" | "http"} kind How Pi talks to the server: a local command or a streamable HTTP URL.
 * @property {string} transport The command line, or the URL.
 * @property {string} state `connected`, `needs-auth`, `failed`, `disabled` or another connection state.
 * @property {string[]} tools The names of the server's tools, once connected.
 * @property {string} [error] Why the server is not connected.
 *
 * @typedef {object} PiMcpList What `pi mcp list --json` prints.
 * @property {PiMcpServerReport[]} servers
 * @property {string[]} errors Invalid entries Pi skipped.
 * @property {string} [note] Pi's note that the project's `mcp.json` is ignored because the project is not trusted.
 */

/**
 * Read the output of `pi mcp list --json`, in which Pi has connected every
 * enabled server. Throws when the text is not that shape.
 *
 * @param {string} text
 * @returns {PiMcpList}
 */
export function parsePiMcpList(text) {
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.servers) || !Array.isArray(parsed.errors)) {
    throw new Error("expected { servers: [...], errors: [...] }");
  }
  const servers = parsed.servers.map((/** @type {any} */ server) => {
    if (typeof server?.name !== "string" || typeof server.state !== "string" || typeof server.transport !== "string" || !Array.isArray(server.tools)) {
      throw new Error("expected each server to have a name, a state, a transport and tools");
    }
    return {
      name: server.name,
      scope: String(server.scope ?? "global"),
      source: String(server.source ?? ""),
      enabled: server.enabled !== false,
      // Pi describes an HTTP server by its URL and a stdio server by its command line.
      kind: /** @type {"stdio" | "http"} */ (/^https?:\/\//i.test(server.transport) ? "http" : "stdio"),
      transport: server.transport,
      state: server.state,
      tools: server.tools.map(String),
      ...(typeof server.error === "string" ? { error: server.error } : {}),
    };
  });
  return { servers, errors: parsed.errors.map(String), ...(typeof parsed.note === "string" ? { note: parsed.note } : {}) };
}

/**
 * Whether Pi signs in to the server with OAuth: an HTTP server whose
 * configuration (in the file `pi mcp list` names as its source) sets neither
 * an `Authorization` header nor `auth`. A configuration that cannot be read
 * counts as OAuth, as Pi's default for HTTP servers. The probe in
 * tests/mmr-cli-pi-compat.test.mjs checks this against `pi mcp logout`.
 *
 * @param {PiMcpServerReport} server
 * @returns {boolean}
 */
export function piMcpUsesOAuth(server) {
  if (server.kind !== "http") return false;
  /** @type {any} */
  let config;
  try {
    config = JSON.parse(readFileSync(server.source, "utf8")).mcpServers?.[server.name];
  } catch {
    return true;
  }
  if (config === null || typeof config !== "object") return true;
  if (config.auth !== undefined) return false;
  const headers = config.headers !== null && typeof config.headers === "object" ? Object.keys(config.headers) : [];
  return !headers.some((header) => header.toLowerCase() === "authorization");
}

/**
 * The project's MCP configuration file, `.pi/mcp.json` in `cwd`.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {string}
 */
export function piProjectMcpPath(pi, cwd) {
  return path.join(cwd, pi.CONFIG_DIR_NAME, "mcp.json");
}

/**
 * The saved project-trust decision that applies to `cwd`: the closest one
 * for it or a parent directory in Pi's trust store, and the directory it was
 * saved for. `decision` is null when there is none.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {{ decision: boolean | null, path?: string }}
 */
export function readPiProjectTrust(pi, cwd) {
  /** @type {{ path: string, decision: boolean } | null} */
  const entry = new pi.ProjectTrustStore(pi.getAgentDir()).getEntry(cwd);
  return entry === null ? { decision: null } : { decision: entry.decision, path: entry.path };
}

/**
 * Save "trusted" for `cwd` in Pi's trust store: the record Pi's own trust
 * prompt writes when you choose to trust a folder.
 *
 * @param {any} pi
 * @param {string} cwd
 */
export function trustPiProject(pi, cwd) {
  new pi.ProjectTrustStore(pi.getAgentDir()).set(cwd, true);
}

/** The entries of a project's `.pi` directory that Pi loads only in a trusted project (Pi's docs/security.md). */
const PI_TRUST_RESOURCES = ["settings.json", "mcp.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"];

/**
 * The project resources in `cwd` that Pi loads only once the project is
 * trusted: the entries of its `.pi` directory, and `.agents/skills` in `cwd`
 * and its parents (except `~/.agents/skills`, which is the user's). The list
 * is non-empty exactly when Pi's `hasTrustRequiringProjectResources` is true;
 * the probe in tests/mmr-cli-pi-compat.test.mjs checks each entry.
 *
 * @param {any} pi
 * @param {string} cwd
 * @returns {string[]}
 */
export function listPiTrustResources(pi, cwd) {
  /** @param {string} dir Pi compares real paths. */
  const canonical = (dir) => {
    try {
      return realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  };
  const start = canonical(cwd);
  const configDir = path.join(start, pi.CONFIG_DIR_NAME);
  const found = PI_TRUST_RESOURCES.map((entry) => path.join(configDir, entry)).filter((file) => existsSync(file));
  const userSkills = path.join(canonical(process.env.HOME || homedir()), ".agents", "skills");
  for (let dir = start; ; dir = path.dirname(dir)) {
    const skills = path.join(dir, ".agents", "skills");
    if (skills !== userSkills && existsSync(skills)) found.push(skills);
    if (path.dirname(dir) === dir) break;
  }
  return found;
}

/**
 * Pi's current theme, which `ctx.ui.theme` is in Pi's own modes. Pi keeps
 * it on a global under this symbol and exports no getter for it; it is
 * `undefined` until Pi's `initTheme` has run.
 *
 * @returns {unknown}
 */
export function piTheme() {
  return /** @type {Record<symbol, unknown>} */ (globalThis)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
}

/**
 * @typedef {object} PiInputTerminal The terminal in the input mode of Pi's terminal UI, for `ampi dev keys`.
 * @property {(onInput: (chunk: string) => void) => void} start Put the terminal into that mode (raw
 *   mode, bracketed paste, and the kitty keyboard protocol or modifyOtherKeys, whichever the terminal
 *   answers for) and hand `onInput` one key sequence or one bracketed paste at a time. The terminal's
 *   replies to the protocol queries are not handed on.
 * @property {(maxMs: number) => Promise<void>} drain Turn the keyboard protocols off and swallow what
 *   arrives for up to `maxMs`, so late key-release reports do not reach the shell.
 * @property {() => void} stop Turn bracketed paste and the keyboard protocols off, pause stdin and
 *   restore its earlier raw mode.
 */

/**
 * Pi's terminal (`ProcessTerminal` of pi-tui), reduced to its input: no
 * rendering and no resize handling. It writes the mode sequences to
 * `process.stdout` and reads `process.stdin`, so both must be the terminal.
 *
 * @param {any} tui The `@earendil-works/pi-tui` module.
 * @returns {PiInputTerminal}
 */
export function createPiInputTerminal(tui) {
  const terminal = new tui.ProcessTerminal();
  return {
    start: (onInput) => terminal.start(onInput, () => {}),
    drain: (maxMs) => terminal.drainInput(maxMs),
    stop: () => terminal.stop(),
  };
}

/**
 * Split input that does not come from a terminal into the chunks Pi's
 * terminal hands on: one key sequence at a time (`\x18t\x1b\x1b` is `\x18`,
 * `t` and `\x1b\x1b`), and a bracketed paste as one chunk with its markers.
 * pi-tui's `StdinBuffer` does the splitting, as in `ProcessTerminal`.
 *
 * @param {any} tui The `@earendil-works/pi-tui` module.
 * @param {(chunk: string) => void} onChunk
 * @returns {{ write: (data: string) => void, end: () => void }} `write` takes the next input; `end`
 *   hands on what is still buffered and releases the buffer's timer.
 */
export function createPiInputSplitter(tui, onChunk) {
  const buffer = new tui.StdinBuffer();
  buffer.on("data", (/** @type {string} */ sequence) => {
    if (sequence !== "") onChunk(sequence);
  });
  buffer.on("paste", (/** @type {string} */ text) => onChunk(`\x1b[200~${text}\x1b[201~`));
  return {
    write: (data) => buffer.process(data),
    end: () => {
      /** @type {string[]} */
      const rest = buffer.flush();
      buffer.destroy();
      for (const sequence of rest) onChunk(sequence);
    },
  };
}
