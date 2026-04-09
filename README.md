# @vibelogin/mcp

Add authentication to your app without leaving your IDE. MCP server for Cursor, Claude Code, Windsurf, and Cline.

Just say **"add authentication to my app"** — the agent creates your project, configures auth methods, wires up Google OAuth, and scaffolds a working sign-in flow into your codebase. All from your editor's chat.

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
      "args": ["@vibelogin/mcp"]
    }
  }
}
```

### Windsurf / Cline / Zed

Same shape — every MCP client accepts a `command` + `args` block. The one-liner above works in all of them.

That's it — no environment variables needed. Defaults point to production automatically.

---

## Authentication

On first use, a browser window opens for one-click consent. After that, you're authenticated for 30 days — no further prompts.

---

## Tools

The agent picks the right tools automatically based on your conversation. Just say what you need.

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

## Example conversations

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

## Security

- **No secrets in the agent** — authentication uses loopback OAuth + PKCE (RFC 8252)
- **Single-use authorization codes** with 2-minute TTL
- **Rotated refresh tokens** — every refresh invalidates the previous one
- **Credentials stored securely** — `chmod 600` on `~/.vibelogin/credentials.json`

---

## Supported frameworks

| Framework | Status |
| --- | --- |
| Next.js (App Router) | Fully supported |
| Vite + React | Fully supported |
| Remix, Astro, Express | Coming soon |

---

## License

Apache-2.0
