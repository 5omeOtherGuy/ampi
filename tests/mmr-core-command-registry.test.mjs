// Palette command registry: id validation, replace-on-reregister, change
// notifications, availability states, and fuzzy ranking.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const REGISTRY_MODULE = "extensions/ampi-core/command-registry.ts";
const ctx = {};

function command(id, fields = {}) {
  const [noun, ...rest] = id.split(".");
  return { id, noun, verb: rest.join(" "), description: `${id} command`, run: () => {}, ...fields };
}

describe("command registry", () => {
  beforeEach(async () => {
    (await importSource(REGISTRY_MODULE)).__resetMmrCommandsForTests();
  });

  it("accepts dotted lowerCamel ids and rejects everything else", async () => {
    const { registerMmrCommand, getMmrCommands } = await importSource(REGISTRY_MODULE);
    for (const id of ["thread.new", "thread.switchToPrevious", "prompt.openInEditor", "a.b.c", "ide2.connect"]) {
      registerMmrCommand(command(id));
    }
    for (const id of ["thread", "Thread.new", "thread.New", "thread.", ".new", "thread..new", "1thread.new", "thread.new-x", "thread.new "]) {
      assert.throws(() => registerMmrCommand(command(id)), /Invalid command id/, id);
    }
    assert.deepEqual(
      getMmrCommands().map((c) => c.id),
      ["thread.new", "thread.switchToPrevious", "prompt.openInEditor", "a.b.c", "ide2.connect"],
    );
  });

  it("rejects an empty noun, verb or description and an unparsable defaultKey", async () => {
    const { registerMmrCommand, getMmrCommands } = await importSource(REGISTRY_MODULE);
    assert.throws(() => registerMmrCommand(command("thread.new", { noun: " " })), /non-empty noun/);
    assert.throws(() => registerMmrCommand(command("thread.new", { verb: "" })), /non-empty verb/);
    assert.throws(() => registerMmrCommand(command("thread.new", { description: "" })), /non-empty description/);
    assert.throws(() => registerMmrCommand(command("thread.new", { defaultKey: "hyper+n" })), /invalid defaultKey/);
    assert.throws(() => registerMmrCommand(command("thread.new", { defaultKey: ["ctrl+n", "ctrl+"] })), /invalid defaultKey/);
    assert.deepEqual(getMmrCommands(), []);
    registerMmrCommand(command("thread.new", { defaultKey: ["ctrl+n", "<leader>n"] }));
    assert.equal(getMmrCommands().length, 1);
  });

  it("replaces a re-registered id in place and reports each change", async () => {
    const { registerMmrCommand, unregisterMmrCommand, getMmrCommands, getMmrCommand, onMmrCommandsChanged } =
      await importSource(REGISTRY_MODULE);
    const events = [];
    const stop = onMmrCommandsChanged((event) => events.push(event));

    registerMmrCommand(command("thread.new"));
    registerMmrCommand(command("mode.toggle"));
    const replacement = command("thread.new", { description: "Start over" });
    registerMmrCommand(replacement);

    assert.deepEqual(
      getMmrCommands().map((c) => c.id),
      ["thread.new", "mode.toggle"],
    );
    assert.equal(getMmrCommand("thread.new"), replacement);
    assert.equal(getMmrCommand("thread.missing"), undefined);

    assert.equal(unregisterMmrCommand("mode.toggle"), true);
    assert.equal(unregisterMmrCommand("mode.toggle"), false);
    stop();
    registerMmrCommand(command("thread.switch"));

    assert.deepEqual(events, [
      { change: "registered", id: "thread.new" },
      { change: "registered", id: "mode.toggle" },
      { change: "replaced", id: "thread.new" },
      { change: "unregistered", id: "mode.toggle" },
    ]);
  });

  it("keeps the change and the remaining listeners when a listener throws", async () => {
    const { registerMmrCommand, getMmrCommand, onMmrCommandsChanged } = await importSource(REGISTRY_MODULE);
    const events = [];
    onMmrCommandsChanged(() => {
      throw new Error("listener failed");
    });
    onMmrCommandsChanged((event) => events.push(event));

    const definition = command("thread.new");
    registerMmrCommand(definition);

    assert.equal(getMmrCommand("thread.new"), definition);
    assert.deepEqual(events, [{ change: "registered", id: "thread.new" }]);
  });

  it("is shared across separately loaded module copies", async () => {
    const first = await importSource(REGISTRY_MODULE);
    const second = await importSource(REGISTRY_MODULE);
    first.registerMmrCommand(command("thread.new"));
    assert.deepEqual(
      second.getMmrCommands().map((c) => c.id),
      ["thread.new"],
    );
  });

  it("exports the registry and its Ampi aliases from the package root", async () => {
    const root = await importSource("index.ts");
    assert.equal("MMR_EVENT_COMMANDS_CHANGED" in root, false);
    assert.equal(root.registerAmpiCommand, root.registerMmrCommand);
    assert.equal(root.rankAmpiCommands, root.rankMmrCommands);
  });
});

