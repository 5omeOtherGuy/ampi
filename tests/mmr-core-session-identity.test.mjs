import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const BASE_IDENTITY = Object.freeze({
  version: 1,
  cwd: "/tmp/workspace",
  sessionId: "sess-1",
  sessionName: "my-session",
  source: "session-manager",
  observedAt: "2026-05-19T00:00:00.000Z",
});

function makeIdentity(overrides = {}) {
  return { ...BASE_IDENTITY, ...overrides };
}

describe("mmr-core session identity runtime", () => {
  it("returns undefined before any identity has been set", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/mmr-core/runtime.ts");
    const runtime = createMmrCoreRuntime();
    assert.equal(runtime.getMmrSessionIdentity(), undefined);
    assert.equal(runtime.getMmrSessionIdentitySnapshot(), undefined);
  });

  it("freezes the live identity and returns a mutable snapshot", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/mmr-core/runtime.ts");
    const runtime = createMmrCoreRuntime();
    runtime.setMmrSessionIdentity(makeIdentity());

    const live = runtime.getMmrSessionIdentity();
    assert.ok(live);
    assert.equal(Object.isFrozen(live), true, "live identity must be frozen");
    assert.throws(
      () => { live.sessionId = "mutated"; },
      /read only|Cannot assign|object is not extensible|Cannot add property/i,
    );

    const snapshot = runtime.getMmrSessionIdentitySnapshot();
    assert.ok(snapshot);
    assert.equal(Object.isFrozen(snapshot), false);
    snapshot.sessionId = "mutated";
    assert.equal(runtime.getMmrSessionIdentity()?.sessionId, "sess-1",
      "mutating the snapshot must not affect the live identity");
  });

  it("uses Pi sessionId as the canonical conversation identity without a threadID or sessionID alias", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/mmr-core/runtime.ts");
    const runtime = createMmrCoreRuntime();
    runtime.setMmrSessionIdentity(makeIdentity());
    const identity = runtime.getMmrSessionIdentity();
    assert.equal(identity?.sessionId, "sess-1");
    assert.equal(Object.hasOwn(identity ?? {}, "threadID"), false);
    assert.equal(
      Object.hasOwn(identity ?? {}, "sessionID"), false,
      "the canonical field name is `sessionId` (camelCase); the legacy `sessionID` alias must not be present",
    );
  });

  it("reports change only when the resolved identity actually differs", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/mmr-core/runtime.ts");
    const runtime = createMmrCoreRuntime();

    const first = runtime.setMmrSessionIdentity(makeIdentity());
    assert.equal(first.changed, true, "first set must be reported as change");

    const dup = runtime.setMmrSessionIdentity(makeIdentity());
    assert.equal(dup.changed, false, "deeply equal re-set must not be reported as change");

    const newerObservedAt = runtime.setMmrSessionIdentity(
      makeIdentity({ observedAt: "2026-05-19T00:00:01.000Z" }),
    );
    assert.equal(
      newerObservedAt.changed,
      false,
      "observedAt-only changes must not be reported as identity changes",
    );

    const diff = runtime.setMmrSessionIdentity(makeIdentity({ sessionName: "other" }));
    assert.equal(diff.changed, true);

    const cleared = runtime.setMmrSessionIdentity(undefined);
    assert.equal(cleared.changed, true);

    const stillCleared = runtime.setMmrSessionIdentity(undefined);
    assert.equal(stillCleared.changed, false);
  });
});

