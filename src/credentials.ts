/**
 * Credentials persistence for the VibeLogin MCP server.
 *
 * Stored at ~/.vibelogin/credentials.json with chmod 600. Holds the
 * most-recently-issued platform (typ:"agent") access token plus the
 * orgId it is scoped to, so subsequent tool calls can reuse it without
 * re-running the loopback OAuth flow.
 *
 * Schema:
 *   {
 *     accessToken: string
 *     expiresAt:   number   // unix ms
 *     orgId:       string
 *     platformUserId: string
 *     consoleUrl:  string   // remembered so we refuse to use a token
 *                            // issued against a different console
 *   }
 *
 * The file is overwritten on every new token; there is no history.
 */

import { mkdir, readFile, writeFile, chmod } from "fs/promises";
import { dirname } from "path";

import { config, credentialsPath } from "./config.js";
import { refreshAccessToken } from "./loopback.js";

export interface StoredCredentials {
  accessToken: string;
  /** Optional opaque refresh token, 30d TTL, single-use (rotated). */
  refreshToken?: string;
  /** Unix ms expiry (not unix seconds). */
  expiresAt: number;
  orgId: string;
  platformUserId: string;
  consoleUrl: string;
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await readFile(credentialsPath, "utf8");
    const parsed = JSON.parse(raw) as StoredCredentials;
    // Defensive: reject obviously bad shapes.
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.orgId !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCredentials(
  creds: StoredCredentials
): Promise<void> {
  await mkdir(dirname(credentialsPath), { recursive: true });
  await writeFile(credentialsPath, JSON.stringify(creds, null, 2), "utf8");
  // chmod 600 — only user readable. Skipped silently on Windows.
  try {
    await chmod(credentialsPath, 0o600);
  } catch {
    /* ignore */
  }
}

/**
 * Return a valid cached token for the current console, or null if
 * there is no token, it has expired, or it was issued for a different
 * console (e.g., switched from staging → production).
 */
export async function getValidToken(): Promise<StoredCredentials | null> {
  const creds = await loadCredentials();
  if (!creds) return null;
  if (creds.consoleUrl !== config.consoleUrl) return null;
  // 30-second skew so we don't hand out about-to-expire tokens.
  if (creds.expiresAt <= Date.now() + 30_000) return null;
  return creds;
}

/**
 * Attempt to refresh the cached access token using the stored refresh
 * token. Persists the rotated credentials on success. Returns the new
 * StoredCredentials, or null if there was no refresh token, the
 * console URL changed, or the refresh request failed.
 */
export async function tryRefreshToken(): Promise<StoredCredentials | null> {
  const creds = await loadCredentials();
  if (!creds) return null;
  if (creds.consoleUrl !== config.consoleUrl) return null;
  if (!creds.refreshToken) return null;

  try {
    const next = await refreshAccessToken({
      consoleUrl: config.consoleUrl,
      refreshToken: creds.refreshToken,
    });
    const updated: StoredCredentials = {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: Date.now() + next.expiresIn * 1000,
      orgId: next.orgId,
      platformUserId: next.platformUserId,
      consoleUrl: config.consoleUrl,
    };
    await saveCredentials(updated);
    return updated;
  } catch {
    return null;
  }
}
