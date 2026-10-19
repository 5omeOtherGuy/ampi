// The `ampi` command: route the arguments, then print help or versions, or
// start Pi with ampi loaded.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { formatAmpiHelp, routeAmpiArgv } from "./argv.js";
import { buildExecuteArgs, createRunExtension, EXECUTE_NO_MESSAGE_ERROR, isExecuteRun, readAll } from "./execute.js";
import { createMcpConfigExtension, readMcpConfigFlag } from "./mcp-config.js";
import { AMPI_PACKAGE_NAME, decideAmpiLoad, locateAmpiPackage, readPackageAt, resolveInstalledPackage } from "./packages.js";
import { capturePiJsonOutput, exitWithCodeAfterPiRpc, feedPiRpcInput, hidePipedStdinFromPi, listPiExtensionSources, piAgentDir } from "./pi-compat.js";
import { createStatsOutput, createStreamJsonOutput, createToolOutput } from "./run-output.js";
import { createStreamJsonEncoder, readStreamJsonContext } from "./stream-json.js";
import { createStreamJsonInputDriver } from "./stream-json-input.js";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** @returns {string} */
function formatVersions() {
  const cli = readPackageAt(CLI_ROOT);
  const ampi = locateAmpiPackage(CLI_ROOT);
  const pi = resolveInstalledPackage(PI_PACKAGE_NAME);
  return [
    `ampi-cli ${cli?.version ?? "unknown"}`,
    `ampi ${ampi?.version ?? "not installed"}`,
    `pi ${pi?.version ?? "not installed"}`,
    "",
  ].join("\n");
}

const MISSING_PI_BIN = `cannot find Pi's executable in ${PI_PACKAGE_NAME}; reinstall @skippermissions/ampi-cli.`;

