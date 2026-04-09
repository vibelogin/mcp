#!/usr/bin/env bun
/**
 * VibeLogin MCP server — stdio transport.
 *
 * Implements just enough of the Model Context Protocol to be discoverable
 * and callable by Cursor, Claude Desktop, Windsurf, Cline, and Claude Code:
 *
 *   - initialize           → handshake, advertise protocolVersion + server info
 *   - tools/list           → return our 4 tool definitions
 *   - tools/call           → dispatch to the matching handler
 *   - notifications/*      → ignored (server → client only)
 *
 * Transport: one JSON-RPC 2.0 message per line on stdin/stdout.
 * Logging: written to stderr, never stdout (would corrupt the protocol).
 *
 * We deliberately avoid depending on @modelcontextprotocol/sdk. The
 * protocol subset we use is stable and tiny, and zero deps means the
 * package is instantly runnable via `bunx vibelogin-mcp` with no install.
 */

import { createInterface } from "readline";

import { MCPToolError, tools } from "./tools.js";

// ── Protocol types ─────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SERVER_INFO = {
  name: "vibelogin-mcp",
  version: "0.1.0",
};

// Matches the MCP protocol version at the time of writing. Clients
// that speak a newer version will still negotiate down to ours.
const PROTOCOL_VERSION = "2024-11-05";

// ── Dispatch ───────────────────────────────────

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize": {
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
          capabilities: {
            tools: {},
          },
        });
      }

      case "initialized":
      case "notifications/initialized": {
        // Notifications have no id → no response.
        return null;
      }

      case "tools/list": {
        return ok(id, {
          tools: tools.map((t) => t.def),
        });
      }

      case "tools/call": {
        const name = req.params?.name as string | undefined;
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const tool = tools.find((t) => t.def.name === name);
        if (!tool) {
          return err(id, -32601, `unknown_tool: ${name}`);
        }
        try {
          const result = await tool.handler(args as any);
          return ok(id, result);
        } catch (e: any) {
          // Convert handler errors into isError:true tool results so the
          // agent gets a structured message rather than a protocol error.
          // MCPToolError adds a machine-readable code (and optional details)
          // so callers can branch on the failure mode.
          const isStructured = e instanceof MCPToolError;
          const code = isStructured ? e.code : "INTERNAL_ERROR";
          const message = e?.message ?? String(e);
          const details = isStructured ? e.details : undefined;
          return ok(id, {
            isError: true,
            structuredContent: {
              code,
              message,
              ...(details ? { details } : {}),
            },
            content: [
              { type: "text", text: `[${code}] ${message}` },
            ],
          });
        }
      }

      case "ping": {
        return ok(id, {});
      }

      default: {
        // Notifications (method starts with "notifications/") have no id
        // and must not be answered.
        if (req.id === undefined) return null;
        return err(id, -32601, `method_not_found: ${req.method}`);
      }
    }
  } catch (e: any) {
    return err(id, -32603, `internal_error: ${e?.message ?? String(e)}`);
  }
}

function ok(id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(
  id: JsonRpcResponse["id"],
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ── stdio loop ─────────────────────────────────

function write(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + "\n");
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      write(err(null, -32700, "parse_error"));
      continue;
    }
    const res = await handleRequest(req);
    if (res) write(res);
  }
}

main().catch((e) => {
  process.stderr.write(
    `[vibelogin-mcp] fatal: ${e?.message ?? String(e)}\n`
  );
  process.exit(1);
});
