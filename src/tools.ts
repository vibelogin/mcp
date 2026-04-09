/**
 * VibeLogin MCP tool definitions.
 *
 * Each tool exports two things:
 *   - `def`:     the JSON schema advertised via MCP `tools/list`
 *   - `handler`: the async function that runs when `tools/call` is invoked
 *
 * Handlers return an MCP tool result: { content: [ { type, text | ... } ] }.
 * Errors should throw — the dispatcher in index.ts converts thrown errors
 * into MCP isError:true responses so the agent gets a clean message.
 *
 * Tools:
 *   - auth                 — runs loopback OAuth, stores token in ~/.vibelogin
 *   - create_project       — POST /v1/platform/projects
 *   - configure_auth       — PATCH /v1/platform/projects/:id/config (+ Google OAuth)
 *   - add_auth_to_project  — scaffold Next.js files under a project directory
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";

import { config } from "./config.js";
import { getValidToken, saveCredentials, tryRefreshToken } from "./credentials.js";
import { VibeloginApiClient } from "./api-client.js";
import {
  buildAuthorizeUrl,
  challengeFor,
  exchangeCodeForToken,
  generateVerifier,
  startLoopbackListener,
} from "./loopback.js";
import { randomBytes } from "crypto";

// ── Shared response helpers ────────────────────

type ToolContent = { type: "text"; text: string };

function textResult(text: string): { content: ToolContent[] } {
  return { content: [{ type: "text", text }] };
}

/**
 * Structured error thrown by MCP tool handlers. The dispatcher in
 * index.ts converts these into MCP isError:true responses with both a
 * machine-readable `code` and a human-readable `message` so agents can
 * branch on the failure mode (e.g. NOT_AUTHENTICATED → re-auth) instead
 * of regex-matching free text.
 */
export class MCPToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "MCPToolError";
  }
}

async function requireToken(): Promise<string> {
  // 1. Cached, still valid → use as-is.
  const creds = await getValidToken();
  if (creds) return creds.accessToken;

  // 2. Cached but expired → try the refresh-token flow first (no browser).
  process.stderr.write(
    "[vibelogin-mcp] cached token expired or missing, attempting refresh…\n"
  );
  const refreshed = await tryRefreshToken();
  if (refreshed) {
    process.stderr.write("[vibelogin-mcp] refresh succeeded\n");
    return refreshed.accessToken;
  }

  // 3. No usable refresh token → fall back to the full loopback flow.
  process.stderr.write(
    "[vibelogin-mcp] refresh unavailable, launching browser loopback auth…\n"
  );
  await authTool.handler({});
  const fresh = await getValidToken();
  if (!fresh) {
    throw new MCPToolError(
      "NOT_AUTHENTICATED",
      "Loopback auth completed but no valid token was persisted."
    );
  }
  return fresh.accessToken;
}

// ──────────────────────────────────────────────
// Tool: auth
// ──────────────────────────────────────────────

export const authTool = {
  def: {
    name: "auth",
    description:
      "Manually authenticate with VibeLogin via loopback OAuth. " +
      "DO NOT call this proactively — every other tool already runs " +
      "auth automatically when the cached token is missing or expired " +
      "(via refresh token first, then browser loopback as a fallback). " +
      "Only call this if the user explicitly says 'log in', 'sign in', " +
      "'authenticate', 'switch accounts', or if a previous tool returned " +
      "code=NOT_AUTHENTICATED and you want to retry interactively. " +
      "Opens a browser to the console; the user clicks Approve once.",
    inputSchema: {
      type: "object",
      properties: {
        clientName: {
          type: "string",
          description: "Label shown on the consent screen.",
        },
        noBrowser: {
          type: "boolean",
          description:
            "Print the authorize URL instead of opening a browser. " +
            "Useful in headless environments and tests.",
        },
      },
      additionalProperties: false,
    },
  },
  handler: async (args: { clientName?: string; noBrowser?: boolean }) => {
    const clientName = args.clientName ?? "VibeLogin MCP";
    const verifier = generateVerifier();
    const challenge = challengeFor(verifier);
    const state = randomBytes(16).toString("base64url");

    const listener = await startLoopbackListener();
    const authorizeUrl = buildAuthorizeUrl({
      consoleUrl: config.consoleUrl,
      challenge,
      redirectUri: listener.redirectUri,
      state,
      clientName,
    });

    if (args.noBrowser) {
      process.stderr.write(`[vibelogin-mcp] open: ${authorizeUrl}\n`);
    } else {
      // Best-effort browser open; fall back to printing on failure.
      try {
        await openBrowser(authorizeUrl);
      } catch {
        process.stderr.write(
          `[vibelogin-mcp] could not open browser, visit: ${authorizeUrl}\n`
        );
      }
    }

    const callback = await listener.result;
    if (callback.state !== state) {
      throw new MCPToolError(
        "STATE_MISMATCH",
        "OAuth state mismatch — possible CSRF, aborting."
      );
    }

    const tokenRes = await exchangeCodeForToken({
      consoleUrl: config.consoleUrl,
      code: callback.code,
      codeVerifier: verifier,
    });

    await saveCredentials({
      accessToken: tokenRes.accessToken,
      refreshToken: tokenRes.refreshToken,
      expiresAt: Date.now() + tokenRes.expiresIn * 1000,
      orgId: tokenRes.orgId,
      platformUserId: tokenRes.platformUserId,
      consoleUrl: config.consoleUrl,
    });

    return textResult(
      `Signed in. Token cached at ~/.vibelogin/credentials.json (expires in ${tokenRes.expiresIn}s). Org: ${tokenRes.orgId}`
    );
  },
};

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("child_process");
  const plat = process.platform;
  const cmd =
    plat === "darwin"
      ? ["open", [url]]
      : plat === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  await new Promise<void>((res, rej) => {
    const child = spawn(cmd[0] as string, cmd[1] as string[], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", rej);
    child.on("spawn", () => {
      child.unref();
      res();
    });
  });
}

