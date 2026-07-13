import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core feature gate registry", () => {
  it("returns named reasons for known reserved MMR gates and tags them with ampi-core.reserved", async () => {
    const { resolveMmrFeatureGates } = await importSource("extensions/ampi-core/feature-gates.ts");

    const decisions = resolveMmrFeatureGates([
      "ampi-subagents",
      "ampi-history",
      "ampi-web",
      "ampi-patch",
      "ampi-tasks",
      "ampi-toolbox-mcp",
    ]);

    assert.equal(decisions.length, 6);
    for (const decision of decisions) {
      assert.equal(decision.status, "missing");
      assert.equal(decision.source, "ampi-core.reserved");
      assert.match(decision.reason, /not yet provided/);
    }
    assert.match(decisions[0].reason, /ampi-workers/);
    assert.match(decisions[1].reason, /ampi-history/);
    assert.match(decisions[2].reason, /ampi-web/);
    assert.match(decisions[3].reason, /ampi-patch extension/);
    assert.match(decisions[4].reason, /ampi-tasks extension/);
    assert.match(decisions[5].reason, /ampi-toolbox-mcp extension/);
  });

  it("treats prototype-chain names like 'toString' as unknown gates, not reserved decisions", async () => {
    const { resolveMmrFeatureGates } = await importSource("extensions/ampi-core/feature-gates.ts");

    for (const protoName of ["toString", "constructor", "hasOwnProperty"]) {
      const [decision] = resolveMmrFeatureGates([protoName]);
      assert.equal(decision.gate, protoName);
      assert.equal(decision.status, "missing");
      assert.equal(decision.source, "ampi-core.unknown", `${protoName} must not resolve via ampi-core.reserved`);
      assert.equal(typeof decision.reason, "string");
    }
  });

  it("falls back to ampi-core.unknown for gate names with no registered provider", async () => {
    const { resolveMmrFeatureGates } = await importSource("extensions/ampi-core/feature-gates.ts");

    const [decision] = resolveMmrFeatureGates(["future-thing"]);

    assert.equal(decision.gate, "future-thing");
    assert.equal(decision.status, "missing");
    assert.equal(decision.source, "ampi-core.unknown");
    assert.match(decision.reason, /unknown/i);
  });

  it("preserves the requested order in the resolved decisions", async () => {
    const { resolveMmrFeatureGates } = await importSource("extensions/ampi-core/feature-gates.ts");

    const decisions = resolveMmrFeatureGates(["ampi-toolbox-mcp", "ampi-subagents", "totally-unknown"]);
    assert.deepEqual(
      decisions.map((d) => d.gate),
      ["ampi-toolbox-mcp", "ampi-subagents", "totally-unknown"],
    );
  });

  it("lets registered providers override reserved decisions and supports enabled/disabled status", async () => {
    const { createMmrFeatureGateRegistry } = await importSource("extensions/ampi-core/feature-gates.ts");

    const registry = createMmrFeatureGateRegistry();
    registry.registerProvider({
      name: "test-provider",
      evaluate(gate) {
        if (gate === "ampi-subagents") return { gate, status: "enabled", reason: "test override" };
        if (gate === "ampi-history") return { gate, status: "disabled", reason: "explicitly disabled" };
        return undefined;
      },
    });

    const decisions = registry.resolve(["ampi-subagents", "ampi-history", "ampi-toolbox-mcp"]);
    assert.deepEqual(decisions[0], {
      gate: "ampi-subagents",
      status: "enabled",
      reason: "test override",
      source: "test-provider",
    });
    assert.deepEqual(decisions[1], {
      gate: "ampi-history",
      status: "disabled",
      reason: "explicitly disabled",
      source: "test-provider",
    });
    // unaffected reserved gate still goes through ampi-core.reserved
    assert.equal(decisions[2].source, "ampi-core.reserved");
    assert.equal(decisions[2].status, "missing");
  });

  it("isolated registries do not leak provider registrations across instances", async () => {
    const { createMmrFeatureGateRegistry } = await importSource(
      "extensions/ampi-core/feature-gates.ts",
    );

    const a = createMmrFeatureGateRegistry();
    const b = createMmrFeatureGateRegistry();
    a.registerProvider({
      name: "scoped",
      evaluate(gate) {
        return { gate, status: "enabled", reason: "scoped" };
      },
    });

    assert.equal(a.resolve(["ampi-toolbox-mcp"])[0].status, "enabled");
    assert.equal(b.resolve(["ampi-toolbox-mcp"])[0].status, "missing");
    assert.equal(b.resolve(["ampi-toolbox-mcp"])[0].source, "ampi-core.reserved");
  });

  it("getProviders() exposes both built-in providers (ampi-core.reserved and ampi-core.unknown) plus registered ones", async () => {
    const { createMmrFeatureGateRegistry } = await importSource(
      "extensions/ampi-core/feature-gates.ts",
    );

    const registry = createMmrFeatureGateRegistry();
    const builtins = registry.getProviders().map((p) => p.name);
    assert.ok(builtins.includes("ampi-core.reserved"), `expected ampi-core.reserved in ${builtins}`);
    assert.ok(builtins.includes("ampi-core.unknown"), `expected ampi-core.unknown in ${builtins}`);

    registry.registerProvider({ name: "plugged-in", evaluate: () => undefined });
    const after = registry.getProviders().map((p) => p.name);
    assert.deepEqual(after, [...builtins, "plugged-in"]);
  });
});

