// ampi's parts: the extensions of the ampi package a user can choose between,
// and how a choice becomes the extension filter of the ampi entry in Pi's
// settings. Pure: reads and writes nothing, so `ampi setup` and `ampi doctor`
// share it and every rule is testable without Pi.
//
// The list of parts comes from the `pi.extensions` of the ampi package that
// is installed, so a newer ampi's parts are offered even when this command
// does not describe them yet. Pi's package filter (docs/packages.md, "Select
// package resources") does the rest: `+path` loads one extension of the
// package, `-path` leaves it out, the same entries `pi config` writes.

/** The part every other part needs. */
export const CORE_PART = "core";

/**
 * What this command knows about each part, by name. `requires` lists the
 * parts it cannot work without; a part that only works better with another
 * says so in its summary instead.
 *
 * @type {Readonly<Record<string, { summary: string, requires?: readonly string[] }>>}
 */
export const PART_INFO = Object.freeze({
  core: { summary: "Modes, model routing, /mode and /ampi-status; every other part needs it" },
  "session-fallback": { summary: "Classifies quota, rate-limit and overload errors and offers a fallback route" },
  patch: { summary: "apply_patch editing" },
  shell: { summary: "Background shell tools: shell_command, shell_command_status, shell_command_kill" },
  tasks: { summary: "The task_list planning widget and ask_user_choice" },
  web: { summary: "web_search and read_web_page; off until you enable it" },
  painter: { summary: "The painter image tool; off until you enable it" },
  github: { summary: "Read-only GitHub tools, which librarian needs; off until you enable it" },
  workers: { summary: "Subagents (finder, oracle, librarian, Task, reviewer, view_media), background tasks, ampi review" },
  "custom-subagents": { summary: "Markdown sa__* subagents", requires: ["workers"] },
  permissions: { summary: "Rules that allow, reject or ask about tool calls; off until you enable it" },
  tui: { summary: "ampi's terminal look and keys" },
  threads: { summary: "Thread index, titles and archive commands" },
  gui: { summary: "Local web GUI for a session, and what ampi app serves; off until you enable it" },
  history: { summary: "read_session and find_session over your past sessions; off until you enable it" },
});

/**
 * @typedef {object} AmpiPart
 * @property {string} name The part's name, such as `web`.
 * @property {string} extension The extension's directory name, such as `ampi-web`.
 * @property {string} entry The entry file relative to the package root, as Pi's filter patterns name it.
 * @property {string} summary
 * @property {readonly string[]} requires
 *
 * @typedef {string | { source: string, extensions?: string[], autoload?: boolean, [key: string]: unknown }} PiPackageEntry
 */

/**
 * The parts of an ampi package, in its load order.
 *
 * @param {unknown} manifest The package's `package.json`.
 * @returns {AmpiPart[]}
 */
