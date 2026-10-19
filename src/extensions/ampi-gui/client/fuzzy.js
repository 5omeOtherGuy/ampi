// Fuzzy matching for the command palette and its Switch Thread picker. The
// terminal palette ranks with pi-tui's matcher, which the browser cannot
// import; this is the same idea: every typed character must appear in the
// title in order, and a match scores more where characters start a word or
// follow each other. Unlike a greedy matcher it finds the best placement,
// so `sw` lands on the start of "Switch" rather than on the first s. Pure,
// so tests load it in Node.

/** Every matched character. */
const CHAR = 1;
/** A character that starts a word: the first, one after a space or punctuation, or a capital after a lowercase letter. */
const WORD_START = 6;
/** A character right after the previous match. */
const RUN = 4;
/** Each character skipped between two matches. */
const GAP = 0.1;

/**
 * The score per typed character from which a match counts as good: on
 * average every character starts a word or continues a run. Below it the
 * palette offers to send the text as a message.
 */
export const GOOD_MATCH = 3;

function wordStarts(text) {
  return Array.from({ length: text.length }, (_, index) => {
    if (index === 0) return true;
    const char = text[index];
    const before = text[index - 1];
    if (!/[\p{L}\p{N}]/u.test(before)) return true;
    return /\p{Ll}/u.test(before) && /\p{Lu}/u.test(char);
  });
}

/**
 * How well one word of a query (no spaces) matches `text`, ignoring case:
 * the best score over every placement of its characters in order, or
 * `null` when they do not all appear in order. Higher is better.
 */
export function fuzzyScore(word, text) {
  const query = word.toLowerCase();
  const lower = text.toLowerCase();
  // toLowerCase keeps the length for the titles and names the palette shows; when it does not, match without word starts.
  const starts = lower.length === text.length ? wordStarts(text) : [];
  if (query === "") return 0;
  if (query.length > lower.length) return null;
  const NONE = Number.NEGATIVE_INFINITY;
  // previous[i]: the best score with the query so far ending at text position i.
  let previous = null;
  for (let j = 0; j < query.length; j++) {
    const current = new Array(lower.length).fill(NONE);
    // The best previous ending at least two positions back, less the gap to i.
    let far = NONE;
    for (let i = 0; i < lower.length; i++) {
      if (previous && i >= 2) far = Math.max(far - GAP, previous[i - 2] - GAP);
      if (lower[i] !== query[j]) continue;
      const own = CHAR + (starts[i] ? WORD_START : 0);
      if (!previous) current[i] = own;
      else {
        const run = i >= 1 && previous[i - 1] > NONE ? previous[i - 1] + RUN : NONE;
        const best = Math.max(run, far);
        if (best > NONE) current[i] = own + best;
      }
    }
    previous = current;
  }
  const best = Math.max(...previous);
  return best > NONE ? Math.round(best * 100) / 100 : null;
}

/**
 * Rank `items` by how well `query` matches `textOf(item)`. Every word of
 * the query must match; their scores add up. Answers
 * `[{ item, score, quality }]`, best first: a title equal to the query,
 * then the higher score, then the shorter title, then the given order.
 * `quality` is the score per typed character (see GOOD_MATCH). An empty
 * query keeps every item in its order with score 0.
 */
export function fuzzyRank(items, query, textOf) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.map((item) => ({ item, score: 0, quality: 0 }));
  const typed = words.join("").length;
  const exact = words.join(" ").toLowerCase();
  const ranked = [];
  for (const [order, item] of items.entries()) {
    const text = textOf(item);
    let score = 0;
    for (const word of words) {
      const one = fuzzyScore(word, text);
      if (one === null) {
        score = null;
        break;
      }
      score += one;
    }
    if (score === null) continue;
    ranked.push({ item, score, quality: score / typed, order, length: text.length, exact: text.toLowerCase().replace(/…$/, "") === exact });
  }
  ranked.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.length - b.length || a.order - b.order);
  return ranked.map(({ item, score, quality }) => ({ item, score, quality }));
}
