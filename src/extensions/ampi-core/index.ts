import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMmrModeController } from "./mode-controller.js";
import { registerMmrCommands } from "./command-registration.js";
import { registerMmrLifecycleHooks } from "./lifecycle-hooks.js";
import { registerMmrLiveRegistry } from "./live-registry.js";
import { MMR_FAST_FLAG } from "./speed.js";

export default function mmrCoreExtension(pi: ExtensionAPI): void {
  pi.registerFlag("ampi-mode", {
    description: "Start with an ampi mode: low, medium, high, ultra, free, or a registered mode's key or label",
    type: "string",
  });

  pi.registerFlag("mmr-mode", {
    description: "Legacy alias for --ampi-mode.",
    type: "string",
  });

  pi.registerFlag("ampi-subagent", {
    description: "Run as an ampi subagent worker with a named profile (e.g. finder). Bypasses user-facing ampi locked modes.",
    type: "string",
  });

  pi.registerFlag("mmr-subagent", {
    description: "Legacy alias for --ampi-subagent.",
    type: "string",
  });

  pi.registerFlag("ampi-parent-mode", {
    description: "Parent ampi mode metadata for mode-derived subagent workers.",
    type: "string",
  });

  pi.registerFlag("mmr-parent-mode", {
    description: "Legacy alias for --ampi-parent-mode.",
    type: "string",
  });

  pi.registerFlag(MMR_FAST_FLAG, {
    description: "Start a new session at fast speed: priority serving where the provider offers it, at a higher price",
    type: "boolean",
  });

  // Registration order is observable and load-bearing (pinned by
  // tests/mmr-core-registration-order.test.mjs): flags, then the commands and
  // shortcuts, then the lifecycle hooks, then the live registry's hooks (after
  // the mode is resolved at session start), then the mode registry's
  // shutdown hook. The controller owns all shared mutable mode state; the
  // registration modules talk to it through accessors only.
  const controller = createMmrModeController(pi);
  registerMmrCommands(pi, controller);
  registerMmrLifecycleHooks(pi, controller);
  registerMmrLiveRegistry(pi);
  // Registered modes belong to the session's extension runtime: Pi runs every
  // factory again after a reload or a session replacement.
  pi.on("session_shutdown", async () => {
    controller.shutdown();
  });
  // The controller listens for mode registrations over pi.events from here
  // on; extensions loaded before ampi-core send theirs again now.
  controller.getModeRegistryEvents().emitReady();
}