// ──────────────────────────────────────────────
// Tool: create_project
// ──────────────────────────────────────────────

export const createProjectTool = {
  def: {
    name: "create_project",
    description:
      "STEP 2 of the standard onboarding sequence. Create a new " +
      "VibeLogin project (a tenant containing users + auth config). " +
      "MUST be preceded by STEP 1 = `list_projects` so you don't " +
      "create a duplicate of an existing project. MUST be followed by " +
      "STEP 3 = `configure_auth` (to enable the auth methods the user " +
      "wants) and STEP 4 = `add_auth_to_project` (to scaffold code). " +
      "Do NOT skip ahead to step 4 with a new project — its auth " +
      "methods will be defaults until step 3 runs. Returns id, slug, " +
      "oauthSlug, publishableKey, and the secretKey (shown ONCE — " +
      "surface it to the user immediately and tell them to store it " +
      "securely; you cannot retrieve it again later). Capture id, " +
      "oauthSlug, and publishableKey from the response — you will " +
      "need them for the next two steps.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable project name." },
        slug: {
          type: "string",
          description:
            "URL-safe slug (lowercase, hyphens). Auto-generated from name if omitted.",
        },
        environment: {
          type: "string",
          enum: ["production", "development", "staging"],
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  handler: async (args: {
    name: string;
    slug?: string;
    environment?: "production" | "development" | "staging";
  }) => {
    const token = await requireToken();
    const client = new VibeloginApiClient(token);
    const created = await client.createProject({
      name: args.name,
      slug: args.slug,
      environment: args.environment,
    });

    return textResult(
      [
        `Project created: ${created.project.name} (${created.project.slug})`,
        ``,
        `  id:              ${created.project.id}`,
        `  environment:     ${created.project.environment}`,
        `  publishableKey:  ${created.keys.publishableKey}`,
        `  secretKey:       ${created.keys.secretKey}`,
        ``,
        `⚠️  The secret key is shown ONCE. Store it securely (env var, secret manager).`,
      ].join("\n")
    );
  },
};

// ──────────────────────────────────────────────
// Tool: configure_auth
// ──────────────────────────────────────────────

export const configureAuthTool = {
  def: {
    name: "configure_auth",
    description:
      "STEP 3 of the standard onboarding sequence (after STEP 1 " +
      "`list_projects` and STEP 2 `create_project`). Enable/disable " +
      "auth methods on an EXISTING project, set redirect URLs, and/or " +
      "wire up Google OAuth. REQUIRED before STEP 4 = " +
      "`add_auth_to_project` if the user wants any non-default method " +
      "(magic link, email OTP, Google) — scaffolding code without " +
      "first enabling the method server-side will produce a UI that " +
      "errors at runtime. PRECONDITION: you must already have a " +
      "projectId; if you don't, run `list_projects` or `create_project` " +
      "first. Field-level updates: anything you don't pass is LEFT " +
      "UNCHANGED — never include a method just to set it to its " +
      "current value. To enable Google you must already have a Client " +
      "ID + Secret from Google Cloud Console; if you don't, call this " +
      "WITHOUT `google` first — the response will print the exact " +
      "redirect URI to authorize and a link to create the credentials, " +
      "after which you call configure_auth a SECOND time with the " +
      "Google fields filled in. `redirectUrls` REPLACES the entire " +
      "list, so read existing values from `get_project` first if you " +
      "only want to add one.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        methods: {
          type: "object",
          properties: {
            emailPassword: { type: "boolean" },
            magicLink: { type: "boolean" },
            emailOtp: { type: "boolean" },
            passwordReset: { type: "boolean" },
            emailVerification: { type: "boolean" },
          },
          additionalProperties: false,
        },
        google: {
          type: "object",
          description:
            "Google OAuth client credentials. You must create these " +
            "in the Google Cloud Console first (see response for steps).",
          properties: {
            clientId: { type: "string" },
            clientSecret: { type: "string" },
            enabled: { type: "boolean" },
          },
          required: ["clientId", "clientSecret"],
          additionalProperties: false,
        },
        redirectUrls: {
          type: "array",
          items: { type: "string" },
          description: "Overwrites the project's allowed redirect URL list.",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  handler: async (args: {
    projectId: string;
    methods?: {
      emailPassword?: boolean;
      magicLink?: boolean;
      emailOtp?: boolean;
      passwordReset?: boolean;
      emailVerification?: boolean;
    };
    google?: { clientId: string; clientSecret: string; enabled?: boolean };
    redirectUrls?: string[];
  }) => {
    const token = await requireToken();
    const client = new VibeloginApiClient(token);
    const changes: string[] = [];

    if (args.methods || args.redirectUrls) {
      await client.patchProjectConfig(args.projectId, {
        authMethods: args.methods,
        redirectUrls: args.redirectUrls,
      });
      if (args.methods) {
        changes.push(
          "auth methods updated: " +
            Object.entries(args.methods)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")
        );
      }
      if (args.redirectUrls) {
        changes.push(`redirect URLs set (${args.redirectUrls.length})`);
      }
    }

    if (args.google) {
      await client.putProjectProvider(args.projectId, {
        provider: "google",
        type: "oidc",
        issuerUrl: "https://accounts.google.com",
        clientId: args.google.clientId,
        clientSecret: args.google.clientSecret,
        scopes: "openid email profile",
        enabled: args.google.enabled ?? true,
      });
      changes.push("google OAuth configured");
    }

    const lines: string[] = [];
    if (changes.length) lines.push(`Updated: ${changes.join("; ")}`);
    else lines.push("No changes requested.");

    if (!args.google) {
      lines.push(
        "",
        "To enable Google OAuth you still need to create credentials manually:",
        "  1. https://console.cloud.google.com/apis/credentials",
        "  2. Create OAuth client ID → Web application",
        `  3. Authorized redirect URI: ${config.apiUrl}/oauth/<your-oauth-slug>/google/callback`,
        "  4. Re-run configure_auth with { google: { clientId, clientSecret } }"
      );
    }

    return textResult(lines.join("\n"));
  },
};

// ──────────────────────────────────────────────
// Tool: list_projects
// ──────────────────────────────────────────────

export const listProjectsTool = {
  def: {
    name: "list_projects",
    description:
      "STEP 1 of the standard onboarding sequence, AND the default " +
      "first action whenever you don't yet know which project the " +
      "user means. Lists every VibeLogin project in the user's org. " +
      "Cheap, read-only, idempotent — call it freely. Required before " +
      "`create_project` (to avoid duplicates) and before any " +
      "`configure_auth` / `add_auth_to_project` call where you don't " +
      "already have a verified projectId in hand. Returns id, name, " +
      "slug, oauthSlug, environment, publishableKey, createdAt for " +
      "each project.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  handler: async () => {
    const token = await requireToken();
    const client = new VibeloginApiClient(token);
    const { projects } = await client.listProjects();
    if (projects.length === 0) {
      return textResult("No projects yet. Use `create_project` to make one.");
    }
    const lines = [`Found ${projects.length} project(s):`, ""];
    for (const p of projects) {
      lines.push(
        `• ${p.name} (${p.slug}) — ${p.environment}`,
        `    id:             ${p.id}`,
        `    oauthSlug:      ${p.oauthSlug}`,
        `    publishableKey: ${p.publishableKey}`,
        ""
      );
    }
    return textResult(lines.join("\n"));
  },
};

// ──────────────────────────────────────────────
// Tool: get_project
// ──────────────────────────────────────────────

export const getProjectTool = {
  def: {
    name: "get_project",
    description:
      "Look up a single existing VibeLogin project by id, slug, or " +
      "oauthSlug. Use as a SHORTCUT when the user explicitly names a " +
      "project (e.g. 'my-app') and you don't need the full list. " +
      "Otherwise prefer STEP 1 = `list_projects`. Common position in " +
      "the sequence: between `list_projects` and `add_auth_to_project` " +
      "to fetch publishableKey + oauthSlug for an existing project. " +
      "Read-only, idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        idOrSlug: {
          type: "string",
          description: "Project id, slug, or oauthSlug.",
        },
      },
      required: ["idOrSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args: { idOrSlug: string }) => {
    const token = await requireToken();
    const client = new VibeloginApiClient(token);
    const p = await client.getProject(args.idOrSlug);
    return textResult(
      [
        `${p.name} (${p.slug})`,
        ``,
        `  id:             ${p.id}`,
        `  oauthSlug:      ${p.oauthSlug}`,
        `  environment:    ${p.environment}`,
        `  publishableKey: ${p.publishableKey}`,
        `  createdAt:      ${p.createdAt}`,
      ].join("\n")
    );
  },
};

// ──────────────────────────────────────────────
// Framework detection
// ──────────────────────────────────────────────

export type DetectedFramework =
  | "next"
  | "vite-react"
  | "remix"
  | "astro"
  | "express"
  | "unknown";

export interface FrameworkDetection {
  framework: DetectedFramework;
  reason: string;
}

/**
 * Best-effort framework detection from a project's package.json.
 * Pure / no fs side-effects beyond a single read so it's easy to test.
 */
export async function detectFramework(
  projectDir: string
): Promise<FrameworkDetection> {
  const pkgPath = join(projectDir, "package.json");
  let pkg: any;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch {
    return { framework: "unknown", reason: `no package.json at ${pkgPath}` };
  }
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  } as Record<string, string>;

  if (deps["next"]) return { framework: "next", reason: "found `next` in dependencies" };
  if (deps["@remix-run/react"] || deps["@remix-run/node"])
    return { framework: "remix", reason: "found `@remix-run/*` in dependencies" };
  if (deps["astro"]) return { framework: "astro", reason: "found `astro` in dependencies" };
  if (deps["vite"] && (deps["react"] || deps["react-dom"]))
    return { framework: "vite-react", reason: "found `vite` + `react` in dependencies" };
  if (deps["express"]) return { framework: "express", reason: "found `express` in dependencies" };
  return { framework: "unknown", reason: "no recognised framework dependency" };
}

