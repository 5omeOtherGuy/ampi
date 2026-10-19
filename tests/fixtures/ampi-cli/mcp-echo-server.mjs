#!/usr/bin/env node
// A minimal MCP server for the `ampi mcp` tests: newline-delimited JSON-RPC
// over stdio, answering initialize, tools/list and tools/call with one tool,
// `echo`, which returns its `text` argument. It needs no network and no
// dependencies, and exits when stdin closes.
import { createInterface } from "node:readline";

const TOOL = {
  name: "echo",
  description: "Return the text it is given.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

/** @param {unknown} message */
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

/**
 * @param {string} method
 * @param {any} params
 * @returns {{ result: unknown } | { error: { code: number, message: string } }}
 */
function answer(method, params) {
  switch (method) {
    case "initialize":
      return {
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "ampi-echo", version: "1.0.0" },
        },
      };
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: [TOOL] } };
    case "tools/call":
      if (params?.name !== TOOL.name) return { error: { code: -32602, message: `unknown tool ${params?.name}` } };
      return { result: { content: [{ type: "text", text: String(params.arguments?.text ?? "") }] } };
    default:
      return { error: { code: -32601, message: `method not found: ${method}` } };
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  /** @type {{ id?: string | number, method?: string, params?: unknown }} */
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  // Notifications (no id), such as notifications/initialized, get no answer.
  if (request.id === undefined || typeof request.method !== "string") return;
  send({ jsonrpc: "2.0", id: request.id, ...answer(request.method, request.params) });
});
lines.on("close", () => process.exit(0));
