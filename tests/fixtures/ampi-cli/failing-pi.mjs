// Test-only preload (`node --import`): replaces the Pi package with a module
// that fails after it has loaded, outside any promise the command awaits: with
// AMPI_TEST_PI_FAILURE=reject a promise rejects with no handler, with
// AMPI_TEST_PI_FAILURE=throw a callback throws. It exports nothing, so the
// command's own use of the package fails too.
import { registerHooks } from "node:module";

const failure = process.env.AMPI_TEST_PI_FAILURE;
if (failure !== "reject" && failure !== "throw") throw new Error("failing Pi: AMPI_TEST_PI_FAILURE must be reject or throw");

const source =
  failure === "reject"
    ? 'setImmediate(() => { Promise.reject(new Error("failing Pi: rejected")); });'
    : 'setImmediate(() => { throw new Error("failing Pi: thrown"); });';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
