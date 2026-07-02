#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseConfigPath = ".github/release.yml";

function usage(exitCode = 0) {
  const message = [
    "Usage: npm run release:notes -- <tag> [--previous-tag <tag>] [--repo <owner/name>] [--output <path>]",
    "",
    "Generates GitHub release notes using .github/release.yml and writes reviewable release-note input to stdout or --output.",
    "This requires the GitHub CLI (`gh`) to be authenticated with release-read access.",
    "",
    "Examples:",
    "  npm run release:notes -- v0.1.0 --previous-tag v0.0.0 --output ./release-notes/ampi-v0.1.0.md",
    "  npm run release:notes -- v0.1.0 --repo owner/ampi",
  ].join("\n");
  (exitCode === 0 ? console.log : console.error)(message);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) usage(0);
  const tagName = args.shift();
  let previousTagName;
  let repo;
  let output;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--previous-tag") {
      previousTagName = args.shift();
    } else if (arg === "--repo") {
      repo = args.shift();
    } else if (arg === "--output") {
      output = args.shift();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!tagName?.trim()) throw new Error("Missing release tag.");
  if (previousTagName !== undefined && !previousTagName.trim()) throw new Error("--previous-tag requires a value.");
  if (repo !== undefined && !/^[-\w.]+\/[-\w.]+$/.test(repo)) throw new Error("--repo must be owner/name.");
  if (output !== undefined && !output.trim()) throw new Error("--output requires a path.");

  return { tagName, previousTagName, repo, output };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...options,
  }).trim();
}

function parseGitHubRemote(remote) {
  const trimmed = remote.trim();
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "github.com") return undefined;
    const parts = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length >= 2 && parts[0] && parts[1]) return `${parts[0]}/${parts[1]}`;
  } catch {
    // ignore non-URL remotes
  }
  return undefined;
}

function resolveRepo(explicitRepo) {
  if (explicitRepo) return explicitRepo;
  const remote = run("git", ["config", "--get", "remote.origin.url"]);
  const repo = parseGitHubRemote(remote);
  if (!repo) throw new Error("Could not infer GitHub owner/name from remote.origin.url; pass --repo owner/name.");
  return repo;
}

function generateReleaseNotes({ repo, tagName, previousTagName }) {
  const args = [
    "api",
    `repos/${repo}/releases/generate-notes`,
    "--method",
    "POST",
    "-f",
    `tag_name=${tagName}`,
    "-f",
    `configuration_file_path=${releaseConfigPath}`,
  ];
  if (previousTagName) {
    args.push("-f", `previous_tag_name=${previousTagName}`);
  }

  const raw = run("gh", args);
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || typeof data.body !== "string") {
    throw new Error("GitHub release note response did not contain a body string.");
  }
  const title = typeof data.name === "string" && data.name.trim() ? data.name.trim() : tagName;
  return `# ${title}\n\n${data.body.trim()}\n`;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const repo = resolveRepo(options.repo);
    const notes = generateReleaseNotes({ repo, tagName: options.tagName, previousTagName: options.previousTagName });
    if (options.output) {
      const outputPath = path.resolve(options.output);
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, notes, "utf8");
      console.error(`Wrote GitHub-generated release notes to ${outputPath}`);
    } else {
      process.stdout.write(notes);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`release notes generation failed: ${message}`);
    process.exitCode = 1;
  }
}

main();