// ──────────────────────────────────────────────
// Tool: add_auth_to_project
// ──────────────────────────────────────────────

/**
 * Minimal Next.js App Router scaffold. Writes are non-destructive —
 * if a target file already exists, it is skipped and reported so the
 * agent can offer a diff to the user instead of clobbering edits.
 */
export const addAuthToProjectTool = {
  def: {
    name: "add_auth_to_project",
    description:
      "STEP 4 — the FINAL step of the standard onboarding sequence. " +
      "Scaffold a working VibeLogin sign-in flow into the user's " +
      "codebase. STRICT PRECONDITIONS: (a) the project must already " +
      "exist in VibeLogin — call STEP 2 `create_project` first OR " +
      "locate an existing one via STEP 1 `list_projects` / " +
      "`get_project`; (b) STEP 3 `configure_auth` must have been run " +
      "with the methods the user wants enabled, otherwise the " +
      "scaffolded UI will hit METHOD_DISABLED at runtime; (c) you " +
      "must have the project's `oauthSlug` (NOT the human slug) and " +
      "`publishableKey` from one of the previous steps. Auto-detects " +
      "the framework from package.json. SUPPORTED: Next.js (App " +
      "Router), Vite + React. REFUSED with structured " +
      "code=UNSUPPORTED_FRAMEWORK: Remix, Astro, Express, unknown — " +
      "for those do NOT retry; instead read `details.detected` and " +
      "tell the user the manual steps. Non-destructive: skips files " +
      "that already exist (re-running is safe). Writes " +
      "framework-appropriate files (middleware/callback/login/.env " +
      "example) and returns a `Next steps` checklist the user should " +
      "run (pnpm add … etc). After this tool succeeds the sequence is " +
      "COMPLETE — do not call any further VibeLogin tools unless the " +
      "user asks for additional changes.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Absolute path to the target Next.js project root.",
        },
        slug: {
          type: "string",
          description: "The project's oauthSlug (from create_project).",
        },
        publishableKey: { type: "string" },
        appUrl: {
          type: "string",
          description: "Customer app's origin (e.g. https://myapp.com).",
        },
      },
      required: ["projectDir", "slug", "publishableKey", "appUrl"],
      additionalProperties: false,
    },
  },
  handler: async (args: {
    projectDir: string;
    slug: string;
    publishableKey: string;
    appUrl: string;
  }) => {
    const root = resolve(args.projectDir);

    // Detect the target framework and dispatch to the matching scaffolder.
    // Refuse early on anything we don't support yet so the agent can fall
    // back to manual instructions instead of getting wrong files.
    const detection = await detectFramework(root);
    let files: { path: string; body: string }[];
    let nextSteps: string[];

    if (detection.framework === "next") {
      files = [
        { path: join(root, "middleware.ts"), body: middlewareTemplate() },
        { path: join(root, "app/auth/callback/route.ts"), body: callbackTemplate(args.slug) },
        { path: join(root, "app/login/page.tsx"), body: loginPageTemplate(args.slug, args.appUrl) },
        { path: join(root, ".env.local.example"), body: envExampleTemplate(args.publishableKey) },
      ];
      nextSteps = [
        "1. pnpm add @vibelogin/nextjs",
        "2. Copy .env.local.example to .env.local and fill in VIBELOGIN_SECRET_KEY",
        "3. pnpm dev → open /login",
      ];
    } else if (detection.framework === "vite-react") {
      files = [
        { path: join(root, "src/auth/VibeLoginProvider.tsx"), body: viteProviderTemplate(args.slug, args.publishableKey, args.appUrl) },
        { path: join(root, "src/auth/Login.tsx"), body: viteLoginPageTemplate(args.slug, args.appUrl) },
        { path: join(root, "src/auth/Callback.tsx"), body: viteCallbackTemplate(args.slug, args.appUrl) },
        { path: join(root, ".env.example"), body: viteEnvExampleTemplate(args.publishableKey) },
      ];
      nextSteps = [
        "1. pnpm add @vibelogin/react react-router-dom",
        "2. Wrap your <App/> in <VibeLoginProvider/> from src/auth/VibeLoginProvider.tsx",
        "3. Add routes: /login → <Login/>, /auth/callback → <Callback/>",
        "4. Copy .env.example to .env.local",
        "5. pnpm dev → open /login",
      ];
    } else {
      const guidance: Record<DetectedFramework, string> = {
        next: "",
        "vite-react": "",
        remix: "Add a loader at `/auth/callback` that exchanges the code; Remix scaffolding is not yet automated.",
        astro: "Use a server endpoint at `/auth/callback`; Astro scaffolding is not yet automated.",
        express: "Mount the hosted callback handler on an Express route; Express scaffolding is not yet automated.",
        unknown: "Could not identify the framework. Add `next` or `vite`+`react` to dependencies, or scaffold manually.",
      };
      throw new MCPToolError(
        "UNSUPPORTED_FRAMEWORK",
        `Automated scaffolding currently supports Next.js App Router and Vite + React. ${guidance[detection.framework]}`,
        { detected: detection.framework, reason: detection.reason }
      );
    }

    const written: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      try {
        await mkdir(dirname(file.path), { recursive: true });
        // Use wx — fail if exists — and downgrade to skipped.
        await writeFile(file.path, file.body, { encoding: "utf8", flag: "wx" });
        written.push(file.path);
      } catch (err: any) {
        if (err?.code === "EEXIST") {
          skipped.push(file.path);
        } else {
          throw err;
        }
      }
    }

    return textResult(
      [
        `Scaffold complete (${detection.framework}).`,
        ``,
        `Wrote (${written.length}):`,
        ...written.map((f) => `  + ${f}`),
        ...(skipped.length
          ? [``, `Skipped existing (${skipped.length}):`, ...skipped.map((f) => `  = ${f}`)]
          : []),
        ``,
        `Next steps:`,
        ...nextSteps.map((s) => `  ${s}`),
      ].join("\n")
    );
  },
};

