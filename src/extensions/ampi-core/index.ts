import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMmrModeController } from "./mode-controller.js";
import { registerMmrCommands } from "./command-registration.js";
import { registerMmrLifecycleHooks } from "./lifecycle-hooks.js";

export default function mmrCoreExtension(pi: ExtensionAPI): void {
  pi.registerFlag("ampi-mode", {
    description: "Start with an ampi mode: smart, fable, rush, deep, or free",
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

  // Registration order is observable and load-bearing (pinned by
  // tests/mmr-core-registration-order.test.mjs): flags, then the commands and
  // shortcuts, then the lifecycle hooks. The controller owns all shared mutable
  // mode state; the registration modules talk to it through accessors only.
  const controller = createMmrModeController(pi);
  registerMmrCommands(pi, controller);
  registerMmrLifecycleHooks(pi, controller);
}