describe("rankMmrCommands", () => {
  it("prefers a tight word-start match over an earlier, scattered one", async () => {
    const { rankMmrCommands } = await importSource(REGISTRY_MODULE);
    const commands = [
      command("settings.showManaged", { verb: "show managed", description: "List settings set by an administrator" }),
      command("thread.switch", { description: "Open another thread" }),
      command("thread.new", { description: "Start a fresh thread" }),
    ];
    const ranked = rankMmrCommands(commands, "sw", { ctx });
    assert.deepEqual(
      ranked.map((row) => row.command.id),
      ["thread.switch", "settings.showManaged"],
    );
    assert.ok(ranked[0].score < ranked[1].score);
  });

  it("keeps registration order for an empty query, unavailable rows last, hidden rows never", async () => {
    const { rankMmrCommands } = await importSource(REGISTRY_MODULE);
    const commands = [
      command("thread.switch"),
      command("mcp.info", { availability: () => ({ state: "unavailable", reason: "No servers set up" }) }),
      command("speed.toggleFast", { availability: () => ({ state: "hidden" }) }),
      command("debug.copy"),
      command("ampi.help"),
    ];
    assert.deepEqual(
      rankMmrCommands(commands, "   ", { ctx }).map((row) => [row.command.id, row.state, row.reason, row.score]),
      [
        ["thread.switch", "available", undefined, 0],
        ["debug.copy", "available", undefined, 0],
        ["ampi.help", "available", undefined, 0],
        ["mcp.info", "unavailable", "No servers set up", 0],
      ],
    );
  });

  it("puts an unavailable command after available ones even when it matches better", async () => {
    const { rankMmrCommands } = await importSource(REGISTRY_MODULE);
    const seen = [];
    const commands = [
      command("settings.showManaged", { verb: "show managed", description: "List settings set by an administrator" }),
      command("thread.switch", {
        description: "Open another thread",
        availability: (context) => {
          seen.push(context);
          return { state: "unavailable", reason: "No other threads" };
        },
      }),
      command("thread.hiddenSwitch", { verb: "switch", availability: () => ({ state: "hidden" }) }),
    ];
    const ranked = rankMmrCommands(commands, "sw", { ctx });
    assert.deepEqual(
      ranked.map((row) => [row.command.id, row.state, row.reason]),
      [
        ["settings.showManaged", "available", undefined],
        ["thread.switch", "unavailable", "No other threads"],
      ],
    );
    assert.equal(seen[0], ctx);
  });

  it("matches keywords and requires every query word to match", async () => {
    const { rankMmrCommands } = await importSource(REGISTRY_MODULE);
    const commands = [
      command("thread.new", { description: "Start a fresh thread" }),
      command("mode.toggle", { verb: "switch", description: "Cycle the agent mode", keywords: ["dial"] }),
      command("thread.switch", { description: "Open another thread" }),
    ];
    assert.deepEqual(
      rankMmrCommands(commands, "dial", { ctx }).map((row) => row.command.id),
      ["mode.toggle"],
    );
    assert.deepEqual(
      rankMmrCommands(commands, "thread switch", { ctx }).map((row) => row.command.id),
      ["thread.switch"],
    );
  });

  it("ranks the command named by the query, or the shorter label on a tie, before longer ones", async () => {
    const { rankMmrCommands } = await importSource(REGISTRY_MODULE);
    const commands = [
      command("thread.switchToPrevious", { verb: "switch to previous", description: "Go back to the session you switched away from" }),
      command("thread.switchToNext", { verb: "switch to next", description: "Go forward again after switching to the previous session" }),
      command("thread.switch", { verb: "switch", description: "Pick another session and switch to it" }),
    ];
    for (const query of ["thread switch", "Thread  Switch", "switch", "thread sw"]) {
      assert.equal(rankMmrCommands(commands, query, { ctx })[0].command.id, "thread.switch", query);
    }
    assert.deepEqual(
      rankMmrCommands(commands, "thread switch to next", { ctx }).map((row) => row.command.id),
      ["thread.switchToNext"],
    );
    assert.deepEqual(
      rankMmrCommands(commands, "", { ctx }).map((row) => row.command.id),
      ["thread.switchToPrevious", "thread.switchToNext", "thread.switch"],
    );
  });

  it("treats every command as available when no ctx is given", async () => {
    const { rankMmrCommands } = await importSource(REGISTRY_MODULE);
    const commands = [
      command("mcp.info", { availability: () => ({ state: "unavailable", reason: "No servers set up" }) }),
      command("speed.toggleFast", { availability: () => ({ state: "hidden" }) }),
      command("thread.switch"),
    ];
    assert.deepEqual(
      rankMmrCommands(commands, "").map((row) => [row.command.id, row.state]),
      [
        ["mcp.info", "available"],
        ["speed.toggleFast", "available"],
        ["thread.switch", "available"],
      ],
    );
  });

  it("treats a throwing availability check as unavailable", async () => {
    const { rankMmrCommands } = await importSource(REGISTRY_MODULE);
    const commands = [
      command("thread.rename", {
        availability: () => {
          throw new Error("no session");
        },
      }),
    ];
    assert.deepEqual(
      rankMmrCommands(commands, "", { ctx }).map((row) => [row.state, row.reason]),
      [["unavailable", "availability check failed: no session"]],
    );
  });
});
