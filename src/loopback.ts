/**
 * Loopback OAuth flow for the VibeLogin MCP server.
 *
 * Implements RFC 8252 §7.3 (loopback IP redirection) + RFC 7636 (PKCE S256).
 *
 * Flow:
 *   1. Generate a PKCE verifier (random 64-byte base64url) + S256 challenge
 *   2. Start a tiny HTTP server on an ephemeral port (127.0.0.1:0)
 *   3. Open the user's browser at:
 *        {console}/agent/authorize?challenge=...&redirect_uri=http://127.0.0.1:<port>/callback&state=...&client_name=...
 *   4. Wait for GET /callback?code=...&state=...
 *   5. Verify state, POST { code, codeVerifier } to {console}/api/agent/token
 *   6. Return { accessToken, expiresIn, orgId, platformUserId }
 *
 * The loopback server only handles a single request and shuts down
 * immediately after — no long-lived listener.
 *
 * This module is environment-agnostic: it exposes primitives that the
 * MCP `auth` tool wires into config + credential storage, and that
 * integration tests can drive directly without spawning a real browser.
 */

import { createServer } from "http";
import type { AddressInfo } from "net";
import { createHash, randomBytes } from "crypto";

// ── PKCE helpers ───────────────────────────────

export function generateVerifier(): string {
  // RFC 7636: 43-128 chars, base64url alphabet. 64 random bytes → 86 chars.
  return randomBytes(64).toString("base64url");
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ── Callback listener ──────────────────────────

export interface CallbackResult {
  code: string;
  state: string;
}

export interface StartedLoopback {
  port: number;
  redirectUri: string;
  /** Resolves with the callback result, or rejects on timeout / error. */
  result: Promise<CallbackResult>;
  /** Forcibly stop the listener (tests use this to clean up). */
  close: () => void;
}

/**
 * Start a one-shot HTTP listener on 127.0.0.1 and wait for the OAuth
 * callback. The returned promise rejects if no callback arrives before
 * `timeoutMs` (default 5 minutes).
 */
export function startLoopbackListener(
  opts: { timeoutMs?: number } = {}
): Promise<StartedLoopback> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let pending: { res: (r: CallbackResult) => void; rej: (e: Error) => void } | null =
      null;

    const server = createServer((req, httpRes) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          httpRes.writeHead(404).end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          httpRes
            .writeHead(400, { "Content-Type": "text/plain" })
            .end(`Authorization failed: ${error}`);
          pending?.rej(new Error(`authorization_failed: ${error}`));
          return;
        }
        if (!code || !state) {
          httpRes
            .writeHead(400, { "Content-Type": "text/plain" })
            .end("Missing code or state");
          pending?.rej(new Error("missing_code_or_state"));
          return;
        }

        httpRes
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(
            `<!doctype html><html><body style="font-family:sans-serif;padding:40px">
              <h2>Authorization complete</h2>
              <p>You can close this window and return to your editor.</p>
            </body></html>`
          );
        pending?.res({ code, state });
      } catch (err: any) {
        httpRes.writeHead(500).end(String(err?.message ?? err));
        pending?.rej(err);
      } finally {
        // Always shut down after the first request — loopback is one-shot.
        server.close();
      }
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        server.close();
        // Reject the right promise: before listen() has fired, the outer
        // setup promise is still pending; after, `pending` is wired up
        // and we must reject the listener.result promise instead.
        if (pending) {
          pending.rej(new Error("loopback_timeout"));
        } else {
          reject(new Error("loopback_timeout"));
        }
      }
    }, timeoutMs);

    server.on("error", (err) => {
      if (!settled) {
        clearTimeout(timeout);
        reject(err);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const result = new Promise<CallbackResult>((res, rej) => {
        pending = {
          res: (r) => {
            settled = true;
            clearTimeout(timeout);
            res(r);
          },
          rej: (e) => {
            settled = true;
            clearTimeout(timeout);
            rej(e);
          },
        };
      });

      resolve({
        port,
        redirectUri,
        result,
        close: () => {
          clearTimeout(timeout);
          server.close();
        },
      });
    });
  });
}

// ── Authorize URL builder ──────────────────────

export function buildAuthorizeUrl(input: {
  consoleUrl: string;
  challenge: string;
  redirectUri: string;
  state: string;
  clientName: string;
}): string {
  const url = new URL("/agent/authorize", input.consoleUrl);
  url.searchParams.set("challenge", input.challenge);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("client_name", input.clientName);
  return url.toString();
}

// ── Token exchange ─────────────────────────────

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn: number;
  orgId: string;
  platformUserId: string;
}

export async function exchangeCodeForToken(input: {
  consoleUrl: string;
  code: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const res = await fetch(`${input.consoleUrl}/api/agent/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: input.code, codeVerifier: input.codeVerifier }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new Error(
      `token_exchange_failed: ${body?.code ?? res.status} — ${body?.error ?? ""}`
    );
  }
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    tokenType: body.tokenType,
    expiresIn: body.expiresIn,
    orgId: body.orgId,
    platformUserId: body.platformUserId,
  };
}

/**
 * Exchange a refresh token for a new access token (and a rotated
 * refresh token). Returns the same shape as exchangeCodeForToken.
 */
export async function refreshAccessToken(input: {
  consoleUrl: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const res = await fetch(`${input.consoleUrl}/api/agent/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: input.refreshToken }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new Error(
      `refresh_failed: ${body?.code ?? res.status} — ${body?.error ?? ""}`
    );
  }
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    tokenType: body.tokenType,
    expiresIn: body.expiresIn,
    orgId: body.orgId,
    platformUserId: body.platformUserId,
  };
}
