# @vibelogin/mcp

VibeLogin MCP server — zero-touch auth setup for AI coding agents (Cursor, Claude Desktop, Claude Code, Windsurf, Cline, Zed, …).

Spin up a VibeLogin project, configure auth methods, wire up Google OAuth, and scaffold a working sign-in flow into your codebase — all from inside your editor's chat, without leaving the IDE.

---

## What it does

This is a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes VibeLogin as a set of tools any MCP-capable agent can call. The agent decides *when* to use them based on the conversation; you just say "add login to my app" and it takes care of the rest.

The server runs as a local subprocess over stdio, talks to the VibeLogin console via a loopback OAuth flow (RFC 8252 + PKCE S256), and caches a refresh token under `~/.vibelogin/credentials.json` so you only authorize once per month.

---

## Install

No global install needed. Wire it into your MCP client config once and it runs on demand via `bunx`.

---

## Client configuration

> **One snippet works in every client.** Paste this into your MCP settings and you're done.

```json
{
  "mcpServers": {
    "vibelogin": {
      "command": "bunx",
      "args": ["@vibelogin/mcp"]
    }
  }
}
```

The first tool call opens a browser for one-click consent. After that, tokens are cached under `~/.vibelogin/credentials.json` — you won't be asked to log in again for 30 days.

### Claude Desktop / Claude Code

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "vibelogin": {
      "command": "bunx",
      "args": ["@vibelogin/mcp"]
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "vibelogin": {
      "command": "bunx",
      "args": ["@vibelogin/mcp"],
    }
  }
}
```

### Windsurf / Cline / Zed

Same shape — every MCP client accepts a `command` + `args` block. The one-liner above works in all of them.

### Local development against your own console

Override the defaults to point at localhost:

```json
{
  "mcpServers": {
    "vibelogin": {
      "command": "bunx",
      "args": ["@vibelogin/mcp"],
      "env": {
        "VIBELOGIN_API_URL": "http://localhost:3000",
        "VIBELOGIN_CONSOLE_URL": "http://localhost:3002"
      }
    }
  }
}
```

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIBELOGIN_API_URL` | `https://api.vibelogin.com` | API base URL — what the platform tools talk to. |
| `VIBELOGIN_CONSOLE_URL` | `https://app.vibelogin.com` | Console base URL — used for the loopback OAuth flow. |
| `VIBELOGIN_HOME` | `~/.vibelogin` | Where credentials are cached. |

All optional — defaults point to production. Override in your MCP client config to point at staging or local dev.

---

## Authentication flow

1. The agent calls a tool that needs a token.
2. If `~/.vibelogin/credentials.json` has a valid (unexpired) access token, it's used as-is.
3. If the access token is expired but a refresh token is present, the server calls `/api/agent/refresh` (no browser, ~50ms).
4. If neither works, the server runs the full **loopback OAuth flow**:
   - Spawns a one-shot HTTP listener on `127.0.0.1:<random>`
   - Generates a PKCE S256 challenge
   - Opens `https://app.vibelogin.com/agent/authorize?…` in your browser
   - You click "Approve" once
   - Receives the callback, exchanges the code, caches access + refresh tokens
5. Subsequent tool calls reuse the cached token. Refresh tokens last 30 days; access tokens last 1 hour.

The credentials file is `chmod 600` and rejected if the cached `consoleUrl` doesn't match the current `VIBELOGIN_CONSOLE_URL` (so switching between staging and prod can't reuse the wrong token).

---

## How agents decide which tool to call

Every tool definition contains an extensive `description` field with explicit *step number / preconditions / call-before / call-after* hints — the LLM running inside Cursor / Claude Desktop / Windsurf reads those when it's deciding what to do, you don't configure anything yourself.

### The standard onboarding sequence is strictly ordered

For the most common request — "add VibeLogin to my app" — the four data-modifying tools are **sequential** and must run in this order:

```
STEP 1            STEP 2              STEP 3              STEP 4
list_projects ──► create_project ──► configure_auth ──► add_auth_to_project
   (read)           (write)             (write)              (write)
   always           skip if a           enable methods        scaffold code
   first            match exists        + Google OAuth        last
```

Why each step depends on the previous:

| Step | Why it must come first |
| --- | --- |
| 1 → 2 | Without `list_projects` you can't tell whether to create or reuse — running `create_project` blindly produces duplicates. |
| 2 → 3 | `configure_auth` needs a `projectId` that only exists after creation (or lookup). |
| 3 → 4 | `add_auth_to_project` scaffolds UI for whichever methods are enabled server-side. Skipping step 3 produces a sign-in page that hits `METHOD_DISABLED` at runtime. |
| 4 = end | After step 4 the user has working code; no further VibeLogin tools should be called unless they ask for changes. |