// ── Scaffold templates ─────────────────────────

function middlewareTemplate(): string {
  return `// Generated by @vibelogin/mcp
import { hostedAuthMiddleware } from "@vibelogin/nextjs";

export default hostedAuthMiddleware({
  projectId: process.env.VIBELOGIN_PROJECT_ID!,
  publicRoutes: ["/"],
  loggedOutOnlyRoutes: ["/login", "/signup"],
  redirectAfterLogin: "/dashboard",
  signInUrl: "/login",
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
`;
}

function callbackTemplate(slug: string): string {
  return `// Generated by @vibelogin/mcp
import { hostedCallback } from "@vibelogin/nextjs/callback";

export const GET = hostedCallback({
  slug: ${JSON.stringify(slug)},
});
`;
}

function loginPageTemplate(slug: string, appUrl: string): string {
  return `// Generated by @vibelogin/mcp
import { VibeLogin } from "@vibelogin/nextjs/components";

export default function LoginPage() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <VibeLogin
        slug={${JSON.stringify(slug)}}
        callbackPath="/auth/callback"
        redirectAfterLogin=${JSON.stringify(appUrl)}
      />
    </main>
  );
}
`;
}

function envExampleTemplate(publishableKey: string): string {
  return `# Generated by @vibelogin/mcp
VIBELOGIN_PUBLISHABLE_KEY=${publishableKey}
VIBELOGIN_SECRET_KEY=sk_live_xxx_paste_your_secret_key_here
VIBELOGIN_API_URL=https://api.vibelogin.com
`;
}

