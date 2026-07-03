/**
 * Pure helper: extract explicit `--model`, `--tools`, and
 * `--ampi-parent-mode` / legacy `--mmr-parent-mode` values from a Pi-style argv slice
 * (`process.argv.slice(2)`) so subagent activation can distinguish
 * runner-supplied flags from Pi's own default/restored/native model
 * selection and parent-mode metadata.
 *
 * Mirrors Pi's CLI parser shape for these flags:
 *
 *  - `--model <value>` — space-separated only in Pi's parser, but we
 *    also accept `--model=<value>` for caller convenience.
 *  - `--tools <a,b,c>` or `-t <a,b,c>` — comma-separated string list,
 *    trimmed; we additionally accept `--tools=<a,b,c>`.
 *  - `--tools ""` returns an empty array (runner explicitly asked for
 *    no tools), distinguishing it from "flag not present".
 *  - `--ampi-parent-mode <value>` — space-separated or
 *    `--ampi-parent-mode=<value>` for mode-derived workers that need to
 *    validate parent-mode-specific model preferences in the child process.
 *    The legacy `--mmr-parent-mode` spelling is also accepted.
 *
 * The helper deliberately does not validate values, does not consult
 * the Pi model registry, and does not split `<provider>/<id>` /
 * `<id>:<thinking>` suffixes. The subagent route resolver owns
 * comparison semantics; this helper only answers "was the flag
 * supplied, and what was its raw value?".
 */
export interface ExplicitWorkerCliFlags {
  /**
   * Raw value of the last `--model <value>` / `--model=<value>` on argv,
   * or `undefined` when no `--model` flag is present.
   */
  explicitModel?: string;
  /**
   * Parsed comma list from the last `--tools` / `-t` / `--tools=`
   * occurrence on argv. Trimmed entries; empty entries are dropped.
   * `undefined` when no `--tools` flag is present. An empty array
   * means the runner supplied `--tools ""` explicitly.
   */
  explicitTools?: readonly string[];
  /**
   * Raw value of the last `--ampi-parent-mode <value>` /
   * `--ampi-parent-mode=<value>` on argv, falling back to the legacy
   * `--ampi-parent-mode` spelling when the preferred flag is absent.
   */
  parentMode?: string;
}

function parseToolsValue(raw: string): string[] {
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function extractExplicitWorkerCliFlags(argv: readonly string[]): ExplicitWorkerCliFlags {
  let model: string | undefined;
  let tools: string[] | undefined;
  let parentMode: string | undefined;
  let legacyParentMode: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;

    if (arg === "--model") {
      const next = argv[i + 1];
      if (typeof next === "string") {
        model = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }

    if (arg === "--tools" || arg === "-t") {
      const next = argv[i + 1];
      if (typeof next === "string") {
        tools = parseToolsValue(next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--tools=")) {
      tools = parseToolsValue(arg.slice("--tools=".length));
      continue;
    }

    if (arg === "--ampi-parent-mode") {
      const next = argv[i + 1];
      if (typeof next === "string") {
        parentMode = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--ampi-parent-mode=")) {
      parentMode = arg.slice("--ampi-parent-mode=".length);
      continue;
    }

    if (arg === "--mmr-parent-mode") {
      const next = argv[i + 1];
      if (typeof next === "string") {
        legacyParentMode = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--mmr-parent-mode=")) {
      legacyParentMode = arg.slice("--mmr-parent-mode=".length);
      continue;
    }
  }

  return { explicitModel: model, explicitTools: tools, parentMode: parentMode ?? legacyParentMode };
}
