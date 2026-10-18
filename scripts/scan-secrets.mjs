#!/usr/bin/env node
// Secret scan for the gate: fails when a tracked or new (not ignored) file
// contains a credential-shaped string. Hermetic and dependency-free.
//
// Tests and fixtures that need credential-shaped values build them from parts
// (for example `["ghp", "_", "x".repeat(36)].join("")`), so they never match.
//
// Usage: node scripts/scan-secrets.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const rules = [
  ["private key block", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["AWS access key ID", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{32,}/],
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/],
  ["Stripe live key", /\b[rs]k_live_[0-9A-Za-z]{24,}/],
];

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree, or a directory entry such as a submodule
  }
  if (text.includes("\0")) continue; // binary
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [name, pattern] of rules) {
      if (pattern.test(lines[i])) findings.push(`${file}:${i + 1}: ${name}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`scan-secrets: ${findings.length} credential-shaped string(s) found:\n`);
  for (const finding of findings) process.stderr.write(`  ${finding}\n`);
  process.stderr.write("Remove the value, or build test values from parts so they never appear literally.\n");
  process.exit(1);
}