// ── Vite + React templates ─────────────────────

function viteProviderTemplate(slug: string, publishableKey: string, appUrl: string): string {
  return `// Generated by @vibelogin/mcp
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface VibeLoginContextValue {
  user: { id: string; email: string } | null;
  loading: boolean;
  signOut: () => void;
}

const Ctx = createContext<VibeLoginContextValue>({
  user: null,
  loading: true,
  signOut: () => {},
});

export const VIBELOGIN_SLUG = ${JSON.stringify(slug)};
export const VIBELOGIN_PUBLISHABLE_KEY = ${JSON.stringify(publishableKey)};
export const VIBELOGIN_APP_URL = ${JSON.stringify(appUrl)};

export function VibeLoginProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<VibeLoginContextValue["user"]>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const apiUrl = import.meta.env.VITE_VIBELOGIN_API_URL ?? "https://api.vibelogin.com";
    fetch(\`\${apiUrl}/v1/me\`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setUser(data?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const signOut = () => {
    const apiUrl = import.meta.env.VITE_VIBELOGIN_API_URL ?? "https://api.vibelogin.com";
    fetch(\`\${apiUrl}/v1/auth/signout\`, { method: "POST", credentials: "include" })
      .finally(() => setUser(null));
  };

  return <Ctx.Provider value={{ user, loading, signOut }}>{children}</Ctx.Provider>;
}

export const useVibeLogin = () => useContext(Ctx);
`;
}

