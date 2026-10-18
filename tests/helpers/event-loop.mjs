import { after } from "node:test";

// Code under test waits on unref'd timers (`AbortSignal.timeout`, bounded
// registry waits) so they never keep Pi alive; a running Pi always holds other
// handles. Node 22's test runner cancels a test whose only pending work is such
// a timer, so suites that await one call this to keep the event loop open until
// the file finishes.
export function holdEventLoopOpen() {
  const handle = setInterval(() => {}, 60_000);
  after(() => clearInterval(handle));
}
