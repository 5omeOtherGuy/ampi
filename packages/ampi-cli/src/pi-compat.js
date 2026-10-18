// Pi surface the `ampi` command uses besides `main()`. Pi exports these
// classes but does not document them, so every call stays in this module and
// tests/mmr-cli-pi-compat.test.mjs fails when their shape changes. Pi's piped
// stdin read is not exported, so the spawn tests in
// tests/mmr-cli-execute.test.mjs are the probe for hidePipedStdinFromPi, and
// those in tests/mmr-cli-stream-json.test.mjs for capturePiJsonOutput.

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
 * Take Pi's JSON event stream (`--mode json`) off stdout and write what
 * `convert` makes of each event instead. Pi keeps the stdout write function it
 * finds when it starts and sends its JSON lines through it, so this replaces
 * that function before Pi's `main()` runs. A line that is not JSON goes to
 * stderr. The stream JSON spawn tests in tests/mmr-cli-stream-json.test.mjs
 * fail when Pi stops writing through it.
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
