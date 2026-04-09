/**
 * Unit tests for the loopback OAuth helpers.
 * These exercise the pure pieces (PKCE + URL builder) and the one-shot
 * HTTP listener without spinning up a real browser or console.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";

import {
  buildAuthorizeUrl,
  challengeFor,
  generateVerifier,
  startLoopbackListener,
} from "../loopback.js";

describe("PKCE", () => {
  it("generates a verifier in the RFC 7636 length range", () => {
    const v = generateVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    // base64url alphabet only
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces unique verifiers", () => {
    const a = generateVerifier();
    const b = generateVerifier();
    expect(a).not.toBe(b);
  });

  it("computes a SHA-256 base64url challenge", () => {
    const v = "test-verifier-1234567890abcdefghijklmnopqrstuvwx";
    const expected = createHash("sha256").update(v).digest("base64url");
    expect(challengeFor(v)).toBe(expected);
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds the /agent/authorize URL with all params", () => {
    const url = buildAuthorizeUrl({
      consoleUrl: "https://app.example.com",
      challenge: "abc",
      redirectUri: "http://127.0.0.1:54321/callback",
      state: "xyz",
      clientName: "VibeLogin MCP",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://app.example.com");
    expect(parsed.pathname).toBe("/agent/authorize");
    expect(parsed.searchParams.get("challenge")).toBe("abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:54321/callback"
    );
    expect(parsed.searchParams.get("state")).toBe("xyz");
    expect(parsed.searchParams.get("client_name")).toBe("VibeLogin MCP");
  });

  it("preserves a console URL with a port", () => {
    const url = buildAuthorizeUrl({
      consoleUrl: "http://localhost:3002",
      challenge: "c",
      redirectUri: "http://127.0.0.1:1/callback",
      state: "s",
      clientName: "x",
    });
    expect(url.startsWith("http://localhost:3002/agent/authorize?")).toBe(true);
  });
});

describe("startLoopbackListener", () => {
  it("resolves with code+state on successful callback", async () => {
    const listener = await startLoopbackListener({ timeoutMs: 5000 });
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // Simulate the browser hitting our callback.
    const cbUrl = `${listener.redirectUri}?code=THE_CODE&state=THE_STATE`;
    const fetchPromise = fetch(cbUrl);
    const result = await listener.result;
    await fetchPromise; // ensure the HTTP exchange completes

    expect(result.code).toBe("THE_CODE");
    expect(result.state).toBe("THE_STATE");
  });

  it("rejects when authorization returns an error param", async () => {
    const listener = await startLoopbackListener({ timeoutMs: 5000 });
    const cbUrl = `${listener.redirectUri}?error=access_denied`;
    const fetchPromise = fetch(cbUrl).catch(() => {});
    await expect(listener.result).rejects.toThrow(/authorization_failed/);
    await fetchPromise;
  });

  it("rejects when code or state is missing", async () => {
    const listener = await startLoopbackListener({ timeoutMs: 5000 });
    const cbUrl = `${listener.redirectUri}?code=only`;
    const fetchPromise = fetch(cbUrl).catch(() => {});
    await expect(listener.result).rejects.toThrow(/missing_code_or_state/);
    await fetchPromise;
  });

  it("times out cleanly with no callback", async () => {
    const listener = await startLoopbackListener({ timeoutMs: 100 });
    await expect(listener.result).rejects.toThrow(/loopback_timeout/);
  });
});