/** @returns {string | undefined} Pi's executable script, from its package manifest. */
function piExecutable() {
  const pi = resolveInstalledPackage(PI_PACKAGE_NAME);
  if (pi === undefined) return undefined;
  const manifest = JSON.parse(readFileSync(path.join(pi.root, "package.json"), "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  return typeof entry === "string" ? path.join(pi.root, entry) : undefined;
}

/**
 * Run one of Pi's own commands through Pi's own executable, so it gets the
 * same process setup (proxy settings, warnings) as `pi <command>`.
 *
 * @param {string[]} args
 * @returns {number}
 */
function runPiCommand(args) {
  const bin = piExecutable();
  if (bin === undefined) {
    process.stderr.write(`ampi: ${MISSING_PI_BIN}\n`);
    return 1;
  }
  const result = spawnSync(process.execPath, [bin, ...args], { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`ampi: could not run Pi: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Hand the arguments to Pi's `main()`, adding ampi's package with `-e`, the way
 * Pi loads any package for one run, unless Pi already loads ampi. Execute mode
 * reads stdin itself and runs Pi's print mode with the combined message.
 *
 * @param {import("./argv.js").AmpiRoute} route
 * @returns {Promise<number | undefined>}
 */
async function startPi({ piArgs, options }) {
  const pi = await import(PI_PACKAGE_NAME);
  let args = [...piArgs];
  const parsed = pi.parseArgs(args);
  // RPC mode talks JSON over stdin, which execute mode reads for the message.
  if (options.execute && parsed.mode === "rpc") {
    process.stderr.write("ampi: -x cannot be combined with --mode rpc.\n");
    return 2;
  }
  const execute = isExecuteRun({
    explicit: options.execute,
    parsed,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  });
  if (!execute && (options.timings || !options.archive)) {
    process.stderr.write("ampi: --timings and --no-archive-after-execute need execute mode (-x).\n");
    return 2;
  }
  if (options.streamJson && !execute) {
    process.stderr.write("ampi: --stream-json needs execute mode (-x).\n");
    return 2;
  }
  if (options.streamJson && parsed.mode !== undefined) {
    process.stderr.write(`ampi: --stream-json replaces Pi's output mode; leave out --mode ${parsed.mode}.\n`);
    return 2;
  }
  /** @type {[string, boolean][]} The other execute-mode flags that were given. */
  const executeFlags = [
    ["--stats", options.stats],
    ["--output-tool", options.outputTool !== undefined],
    ["--plugin-ready-timeout", options.pluginReadyTimeout !== undefined],
  ];
  for (const [flag, given] of executeFlags) {
    if (!given) continue;
    if (!execute) {
      process.stderr.write(`ampi: ${flag} needs execute mode (-x).\n`);
      return 2;
    }
    if (parsed.mode !== undefined && flag !== "--plugin-ready-timeout") {
      process.stderr.write(`ampi: ${flag} replaces Pi's output mode; leave out --mode ${parsed.mode}.\n`);
      return 2;
    }
  }
  if (options.streamJsonInput && (parsed.messages.length > 0 || parsed.fileArgs.length > 0)) {
    process.stderr.write("ampi: --stream-json-input reads every message from stdin; leave out the message argument.\n");
    return 2;
  }
  if (options.streamJsonInput && process.stdin.isTTY === true) {
    process.stderr.write("ampi: --stream-json-input reads JSON lines from stdin, which is a terminal here; pipe the messages in.\n");
    return 2;
  }
  const cwd = process.cwd();
  /** @type {Record<string, unknown> | undefined} */
  let mcpServers;
  if (options.mcpConfig !== undefined) {
    if (parsed.noMcp) {
      process.stderr.write("ampi: --mcp-config needs Pi's MCP support; leave out --no-mcp.\n");
      return 2;
    }
    const read = readMcpConfigFlag(options.mcpConfig, cwd);
    if ("error" in read) {
      process.stderr.write(`ampi: ${read.error}\n`);
      return 2;
    }
    mcpServers = read.servers;
  }
  const decision = decideAmpiLoad({
    piArgs: args,
    pi: await listPiExtensionSources(pi, cwd),
    cwd,
    packageNameAt: (start) => readPackageAt(start)?.name,
  });
  if (execute && !options.streamJsonInput) {
    const stdin = process.stdin.isTTY === true ? undefined : await readAll(process.stdin);
    hidePipedStdinFromPi();
    const built = buildExecuteArgs(pi.parseArgs, args, stdin);
    if ("error" in built) {
      process.stderr.write(`ampi: ${built.error}\n`);
      return 2;
    }
    args = built.args;
  }
  if (decision.load) {
    const ampi = locateAmpiPackage(CLI_ROOT);
    if (ampi === undefined) {
      process.stderr.write(`ampi: cannot find ${AMPI_PACKAGE_NAME}; reinstall @skippermissions/ampi-cli.\n`);
      return 1;
    }
    args.unshift("-e", ampi.root);
  } else if (decision.reason === "pi") {
    process.stderr.write(`ampi: using the ampi that Pi already loads (${decision.source}).\n`);
  }
  // The process setup Pi's own executable does before calling main().
  process.title = "ampi";
  process.env.PI_CODING_AGENT = "true";
  process.env.AI_AGENT = "pi";
  process.emitWarning = () => {};
  const runExtension = createRunExtension({
    labels: options.labels,
    titled: options.title !== undefined,
    archive: execute && options.archive,
    timings: execute && options.timings,
  });
  const extensionFactories = [{ name: "ampi-cli", factory: runExtension, hidden: true }];
  if (mcpServers !== undefined) {
    const factory = createMcpConfigExtension(mcpServers, { agentDir: pi.getAgentDir(), configDirName: pi.CONFIG_DIR_NAME });
    extensionFactories.push({ name: "ampi-cli-mcp-config", factory, hidden: true });
  }
  if (options.streamJsonInput) return runStreamJsonInput(pi, args, extensionFactories, options.streamJsonThinking);
  if (options.streamJson) return runPiJson(pi, args, extensionFactories, options.streamJsonThinking, createStreamJsonOutput);
  if (options.stats) return runPiJson(pi, args, extensionFactories, false, createStatsOutput);
  const { outputTool } = options;
  if (outputTool !== undefined) return runPiJson(pi, args, extensionFactories, false, (encoder) => createToolOutput(outputTool, encoder));
  await pi.main(args, { extensionFactories });
  return undefined;
}

/**
 * Call `onLine` for each line of `stream`, split on LF only (a JSON string may
 * contain U+2028, which `readline` would also split on), and `onEnd` at its end.
 *
 * @param {NodeJS.ReadableStream} stream
 * @param {(line: string) => void} onLine
 * @param {() => void} onEnd
 */
function readLines(stream, onLine, onEnd) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  /** @param {string} text */
  const split = (text) => {
    const lines = (pending + text).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line.replace(/\r$/, ""));
  };
  stream.on("data", (chunk) => split(typeof chunk === "string" ? chunk : decoder.write(chunk)));
  stream.on("end", () => {
    split(decoder.end());
    if (pending !== "") onLine(pending.replace(/\r$/, ""));
    pending = "";
    onEnd();
  });
}

/**
 * Run Pi's RPC mode with the messages from stdin and print stream JSON records
 * for every run (see stream-json-input.js). Pi starts once the first message
 * line arrives; stdin ending before that is the missing-message usage error.
 * RPC mode ends the process itself once its input ends.
 *
 * @param {any} pi The `@earendil-works/pi-coding-agent` module.
 * @param {string[]} args Pi's arguments, without a message.
 * @param {{ name: string, factory: (pi: any) => void, hidden: boolean }[]} extensionFactories
 * @param {boolean} thinking
 * @returns {Promise<number>}
 */
async function runStreamJsonInput(pi, args, extensionFactories, thinking) {
  /** @type {import("./stream-json-input.js").StreamJsonInputDriver | undefined} */
  let driver;
  /** @type {string[]} Lines read before the driver exists. */
  const early = [];
  let stdinEnded = false;
  const hasMessage = await new Promise((resolve) => {
    readLines(
      process.stdin,
      (line) => {
        if (driver !== undefined) {
          driver.line(line);
          return;
        }
        early.push(line);
        if (line.trim() !== "") resolve(true);
      },
      () => {
        stdinEnded = true;
        if (driver !== undefined) driver.end();
        else resolve(false);
      },
    );
  });
  if (!hasMessage) {
    process.stderr.write(`ampi: ${EXECUTE_NO_MESSAGE_ERROR}\n`);
    return 2;
  }

  /** @type {any} The extension API of the current runtime, for the tools and mode in the init record. */
  let runtime;
  const encoder = createStreamJsonEncoder({ thinking, now: () => performance.now(), context: () => readStreamJsonContext(runtime) });
  const rpcInput = feedPiRpcInput();
  const output = capturePiJsonOutput((record) => {
    driver?.receive(record);
    return "";
  });
  let written = Promise.resolve();
  const current = createStreamJsonInputDriver(encoder, {
    send: rpcInput.send,
    write: (records) => {
      if (records.length > 0) written = output.write(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
    },
    warn: (text) => process.stderr.write(`${text}\n`),
    // The last records must reach stdout before Pi exits the process.
    end: () => void written.finally(rpcInput.end),
  });
  driver = current;
  for (const line of early) current.line(line);
  if (stdinEnded) current.end();
  // Pi can also stop on its own before it reads its input, for example after a question it asked on stdin.
  const exitCode = () => {
    if (current.ended) return current.exitCode;
    process.stderr.write("ampi: Pi stopped before every message from stdin was handled.\n");
    return 1;
  };
  exitWithCodeAfterPiRpc(exitCode);

  // RPC output has no session header: the session's id and directory come from the session itself.
  const factory = (/** @type {any} */ api) => {
    runtime = api;
    api.on("session_start", (/** @type {unknown} */ _event, /** @type {any} */ ctx) => {
      encoder.push({ type: "session", id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd });
    });
  };
  try {
    await pi.main(["--mode", "rpc", ...args], { extensionFactories: [...extensionFactories, { name: "ampi-cli-stream-json", factory, hidden: true }] });
  } finally {
    output.restore();
  }
  return exitCode();
}

/**
 * Run Pi's JSON mode and print what `outputOf` makes of its events in their
 * place (see run-output.js): stream JSON records, the `--stats` line or the
 * `--output-tool` result. Every output reads the events through one stream
 * JSON encoder.
 *
 * @param {any} pi The `@earendil-works/pi-coding-agent` module.
 * @param {string[]} args Pi's arguments for an execute run.
 * @param {{ name: string, factory: (pi: any) => void, hidden: boolean }[]} extensionFactories
 * @param {boolean} thinking Whether the encoder keeps thinking blocks.
 * @param {(encoder: import("./stream-json.js").StreamJsonEncoder) => import("./run-output.js").RunOutput} outputOf
 * @returns {Promise<number>}
 */
async function runPiJson(pi, args, extensionFactories, thinking, outputOf) {
  /** @type {any} The extension API of the current runtime, for the tools and mode in the init record. */
  let runtime;
  const encoder = createStreamJsonEncoder({ thinking, now: () => performance.now(), context: () => readStreamJsonContext(runtime) });
  const runOutput = outputOf(encoder);
  const output = capturePiJsonOutput((event) => runOutput.push(event));
  try {
    const factory = (/** @type {any} */ api) => {
      runtime = api;
    };
    await pi.main(["--mode", "json", ...args], { extensionFactories: [...extensionFactories, { name: "ampi-cli-stream-json", factory, hidden: true }] });
  } finally {
    output.restore();
  }
  // Pi's JSON mode sets a failing exit code only when the run threw; the error is then on stderr.
  const failed = process.exitCode !== undefined && process.exitCode !== 0;
  const end = runOutput.finish(failed ? "Pi stopped with an error; see stderr." : undefined);
  if (end.stderr !== "") process.stderr.write(end.stderr);
  if (end.stdout !== "") await output.write(end.stdout);
  return failed ? Number(process.exitCode) : end.exitCode;
}

/**
 * Run the `ampi` command line.
 *
 * @param {string[]} argv Arguments after the executable and script.
 * @returns {Promise<number | undefined>} An exit code, or `undefined` when Pi set its own.
 */
export async function runAmpi(argv) {
  const route = routeAmpiArgv(argv);
  switch (route.command) {
    case "help":
      process.stdout.write(formatAmpiHelp());
      return 0;
    case "version":
      process.stdout.write(formatVersions());
      return 0;
    case "error":
      process.stderr.write(`ampi: ${route.error}\nRun ampi --help for the supported options.\n`);
      return 2;
    case "pi-command":
      return runPiCommand(route.piArgs);
    case "threads":
      return runThreads(route.threadArgs ?? []);
    case "tools": {
      // A listing never installs packages or refreshes model catalogues.
      process.env.PI_OFFLINE = "1";
      const [pi, { readSessionTools, runToolsCommand }] = await Promise.all([import(PI_PACKAGE_NAME), import("./tools.js")]);
      const cwd = process.cwd();
      return runToolsCommand(route.toolsArgs ?? [], {
        readTools: (mode) => readSessionTools(pi, cwd, mode),
        columns: process.stdout.isTTY ? process.stdout.columns : Number.POSITIVE_INFINITY,
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      });
    }
    case "app":
      return runAppProcess(route.open === true);
    case "app-worker":
      return runAppWorkerProcess();
    case "skill": {
      // A listing never installs packages or refreshes model catalogues.
      process.env.PI_OFFLINE = "1";
      const [pi, { readSessionSkills, runSkillCommand }] = await Promise.all([import(PI_PACKAGE_NAME), import("./skill.js")]);
      const cwd = process.cwd();
      return runSkillCommand(route.skillArgs ?? [], {
        pi,
        cwd,
        agentDir: piAgentDir(pi),
        readSkills: () => readSessionSkills(pi, cwd),
        git: (args) => {
          const result = spawnSync("git", args, {
            encoding: "utf8",
            stdio: ["ignore", "ignore", "pipe"],
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          });
          return { status: result.status, stderr: result.stderr ?? "", error: result.error };
        },
        tempRoot: os.tmpdir(),
        columns: process.stdout.isTTY ? process.stdout.columns : Number.POSITIVE_INFINITY,
        interactive: process.stdin.isTTY === true,
        confirm,
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      });
    }
    case "mcp": {
      const { runMcpCommand } = await import("./mcp.js");
      return runMcpCommand(route.mcpArgs ?? [], {
        loadPi: () => import(PI_PACKAGE_NAME),
        cwd: process.cwd(),
        runPi: (args) => runPiCommand(["mcp", ...args]),
        capturePi: (args) => {
          const bin = piExecutable();
          if (bin === undefined) return { status: null, stdout: "", stderr: "", error: new Error(MISSING_PI_BIN) };
          const result = spawnSync(process.execPath, [bin, "mcp", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
          return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
        },
        columns: process.stdout.isTTY ? process.stdout.columns : Number.POSITIVE_INFINITY,
        interactive: process.stdin.isTTY === true,
        confirm,
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      });
    }
    case "config": {
      const [pi, { runConfigCommand }] = await Promise.all([import(PI_PACKAGE_NAME), import("./config.js")]);
      const cwd = process.cwd();
      return runConfigCommand(route.configArgs ?? [], {
        pi,
        cwd,
        locateAmpi: () => locateLoadedAmpi(pi, cwd),
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      });
    }
  }
  return startPi(route);
}

/**
 * Serve every session from one page until SIGINT or SIGTERM, then exit: the
 * session's timers would otherwise keep the process alive.
 *
 * @param {boolean} open
 * @returns {Promise<number>}
 */
async function runAppProcess(open) {
  const [pi, { runApp }] = await Promise.all([import(PI_PACKAGE_NAME), import("./app.js")]);
  // The process setup Pi's own executable does, so tools see they run under an agent.
  process.title = "ampi";
  process.env.PI_CODING_AGENT = "true";
  process.env.AI_AGENT = "pi";
  const stopped = new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  const code = await runApp({
    pi,
    open,
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    stopped,
  });
  process.exit(code);
}

/**
 * Serve one session for `ampi app` over the IPC channel it forked this
 * process with, then exit: the session's MCP connections and timers would
 * otherwise keep the process alive.
 *
 * @returns {Promise<number>}
 */
async function runAppWorkerProcess() {
  if (typeof process.send !== "function") {
    process.stderr.write("ampi: app --worker is started by ampi app, which talks to it over an IPC channel; it does not run on its own.\n");
    return 2;
  }
  const [pi, { runAppWorker }] = await Promise.all([import(PI_PACKAGE_NAME), import("./app-worker.js")]);
  // The process setup Pi's own executable does, so tools see they run under an agent.
  process.title = "ampi";
  process.env.PI_CODING_AGENT = "true";
  process.env.AI_AGENT = "pi";
  process.exit(await runAppWorker({ channel: /** @type {any} */ (process), pi }));
}

/**
 * The ampi that `ampi` runs in `cwd`: the one Pi loads from its settings or
 * extension directories when there is one (as `startPi` decides), else the
 * CLI's own.
 *
 * @param {any} pi
 * @param {string} cwd
 */
async function locateLoadedAmpi(pi, cwd) {
  const { enabled } = await listPiExtensionSources(pi, cwd);
  for (const entry of enabled) {
    const found = path.isAbsolute(entry.path) ? readPackageAt(entry.path) : undefined;
    if (found?.name === AMPI_PACKAGE_NAME) return found;
  }
  return locateAmpiPackage(CLI_ROOT);
}

/**
 * Ask a yes/no question on stderr and read the answer from stdin; anything
 * but y or yes, or the end of stdin, is no.
 *
 * @param {string} question
 * @returns {Promise<boolean>}
 */
async function confirm(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => {
    prompt.once("close", () => resolve(""));
    prompt.question(question, resolve);
  });
  prompt.close();
  return /^y(?:es)?$/i.test(String(answer).trim());
}

/**
 * Run a thread command; the ones that open a session start Pi on it.
 *
 * @param {string[]} threadArgs
 * @returns {Promise<number | undefined>}
 */
async function runThreads(threadArgs) {
  // A reader that stops early (`ampi threads list --json | head -1`) closes the pipe: stop quietly.
  process.stdout.on("error", (error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EPIPE") throw error;
    process.exit(0);
  });
  const pi = await import(PI_PACKAGE_NAME);
  // Loaded here, with Pi, so other commands do not load the terminal helpers it needs.
  const { runThreadsCommand } = await import("./threads.js");
  const cwd = process.cwd();
  const result = await runThreadsCommand(threadArgs, {
    pi,
    cwd,
    env: process.env,
    now: () => Date.now(),
    columns: process.stdout.isTTY ? process.stdout.columns : Number.POSITIVE_INFINITY,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    confirm,
    locateAmpi: () => locateLoadedAmpi(pi, cwd),
  });
  if ("code" in result) return result.code;
  return startPi(routeAmpiArgv(result.piArgs));
}