describe("mmr-core session identity event subscription", () => {
  it("delivers per-handler deep clones via onMmrSessionIdentityChanged", async () => {
    const { MMR_EVENT_SESSION_IDENTITY_CHANGED, onMmrSessionIdentityChanged } =
      await importSource("extensions/mmr-core/runtime.ts");

    const bus = new Map();
    const pi = {
      events: {
        on(name, handler) {
          if (!bus.has(name)) bus.set(name, new Set());
          bus.get(name).add(handler);
          return () => bus.get(name).delete(handler);
        },
        emit(name, payload) {
          for (const h of bus.get(name) ?? []) h(payload);
        },
      },
    };

    const received = [];
    const unsub = onMmrSessionIdentityChanged(pi, (identity) => {
      received.push(identity);
    });

    const frozen = Object.freeze({ ...makeIdentity(), sessionId: "sess-2" });
    pi.events.emit(MMR_EVENT_SESSION_IDENTITY_CHANGED, frozen);

    assert.equal(received.length, 1);
    assert.equal(received[0].sessionId, "sess-2");
    assert.notStrictEqual(received[0], frozen, "handler must see a deep clone, not the live frozen ref");
    received[0].sessionId = "mutated";
    assert.equal(frozen.sessionId, "sess-2");

    pi.events.emit(MMR_EVENT_SESSION_IDENTITY_CHANGED, undefined);
    assert.equal(received.length, 2);
    assert.equal(received[1], undefined);

    pi.events.emit(MMR_EVENT_SESSION_IDENTITY_CHANGED, "garbage");
    assert.equal(received.length, 2, "non-identity payloads must be filtered out");

    unsub();
    pi.events.emit(MMR_EVENT_SESSION_IDENTITY_CHANGED, frozen);
    assert.equal(received.length, 2);
  });
});

describe("mmr-core session identity root exports", () => {
  it("exposes read and subscribe APIs from the package root without setter/provider overhead", async () => {
    const root = await importSource("index.ts");
    assert.equal(typeof root.MMR_EVENT_SESSION_IDENTITY_CHANGED, "string");
    assert.equal(typeof root.getMmrSessionIdentity, "function");
    assert.equal(typeof root.getMmrSessionIdentitySnapshot, "function");
    assert.equal(typeof root.onMmrSessionIdentityChanged, "function");
    assert.equal("registerMmrSessionIdentityProvider" in root, false,
      "sessionId is the canonical Pi/MMR identity; no threadID enrichment provider is needed");
    assert.equal("setMmrSessionIdentity" in root, false,
      "raw setter must not be exported from the package root");
  });
});

describe("mmr-core extension publishes identity on session_start", () => {
  function createCtx(overrides = {}) {
    return createMockExtensionContext({
      cwd: overrides.cwd ?? "/work/proj",
      sessionId: overrides.sessionId ?? "pi-sess-7",
      sessionName: overrides.sessionName,
    }).ctx;
  }

  function createPi() {
    return createMockPi({ activeTools: [], allTools: [] });
  }

  it("captures cwd and sessionId from ExtensionContext as canonical identity", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importSource("extensions/mmr-core/runtime.ts");
    runtime.setMmrModeState(undefined);
    // Clear identity that may have been set on the global singleton by an
    // earlier test (mirrors the existing setMmrModeState(undefined) reset).
    runtime.setMmrSessionIdentity(undefined);

    const { pi, handlers, emits } = createPi();
    extension(pi);

    const ctx = createCtx({ cwd: "/work/proj", sessionId: "pi-sess-7", sessionName: "feature-x" });
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const identity = runtime.getMmrSessionIdentity();
    assert.ok(identity, "session_start must publish an identity");
    assert.equal(identity.version, 1);
    assert.equal(identity.cwd, "/work/proj");
    assert.equal(identity.sessionId, "pi-sess-7");
    assert.equal(identity.sessionName, "feature-x");
    assert.equal(Object.hasOwn(identity, "threadID"), false);
    assert.equal(Object.hasOwn(identity, "sessionID"), false);
    assert.equal(identity.source, "pi-context");
    assert.match(identity.observedAt, /^\d{4}-\d{2}-\d{2}T/);

    const idEvent = emits.find((e) => e.name === runtime.MMR_EVENT_SESSION_IDENTITY_CHANGED);
    assert.ok(idEvent, "identity-changed event must be emitted on session_start");
    assert.equal(idEvent.data.sessionId, "pi-sess-7");
  });
});