**Re-entry points** for follow-up requests (you don't restart at step 1):

| User says | Enter at | Notes |
| --- | --- | --- |
| "What projects do I have?" | step 1 only | Read-only, stop after. |
| "I already created one in the dashboard, wire it up" | `get_project` → step 4 | Skip 1 + 2 + 3 if methods are already set. |
| "Turn on magic link" | step 3 | Need projectId — `list_projects` first if unknown. |
| "Hook up Google" | step 3 | First call without `google` to get the redirect URI; second call with credentials. |
| "Add VibeLogin to a NEW app" | step 1 | Full sequence. |

### `auth` is implicit — almost never call it manually

Every other tool calls `requireToken()` internally, which transparently runs **cached → refresh → browser-loopback** with no agent involvement. Only invoke `auth` directly when:

- The user explicitly says "log in", "sign in", "authenticate", or "switch accounts".
- A previous tool returned `code: "NOT_AUTHENTICATED"` and you want to retry interactively.

---

## Tools

The server advertises six tools via `tools/list`. Agents pick which to call based on your conversation.

### `auth`

Manually run the loopback OAuth flow. You normally won't call this — `requireToken` triggers it automatically when needed.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `clientName` | string | no | Label shown on the consent screen (default `"VibeLogin MCP"`). |
| `noBrowser` | boolean | no | Print the authorize URL to stderr instead of opening a browser. Useful for SSH / headless environments. |

### `create_project`

Creates a new VibeLogin project in your org. Returns the project's id, slug, oauthSlug, environment, publishable key, and **secret key (shown once)**.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Human-readable project name. |
| `slug` | string | no | URL-safe slug; auto-generated from `name` if omitted. |
| `environment` | enum | no | `production` \| `development` \| `staging` (default `production`). |

### `list_projects`

Lists every project in your org. Use this when the agent needs to discover what already exists before creating something new.

No parameters.

### `get_project`

Look up a single project by id, slug, or oauthSlug.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `idOrSlug` | string | yes | Project id, slug, or oauthSlug. |

### `configure_auth`

Toggle auth methods, set redirect URLs, and/or wire up Google OAuth. Field-level updates — anything you don't set is left untouched.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string | yes | The project's id. |
| `methods.emailPassword` | boolean | no | Enable email + password sign-in. |
| `methods.magicLink` | boolean | no | Enable magic link emails. |
| `methods.emailOtp` | boolean | no | Enable 6-digit email OTP codes. |
| `methods.passwordReset` | boolean | no | Enable password reset emails. |
| `methods.emailVerification` | boolean | no | Require email verification on signup. |
| `google.clientId` | string | with `google` | Google OAuth client ID (from Google Cloud Console). |
| `google.clientSecret` | string | with `google` | Google OAuth client secret. |
| `google.enabled` | boolean | no | Default `true`. |
| `redirectUrls` | string[] | no | **Overwrites** the project's allowed redirect URL list. |

If you call this without `google`, the response includes the exact Google Cloud Console URL + redirect URI you need to set up the credentials.

### `add_auth_to_project`

Scaffold a working sign-in flow into your codebase. Detects the framework from `package.json` and writes non-destructive files (existing files are skipped, never clobbered).

**Supported frameworks today:** Next.js (App Router), Vite + React.
**Refused with guidance:** Remix, Astro, Express, unknown.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `projectDir` | string | yes | Absolute path to the project root. |
| `slug` | string | yes | The project's `oauthSlug` (from `create_project`). |
| `publishableKey` | string | yes | The project's publishable key. |
| `appUrl` | string | yes | Your app's origin (e.g. `https://myapp.com`). |

#### Files written for **Next.js**

```
middleware.ts                       # hostedAuthMiddleware
app/auth/callback/route.ts          # createCallbackHandler
app/login/page.tsx                  # <VibeLogin />
.env.local.example                  # publishable key + secret placeholder
```

Next steps printed by the tool:
1. `pnpm add @vibelogin/nextjs`
2. Copy `.env.local.example` → `.env.local`, fill `VIBELOGIN_SECRET_KEY`
3. `pnpm dev` → open `/login`

#### Files written for **Vite + React**

```
src/auth/VibeLoginProvider.tsx      # context + useVibeLogin() hook
src/auth/Login.tsx                  # /login redirect to hosted UI
src/auth/Callback.tsx               # /auth/callback handler
.env.example                        # VITE_-prefixed publishable key
```

Next steps printed by the tool:
1. `pnpm add @vibelogin/react react-router-dom`
2. Wrap `<App/>` in `<VibeLoginProvider/>`
3. Add routes `/login` and `/auth/callback`
4. Copy `.env.example` → `.env.local`
5. `pnpm dev` → open `/login`

---

## Error handling

Tool failures are returned as MCP `isError: true` results with a structured payload so agents can branch on the failure mode instead of regex-matching free text:

```json
{
  "isError": true,
  "structuredContent": {
    "code": "UNSUPPORTED_FRAMEWORK",
    "message": "Automated scaffolding currently supports Next.js App Router and Vite + React. …",
    "details": { "detected": "remix", "reason": "found `@remix-run/*` in dependencies" }
  },
  "content": [
    { "type": "text", "text": "[UNSUPPORTED_FRAMEWORK] Automated scaffolding…" }
  ]
}
```

Current error codes:

| Code | When |
| --- | --- |
| `NOT_AUTHENTICATED` | Loopback flow ran but no valid token was persisted. |
| `STATE_MISMATCH` | OAuth callback `state` did not match — possible CSRF, aborted. |
| `UNSUPPORTED_FRAMEWORK` | `add_auth_to_project` could not detect a supported framework. |
| `INTERNAL_ERROR` | Anything else (`details` not populated). |

API-side failures (`api_error: <code> — <msg>`) are still returned as `INTERNAL_ERROR`; they will get their own codes in a future release.

---

## Example agent conversations

> **You:** "Add VibeLogin to this Next.js app. Email + password and Google sign-in."
>
> **Agent:** *(calls `create_project { name: "myapp", environment: "production" }`)*
> Created `myapp` (`pk_live_…`).
> *(calls `configure_auth { projectId, methods: { emailPassword: true } }`)*
> Email + password enabled. To turn on Google, I need a Client ID and Secret from Google Cloud Console — here's the redirect URI to authorize: `https://api.vibelogin.com/oauth/myapp-xyz/google/callback`.
> *(after you paste creds:)*
> *(calls `configure_auth { google: { clientId, clientSecret } }`)*
> *(calls `add_auth_to_project { projectDir: ".", slug: "myapp-xyz", publishableKey: "pk_live_…", appUrl: "https://myapp.com" }`)*
> Scaffold complete (next). Wrote `middleware.ts`, `app/auth/callback/route.ts`, `app/login/page.tsx`, `.env.local.example`. Run `pnpm add @vibelogin/nextjs && pnpm dev` and open `/login`.

> **You:** "What projects do I have already?"
>
> **Agent:** *(calls `list_projects`)*
> You have 3: `myapp` (production), `myapp-staging` (staging), `internal-tools` (development).

---

## Architecture

```
┌──────────────┐  stdio JSON-RPC  ┌────────────────┐
│  IDE / Chat  │ ───────────────► │ @vibelogin/mcp │
│  (Cursor,    │ ◄─────────────── │   subprocess   │
│   Claude…)   │                  └────────┬───────┘
└──────────────┘                           │
                                           │ HTTPS
                                           ▼
                                  ┌─────────────────┐
                                  │ console         │
                                  │ /agent/authorize│  ◄── browser loopback
                                  │ /api/agent/token│      (PKCE S256)
                                  │ /api/agent/refresh│
                                  └────────┬────────┘
                                           │ issues HS256 platform JWT
                                           ▼
                                  ┌─────────────────┐
                                  │ Hono API        │
                                  │ /v1/platform/*  │
                                  └─────────────────┘
```

- **Transport:** stdio, one JSON-RPC 2.0 message per line.
- **Logging:** stderr only (stdout would corrupt the protocol).
- **Zero deps:** no `@modelcontextprotocol/sdk` — the protocol subset we use is small and stable, and zero deps means `bunx @vibelogin/mcp` is instant.

---

## Security

- **Loopback OAuth + PKCE S256** (RFC 8252 + RFC 7636) — no client secret embedded in the agent.
- **Single-use authorization codes** with 2-minute TTL, deleted on first lookup (no brute-force window for the verifier).
- **Rotated refresh tokens** — every successful refresh invalidates the old refresh token. Replay of a leaked token after legitimate use will fail.
- **`chmod 600`** on `~/.vibelogin/credentials.json`.
- **Console-URL scoping:** the cached token is rejected if the configured `VIBELOGIN_CONSOLE_URL` doesn't match the URL it was issued against. Switching between staging and prod cannot accidentally reuse the wrong token.
- **CSRF protection:** loopback callbacks must echo the OAuth `state` value the server generated; mismatches abort with `STATE_MISMATCH`.

---

## Development

```bash
# from the monorepo root
pnpm install
pnpm --filter @vibelogin/mcp build      # tsc check (no emit)

# run the server directly (talks to local console + api)
bun packages/mcp/src/index.ts

# run the unit tests
cd packages/mcp && bun test
```

Tests cover the loopback flow (PKCE, URL builder, listener success/error/missing/timeout) and the stdio dispatcher.

---

## License

Apache-2.0
