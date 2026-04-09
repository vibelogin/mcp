/**
 * MCP stdio e2e — spawns the server as a child process, drives JSON-RPC
 * over stdin/stdout, and verifies the protocol surface.
 *
 * The auth flow is exercised by the loopback unit test + the console
 * /api/agent/* tests. Here we only validate:
 *   - initialize handshake
 *   - tools/list returns the 4 advertised tools
 *   - tools/call dispatches errors as isError tool results, not RPC errors
 *   - unknown methods produce -32601
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { resolve } from "path";

const ENTRY = resolve(import.meta.dir, "..", "index.ts");

let proc: Subprocess<"pipe", "pipe", "pipe">;
let nextId = 1;

interface RpcRes {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

function readResponse(): Promise<RpcRes> {
  return new Promise(async (res, rej) => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let buf = "";
    const decoder = new TextDecoder();
    const t = setTimeout(() => {
      reader.releaseLock();
      rej(new Error("timeout"));
    }, 5000);
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        clearTimeout(t);
        reader.releaseLock();
        return rej(new Error("eof"));
      }
      buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        clearTimeout(t);
        reader.releaseLock();
        try {
          return res(JSON.parse(line));
        } catch (e) {
          return rej(e as Error);
        }
      }
    }
  });
}

async function call(method: string, params?: any): Promise<RpcRes> {
  const id = nextId++;
  const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  proc.stdin.write(req);
  await proc.stdin.flush?.();
  const res = await readResponse();
  return res;
}

beforeAll(async () => {
  proc = spawn({
    cmd: ["bun", "run", ENTRY],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  }) as Subprocess<"pipe", "pipe", "pipe">;
  // Tiny delay so the readline loop is up.
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => {
  try {
    proc.kill();
  } catch {}
});

describe("mcp stdio", () => {
  test("initialize advertises tools capability", async () => {
    const res = await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    expect(res.error).toBeUndefined();
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.serverInfo.name).toBe("vibelogin-mcp");
    expect(res.result.capabilities.tools).toBeDefined();
  });

  test("tools/list returns the 4 advertised tools", async () => {
    const res = await call("tools/list");
    expect(res.error).toBeUndefined();
    const names = res.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(
      [
        "add_auth_to_project",
        "auth",
        "configure_auth",
        "create_project",
      ].sort()
    );
    // Each tool must have an inputSchema.
    for (const t of res.result.tools) {
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe("object");
    }
  });

  test("tools/call on unknown tool returns isError result", async () => {
    const res = await call("tools/call", {
      name: "does_not_exist",
      arguments: {},
    });
    // unknown_tool is reported as a JSON-RPC error (per index.ts), not isError.
    expect(res.error?.code).toBe(-32601);
  });

  test("tools/call on create_project without auth returns isError", async () => {
    const res = await call("tools/call", {
      name: "create_project",
      arguments: { name: "Should fail without auth" },
    });
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/not_authenticated/);
  });

  test("unknown method returns -32601", async () => {
    const res = await call("does/not/exist");
    expect(res.error?.code).toBe(-32601);
  });

  test("ping returns empty result", async () => {
    const res = await call("ping");
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({});
  });
});
