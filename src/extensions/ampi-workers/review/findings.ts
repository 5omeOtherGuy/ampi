// Findings in a reviewer report: the location lines the reviewer prompt asks
// for (`<path>:<start>-<end>` followed by severity and type, then a
// description), read tolerantly because models do not always follow the
// format exactly. `countAmpiReviewFindings` in checks.ts counts what this
// parser finds, so a counted line is always a parsed finding.

export const AMPI_REVIEW_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const AMPI_REVIEW_FINDING_TYPES = ["bug", "suggested_edit", "compliment", "non_actionable"] as const;

export type AmpiReviewSeverity = (typeof AMPI_REVIEW_SEVERITIES)[number];
export type AmpiReviewFindingType = (typeof AMPI_REVIEW_FINDING_TYPES)[number];

/** One finding of a reviewer report. */
export interface AmpiReviewFinding {
  /** The path as the report wrote it. */
  file: string;
  /** 0 for a deleted file (`0-0`). */
  startLine: number;
  /** Equal to `startLine` for a `<path>:<line>` location. */
  endLine: number;
  severity: AmpiReviewSeverity | null;
  type: AmpiReviewFindingType | null;
  /** The rest of the location line after severity and type, then the lines below it up to the next finding or heading, trimmed. */
  text: string;
}

/**
 * A line that starts (after a list marker, a heading marker, emphasis or
 * backticks) with `<path>:<start>-<end>` or `<path>:<line>`. The opening
 * emphasis is matched lazily, so a path that starts with an underscore
 * (`__init__.py`) keeps it.
 */
const FINDING_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?[*_`]*?([^\s:`*]+):(\d+)(?:-(\d+))?\b([\s\S]*)$/;
const FINDINGS_HEADING = /^\s*(?:#{1,6}\s*)?[*_]*findings[*_]*\s*:?\s*[*_]*\s*$/i;
const MARKDOWN_HEADING = /^\s*#{1,6}\s/;

/** Punctuation and emphasis between the location, the severity and type words and the description. */
const TAG_SEPARATORS = /^[\s*_`~—–:;,·|/()[\]{}=-]+/;
/** A label with its colon (`severity:`, `type =`), or a severity or type word. */
const TAG_WORD = /^(?:(?:severity|priority|type|kind|category)[*_`]*\s*[:=]|(critical|high|medium|low|bug|compliment|suggested[ _-]?edit|non[ _-]?actionable)\b)/i;
/** What is left of the location and its tags before the description: closing emphasis and one separator. */
const DESCRIPTION_LEAD = /^\s*[*_`)\]]*\s*(?:[—–:|·-]+\s*)?/;

function severityOf(word: string): AmpiReviewSeverity | undefined {
  return (AMPI_REVIEW_SEVERITIES as readonly string[]).includes(word) ? (word as AmpiReviewSeverity) : undefined;
}

function typeOf(word: string): AmpiReviewFindingType | undefined {
  const normalized = word.replace(/[ -]/g, "_").replace(/^non_?actionable$/, "non_actionable").replace(/^suggested_?edit$/, "suggested_edit");
  return (AMPI_REVIEW_FINDING_TYPES as readonly string[]).includes(normalized) ? (normalized as AmpiReviewFindingType) : undefined;
}

/**
 * Severity and type at the start of the text after a location, in either
 * order and with or without labels (`severity: medium; type: bug`,
 * `**High** bug`, `low · compliment`), and the description after them.
 */
function readTags(rest: string): { severity: AmpiReviewSeverity | null; type: AmpiReviewFindingType | null; description: string } {
  let severity: AmpiReviewSeverity | null = null;
  let type: AmpiReviewFindingType | null = null;
  let remaining = rest;
  for (;;) {
    const candidate = remaining.replace(TAG_SEPARATORS, "");
    const match = TAG_WORD.exec(candidate);
    if (!match) break;
    const word = match[1]?.toLowerCase();
    const asSeverity = word === undefined ? undefined : severityOf(word);
    const asType = word === undefined ? undefined : typeOf(word);
    // A second severity or type word starts the description.
    if ((asSeverity && severity !== null) || (asType && type !== null)) break;
    if (asSeverity) severity = asSeverity;
    if (asType) type = asType;
    remaining = candidate.slice(match[0].length);
  }
  return { severity, type, description: remaining.replace(DESCRIPTION_LEAD, "") };
}

/** Lines without the indentation they all share. */
function dedent(lines: readonly string[]): string[] {
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
  const shared = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shared).trimEnd());
}

/**
 * The report's lines, and the index of the first line findings can be on:
 * the line after the first `Findings` heading line, or 0 without one, so a
 * location quoted in the summary is not a finding.
 */
function findingsBody(report: string): { lines: string[]; start: number; heading: number } {
  const lines = report.replace(/\r\n?/g, "\n").split("\n");
  const heading = lines.findIndex((line) => FINDINGS_HEADING.test(line));
  return { lines, start: heading + 1, heading };
}

/**
 * Parse the findings of a reviewer report. A finding is a line that starts
 * with a location (see {@link FINDING_LINE}) after the first `Findings`
 * heading line, or anywhere when there is none; a line without a line number
 * is not one. Its text runs to the next finding line or heading.
 */
export function parseAmpiReviewFindings(report: string): AmpiReviewFinding[] {
  const { lines, start } = findingsBody(report);
  const findings: AmpiReviewFinding[] = [];
  for (let index = start; index < lines.length; index++) {
    const match = FINDING_LINE.exec(lines[index]);
    if (!match) continue;
    const [, file, startText, endText, rest] = match;
    const { severity, type, description } = readTags(rest);
    const following: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next];
      if (FINDING_LINE.test(line) || MARKDOWN_HEADING.test(line) || FINDINGS_HEADING.test(line)) break;
      following.push(line);
    }
    const startLine = Number(startText);
    findings.push({
      file,
      startLine,
      endLine: endText === undefined ? startLine : Number(endText),
      severity,
      type,
      text: [description.trim(), ...dedent(following)].join("\n").trim(),
    });
  }
  return findings;
}

/**
 * The report's summary: its text before the `Findings` heading line, or
 * before the first finding line when it has no such heading, trimmed; `""`
 * when it has neither.
 */
export function ampiReviewSummary(report: string): string {
  const { lines, heading } = findingsBody(report);
  const end = heading !== -1 ? heading : lines.findIndex((line) => FINDING_LINE.test(line));
  return end === -1 ? "" : lines.slice(0, end).join("\n").trim();
}
