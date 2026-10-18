// Pi surface the `ampi` command uses besides `main()`. Pi exports these
// classes but does not document them, so every call stays in this module and
// tests/mmr-cli-pi-compat.test.mjs fails when their shape changes.

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
