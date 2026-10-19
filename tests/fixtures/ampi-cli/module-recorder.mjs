// Test-only preload (`node --import`): appends the URL of every module the
// process resolves, one per line, to the file named by AMPI_TEST_MODULE_LOG,
// so a test can tell which packages a command loaded.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const log = process.env.AMPI_TEST_MODULE_LOG;
if (!log) throw new Error("module recorder: AMPI_TEST_MODULE_LOG is not set");

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    appendFileSync(log, `${resolved.url}\n`);
    return resolved;
  },
});
