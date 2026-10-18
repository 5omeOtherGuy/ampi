#!/usr/bin/env node
import { runAmpi } from "../src/main.js";

// Not awaited at the top level: an interactive Pi session can end without its
// promise settling (for example when the terminal closes).
runAmpi(process.argv.slice(2)).then((code) => {
  if (code !== undefined) process.exitCode = code;
});