function viteLoginPageTemplate(slug: string, appUrl: string): string {
  return `// Generated by @vibelogin/mcp
import { useEffect } from "react";
import { VIBELOGIN_SLUG, VIBELOGIN_APP_URL } from "./VibeLoginProvider";

export default function Login() {
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_VIBELOGIN_API_URL ?? "https://api.vibelogin.com";
    const callback = encodeURIComponent(\`\${VIBELOGIN_APP_URL}/auth/callback\`);
    window.location.href = \`\${apiUrl}/auth/\${VIBELOGIN_SLUG}/login?redirect_url=\${callback}\`;
  }, []);
  return <p>Redirecting to sign-in…</p>;
}
`;
}

function viteCallbackTemplate(slug: string, appUrl: string): string {
  return `// Generated by @vibelogin/mcp
import { useEffect } from "react";
import { VIBELOGIN_APP_URL } from "./VibeLoginProvider";

export default function Callback() {
  useEffect(() => {
    // Hosted auth has already set the session cookie. Bounce to the app.
    window.location.replace(VIBELOGIN_APP_URL);
  }, []);
  return <p>Signing you in…</p>;
}
`;
}

function viteEnvExampleTemplate(publishableKey: string): string {
  return `# Generated by @vibelogin/mcp
# Vite exposes vars prefixed with VITE_ to the client bundle.
VITE_VIBELOGIN_PUBLISHABLE_KEY=${publishableKey}
VITE_VIBELOGIN_API_URL=https://api.vibelogin.com
`;
}

// ──────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────

export const tools = [
  authTool,
  createProjectTool,
  listProjectsTool,
  getProjectTool,
  configureAuthTool,
  addAuthToProjectTool,
];