export function listAmpiParts(manifest) {
  const entries = /** @type {any} */ (manifest)?.pi?.extensions;
  if (!Array.isArray(entries)) return [];
  /** @type {AmpiPart[]} */
  const parts = [];
  for (const raw of entries) {
    if (typeof raw !== "string") continue;
    const entry = raw.replace(/^\.\//, "");
    const extension = /(?:^|\/)extensions\/([^/]+)\/[^/]+$/.exec(entry)?.[1];
    if (extension === undefined) continue;
    const name = extension.replace(/^ampi-/, "");
    const info = PART_INFO[name];
    parts.push({ name, extension, entry, summary: info?.summary ?? "", requires: info?.requires ?? [] });
  }
  return parts;
}

/**
 * Read part names as the user typed them: `web`, `ampi-web`, comma or space
 * separated.
 *
 * @param {readonly string[]} values
 * @param {readonly AmpiPart[]} parts
 * @returns {{ names: string[] } | { error: string }}
 */
export function parsePartNames(values, parts) {
  /** @type {string[]} */
  const names = [];
  for (const word of values.flatMap((value) => value.split(/[\s,]+/)).filter((word) => word !== "")) {
    const part = parts.find((candidate) => candidate.name === word || candidate.extension === word);
    if (part === undefined) return { error: `unknown part "${word}"; the parts are ${parts.map((candidate) => candidate.name).join(", ")}.` };
    if (!names.includes(part.name)) names.push(part.name);
  }
  return { names };
}

/**
 * Complete a choice: core is always on, and every part a chosen part
 * requires is turned on with it.
 *
 * @param {Iterable<string>} chosen
 * @param {readonly AmpiPart[]} parts
 * @returns {{ selected: Set<string>, added: { name: string, by: string }[] }} `added`: what was turned on
 *   because something else needs it.
 */
export function completeSelection(chosen, parts) {
  const known = new Set(parts.map((part) => part.name));
  const selected = new Set([...chosen].filter((name) => known.has(name)));
  /** @type {{ name: string, by: string }[]} */
  const added = [];
  if (known.has(CORE_PART) && !selected.has(CORE_PART)) selected.add(CORE_PART);
  for (let changed = true; changed; ) {
    changed = false;
    for (const part of parts) {
      if (!selected.has(part.name)) continue;
      for (const needed of part.requires) {
        if (!known.has(needed) || selected.has(needed)) continue;
        selected.add(needed);
        added.push({ name: needed, by: part.name });
        changed = true;
      }
    }
  }
  return { selected, added };
}

/**
 * Problems of a selection that is already in effect, for `ampi doctor`: core
 * off while other parts load, or a part on without one it requires.
 *
 * @param {ReadonlySet<string>} selected
 * @param {readonly AmpiPart[]} parts
 * @returns {{ severity: "fail" | "warn", message: string }[]}
 */
export function selectionProblems(selected, parts) {
  /** @type {{ severity: "fail" | "warn", message: string }[]} */
  const problems = [];
  if (selected.size === 0 && parts.length > 0) return [{ severity: "warn", message: "no part of ampi loads" }];
  const others = parts.filter((part) => part.name !== CORE_PART && selected.has(part.name));
  if (!selected.has(CORE_PART) && others.length > 0) {
    problems.push({ severity: "fail", message: `core is off, but ${others.map((part) => part.name).join(", ")} ${others.length === 1 ? "needs" : "need"} it` });
  }
  for (const part of parts) {
    if (!selected.has(part.name)) continue;
    const missing = part.requires.filter((name) => !selected.has(name));
    if (missing.length > 0) problems.push({ severity: "warn", message: `${part.name} is on without ${missing.join(", ")}, which it needs` });
  }
  return problems;
}

/** @param {string} pattern */
const patternPath = (pattern) => pattern.replace(/^[!+-]/, "").replace(/^\.\//, "");

/**
 * The ampi entry of Pi's settings with `selected` as its extension filter.
 * Every part gets a `+entry` or `-entry` pattern, so the choice holds in
 * project settings that filter on top of the user's (`autoload: false`) too;
 * patterns that name no part are kept. With every part on and nothing else to
 * filter, the entry goes back to a plain source string, as Pi writes it.
 *
 * @param {PiPackageEntry} entry
 * @param {readonly AmpiPart[]} parts
 * @param {ReadonlySet<string>} selected
 * @returns {PiPackageEntry}
 */
export function applySelection(entry, parts, selected) {
  const object = typeof entry === "string" ? { source: entry } : { ...entry };
  const partEntries = new Set(parts.map((part) => part.entry));
  const kept = (object.extensions ?? []).filter((pattern) => !partEntries.has(patternPath(pattern)));
  const everything = parts.every((part) => selected.has(part.name));
  const extensions = everything && kept.length === 0 && object.autoload !== false ? [] : [...kept, ...parts.map((part) => `${selected.has(part.name) ? "+" : "-"}${part.entry}`)];
  if (extensions.length > 0) object.extensions = extensions;
  else delete object.extensions;
  const keys = Object.keys(object).filter((key) => key !== "source");
  return keys.length === 0 ? object.source : object;
}