describe("mmr-core runtime + root public feature gate API", () => {
  it("root resolveMmrFeatureGates is runtime-bound and reflects registerMmrFeatureGateProvider", async () => {
    const root = await importSource("index.ts");

    // Use a test-only gate name that is not declared by any real mode, so the
    // permanent runtime registration below cannot affect mode resolution in
    // other test suites that share the same module instance.
    const TEST_GATE = "public-api-test-gate";

    // Baseline: an unknown gate flows through to the ampi-core.unknown built-in.
    const before = root.resolveMmrFeatureGates([TEST_GATE]);
    assert.equal(before[0].status, "missing");
    assert.equal(before[0].source, "ampi-core.unknown");

    root.registerMmrFeatureGateProvider({
      name: "public-api-test",
      evaluate(gate) {
        if (gate === TEST_GATE) return { gate, status: "enabled", reason: "public override" };
        return undefined;
      },
    });

    const after = root.resolveMmrFeatureGates([TEST_GATE, "another-unclaimed-gate"]);
    assert.equal(after[0].status, "enabled");
    assert.equal(after[0].source, "public-api-test");
    assert.equal(after[0].reason, "public override");
    // Other unclaimed gates still flow to the unknown built-in.
    assert.equal(after[1].source, "ampi-core.unknown");
    assert.equal(after[1].status, "missing");
  });
});

describe("mmr-core runtime feature gate registry", () => {
  it("exposes a registry that influences runtime gate resolution", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/ampi-core/runtime.ts");

    const runtime = createMmrCoreRuntime();

    const before = runtime.resolveFeatureGates(["ampi-subagents"]);
    assert.equal(before[0].status, "missing");
    assert.equal(before[0].source, "ampi-core.reserved");

    runtime.registerFeatureGateProvider({
      name: "runtime-test",
      evaluate(gate) {
        if (gate === "ampi-subagents") return { gate, status: "enabled", reason: "runtime override" };
        return undefined;
      },
    });

    const after = runtime.resolveFeatureGates(["ampi-subagents"]);
    assert.equal(after[0].status, "enabled");
    assert.equal(after[0].source, "runtime-test");
    assert.equal(after[0].reason, "runtime override");
  });

  it("exports registerMmrFeatureGateProvider and resolveMmrFeatureGates from the package root", async () => {
    const root = await importSource("index.ts");
    assert.equal(typeof root.registerMmrFeatureGateProvider, "function");
    assert.equal(typeof root.resolveMmrFeatureGates, "function");
  });
});

describe("mmr-core persisted state with feature gate decisions", () => {
  it("uses caller-supplied feature gate decisions instead of recomputing them", async () => {
    const { createMmrModeState } = await importSource("extensions/ampi-core/state.ts");
    const { getMmrMode } = await importSource("extensions/ampi-core/modes.ts");

    const state = createMmrModeState({
      mode: getMmrMode("medium"),
      source: "command",
      modelResolution: {
        targetModel: "gpt-5.5",
        requestedModels: ["gpt-5.5"],
        selectedProvider: "openai",
        selectedModel: "gpt-5.5",
        modelFound: true,
        modelApplied: true,
        fallbackApplied: false,
        candidates: [],
      },
      tools: { requestedTools: [], activeTools: [], missingTools: [], decisions: [] },
      featureGateDecisions: [
        { gate: "ampi-subagents", status: "enabled", reason: "shipped", source: "test" },
        { gate: "ampi-toolbox-mcp", status: "disabled", reason: "off", source: "test" },
      ],
      appliedAt: "2026-05-08T00:00:00.000Z",
    });

    assert.deepEqual(state.resolution.featureGateDecisions, [
      { gate: "ampi-subagents", status: "enabled", reason: "shipped", source: "test" },
      { gate: "ampi-toolbox-mcp", status: "disabled", reason: "off", source: "test" },
    ]);
  });
});
