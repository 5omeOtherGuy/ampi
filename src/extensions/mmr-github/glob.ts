/**
 * Documented glob matcher for repository file paths.
 *
 * Stdlib note: Node has no built-in glob path matcher, and adding a glob
 * dependency would require approval. This implementation compiles the pattern
 * to a single anchored RegExp and supports:
 *
 * - `*`    matches any run of characters except `/`
 * - `**`   matches any run of characters including `/` (any path segments)
 * - a `**` segment followed by a slash matches zero or more leading path
 *   segments (so `a/**` + `/b` also matches `a/b`)
 * - `?`    matches exactly one character except `/`
 * - `{a,b}` brace alternation
 * - `[...]` character classes (passed through to the RegExp verbatim)
 * - all other characters match literally (regex metacharacters are escaped)
 *
 * Matching is case-sensitive and anchored to the full path.
 */

function escapeLiteral(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          // `**/` — zero or more leading path segments.
          out += "(?:.+/)?";
          i += 3;
        } else {
          // `**` — any characters including path separators.
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      out += "[^/]";
      i += 1;
    } else if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close !== -1) {
        const alts = pattern.slice(i + 1, close).split(",");
        out += `(?:${alts.map(escapeLiteral).join("|")})`;
        i = close + 1;
      } else {
        out += escapeLiteral(char);
        i += 1;
      }
    } else if (char === "[") {
      const close = pattern.indexOf("]", i);
      if (close !== -1) {
        // Pass the character class through verbatim (e.g. `[a-z]`).
        out += pattern.slice(i, close + 1);
        i = close + 1;
      } else {
        out += escapeLiteral(char);
        i += 1;
      }
    } else {
      out += escapeLiteral(char);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

const cache = new Map<string, RegExp>();

export function matchGlob(pattern: string, candidate: string): boolean {
  let regex = cache.get(pattern);
  if (!regex) {
    regex = globToRegExp(pattern);
    if (cache.size > 256) cache.clear();
    cache.set(pattern, regex);
  }
  return regex.test(candidate);
}
