/**
 * Deterministic R'lyehian transliteration used to cloak the streamed
 * agent-loop content of the hidden `cthulu` subagent.
 *
 * The transform is intentionally cosmetic and lossy: ordinary English
 * words are replaced with deterministic, incantation-styled tokens built
 * from a fixed bank of Cthulhu-mythos syllables (public-domain Lovecraft
 * vocabulary). It is NOT a real language and cannot be reversed.
 *
 * Design constraints:
 * - Pure and deterministic: the same input always yields the same output,
 *   so renderer behavior is snapshot-testable.
 * - Whitespace, newlines, digits, and punctuation are preserved verbatim;
 *   only runs of ASCII letters are transliterated. This keeps Markdown
 *   structure (list bullets, code fences, link brackets) roughly intact
 *   while the prose itself becomes an unreadable incantation.
 * - Capitalization shape of each source word is preserved (ALL CAPS,
 *   Capitalized, or lowercase) so the cadence still reads like text.
 *
 * Only the streamed agent-loop content (thinking, interim assistant text,
 * tool labels, previews) is passed through this transform. The worker's
 * final answer is rendered untouched so the user can still act on it.
 *
 * Two flavors are exported:
 * - {@link toRlyehian} transliterates every word (a full cloak).
 * - {@link toRlyehianBlend} transliterates only part of the words and leaves
 *   the rest in dread English, so the streamed content reads as the Great
 *   Old One's broken tongue — part incantation, part human speech. This is
 *   what the renderer uses for the `cthulu` worker.
 */

/** Fixed bank of mythos-flavored syllables. Order is part of the contract. */
const RLYEHIAN_SYLLABLES: readonly string[] = [
  "ph",
  "nglui",
  "mglw",
  "nafh",
  "cthul",
  "hu",
  "rlyeh",
  "wgah",
  "nagl",
  "fhtagn",
  "ia",
  "ya",
  "shub",
  "nig",
  "gurath",
  "yog",
  "soth",
  "oth",
  "azath",
  "hastur",
  "gnaiih",
  "ftaghu",
  "ee",
  "nyar",
  "lath",
  "otep",
  "throd",
  "og",
  "vulgt",
  "mnahn",
  "uaaah",
  "geb",
  "lloig",
  "grah",
  "naflfhtagn",
  "ron",
];

/**
 * Deterministic 32-bit-ish hash of a word. Mixes character codes with
 * their position so anagrams map to different tokens. Stays in safe
 * integer range without bitwise overflow surprises.
 */
function hashWord(word: string): number {
  let hash = 2166136261;
  for (let i = 0; i < word.length; i += 1) {
    hash ^= word.charCodeAt(i) + i;
    // FNV-style multiply, kept in 32-bit space via Math.imul.
    hash = Math.imul(hash, 16777619);
  }
  // Force unsigned.
  return hash >>> 0;
}

type WordCase = "upper" | "capitalized" | "lower";

function detectCase(word: string): WordCase {
  const hasLetter = /[a-z]/i.test(word);
  if (!hasLetter) return "lower";
  if (word.length > 1 && word === word.toUpperCase()) return "upper";
  if (word[0] === word[0]?.toUpperCase() && word.slice(1) === word.slice(1).toLowerCase()) {
    return "capitalized";
  }
  return "lower";
}

function applyCase(token: string, wordCase: WordCase): string {
  switch (wordCase) {
    case "upper":
      return token.toUpperCase();
    case "capitalized":
      return token.length > 0 ? token[0]!.toUpperCase() + token.slice(1) : token;
    case "lower":
      return token;
  }
}

/** Transliterate a single ASCII-letter word into a R'lyehian token. */
function transliterateWord(word: string): string {
  const hash = hashWord(word);
  // Roughly one syllable per ~2.5 letters, clamped to keep tokens legible.
  const syllableCount = Math.min(5, Math.max(1, Math.round(word.length / 2.5)));
  let token = "";
  for (let i = 0; i < syllableCount; i += 1) {
    const index = (hash + i * 0x9e3779b9 + i * i) % RLYEHIAN_SYLLABLES.length;
    const syllable = RLYEHIAN_SYLLABLES[index]!;
    if (i > 0 && ((hash >>> i) & 1) === 1) token += "'";
    token += syllable;
  }
  return applyCase(token, detectCase(word));
}

/**
 * Transliterate arbitrary text into deterministic R'lyehian. Runs of
 * ASCII letters become incantation tokens; every other character
 * (whitespace, digits, punctuation, symbols, non-ASCII) is preserved.
 */
export function toRlyehian(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  return text.replace(/[A-Za-z]+/g, (word) => transliterateWord(word));
}

/** Words this short are always kept readable so the cadence survives. */
const RLYEHIAN_BLEND_KEEP_MAX_LEN = 3;

/**
 * Transliterate text into a part-R'lyehian, part-English blend. Short words
 * (articles, conjunctions, prepositions) are always kept so the prose still
 * scans; among the longer words, every other one is turned to incantation
 * while the rest stay in dread English. The result reads as Cthulhu speaking
 * a broken human tongue laced with the chant.
 *
 * Deterministic and pure: alternation runs over the eligible words in order,
 * so the same input always yields the same blend and renderer output stays
 * snapshot-testable. Whitespace, digits, and punctuation are preserved
 * exactly as in {@link toRlyehian}.
 */
export function toRlyehianBlend(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let eligibleIndex = 0;
  return text.replace(/[A-Za-z]+/g, (word) => {
    if (word.length <= RLYEHIAN_BLEND_KEEP_MAX_LEN) return word;
    const translate = eligibleIndex % 2 === 0;
    eligibleIndex += 1;
    return translate ? transliterateWord(word) : word;
  });
}
