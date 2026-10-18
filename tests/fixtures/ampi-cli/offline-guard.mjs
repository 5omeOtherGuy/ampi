// Test-only preload (`node --import`): appends one JSON line per child
// process the command starts to the file named by AMPI_TEST_GUARD_LOG, and
// refuses every fetch and outgoing socket connection, logging the attempt as
// a violation. The test decides which child processes are allowed.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const log = process.env.AMPI_TEST_GUARD_LOG;
if (!log) throw new Error("offline guard: AMPI_TEST_GUARD_LOG is not set");

/** @param {unknown} entry */
const record = (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`);

/** @param {string} what */
const refuse = (what) => {
  record({ violation: what });
  throw new Error(`offline guard: ${what} is not allowed in this test`);
};

globalThis.fetch = async (input) => refuse(`fetch ${typeof input === "string" ? input : String(input?.url ?? input)}`);

net.Socket.prototype.connect = function connect(...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  return refuse(`socket connection to ${JSON.stringify(typeof target === "object" ? (target?.path ?? `${target?.host}:${target?.port}`) : target)}`);
};

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function guarded(command, ...rest) {
    record({ child: [String(command), ...(Array.isArray(rest[0]) ? rest[0].map(String) : [])] });
    return original.call(this, command, ...rest);
  };
}
syncBuiltinESMExports();
