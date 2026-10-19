// Pi's external editor, started for a file the way Pi starts it for the
// prompt. `ampi config edit` and `ampi permissions edit` open files with it.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import { piExternalEditorCommand } from "./pi-compat.js";

/**
 * Open `file` in Pi's external editor (`piExternalEditorCommand`), its
 * command split at spaces with the file as the last argument, and wait for it
 * to exit. The file's directory is created when it is missing, so the editor
 * can save, and removed again when the editor leaves it empty.
 *
 * @param {any} pi The `@earendil-works/pi-coding-agent` module.
 * @param {string} cwd
 * @param {string} file
 * @returns {Promise<string | undefined>} What went wrong, or undefined when the editor exited with status 0.
 */
export async function openInPiEditor(pi, cwd, file) {
  const [editor, ...args] = piExternalEditorCommand(pi, cwd).split(" ");
  const created = mkdirSync(path.dirname(file), { recursive: true });
  /** @type {number | null | Error} */
  const outcome = await new Promise((resolve) => {
    const child = spawn(editor, [...args, file], { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", resolve);
    child.on("close", resolve);
  });
  if (created !== undefined && !existsSync(file)) removeEmptyDirectories(path.dirname(file), created);
  if (outcome instanceof Error) return `could not start the editor ${editor}: ${outcome.message}`;
  if (outcome !== 0) return `the editor ${editor} exited with ${outcome === null ? "a signal" : `status ${outcome}`}.`;
  return undefined;
}

/**
 * Remove `dir` and its parents up to `top` while they are empty.
 *
 * @param {string} dir
 * @param {string} top
 */
function removeEmptyDirectories(dir, top) {
  for (let current = dir; ; current = path.dirname(current)) {
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    if (current === top) return;
  }
}
