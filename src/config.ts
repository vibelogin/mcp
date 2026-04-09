/**
 * Runtime configuration for the VibeLogin MCP server.
 *
 * Environment variables (all optional, defaults point to production):
 *   VIBELOGIN_API_URL     — Hono API base URL       (default https://api.vibelogin.com)
 *   VIBELOGIN_CONSOLE_URL — Console base URL         (default https://app.vibelogin.com)
 *   VIBELOGIN_HOME        — Credentials directory    (default ~/.vibelogin)
 *
 * These can be overridden per-user in the MCP client config
 * (e.g., cursor settings), which is the normal way to point at
 * staging or a local dev instance.
 */

import { homedir } from "os";
import { join } from "path";

export const config = {
  apiUrl:
    process.env.VIBELOGIN_API_URL?.replace(/\/$/, "") ||
    "https://api.vibelogin.com",
  consoleUrl:
    process.env.VIBELOGIN_CONSOLE_URL?.replace(/\/$/, "") ||
    "https://app.vibelogin.com",
  home:
    process.env.VIBELOGIN_HOME ||
    join(homedir(), ".vibelogin"),
};

export const credentialsPath = join(config.home, "credentials.json");
