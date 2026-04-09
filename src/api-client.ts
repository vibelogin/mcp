/**
 * Typed wrapper around the subset of the Hono API (/v1/platform/*)
 * that the MCP server consumes.
 *
 * All methods require a valid platform token — callers should obtain
 * one via the loopback flow (see loopback.ts) or a cached file
 * (see credentials.ts) before instantiating the client.
 */

import { config } from "./config.js";

export interface CreatedProject {
  project: {
    id: string;
    name: string;
    slug: string;
    environment: string;
  };
  keys: {
    publishableKey: string;
    secretKey: string;
  };
}

export interface ListedProject {
  id: string;
  name: string;
  slug: string;
  oauthSlug: string;
  environment: string;
  publishableKey: string;
  createdAt: string;
}

export interface AuthMethodsPatch {
  emailPassword?: boolean;
  magicLink?: boolean;
  emailOtp?: boolean;
  passwordReset?: boolean;
  emailVerification?: boolean;
}

export class VibeloginApiClient {
  constructor(private readonly token: string) {}

  private async request<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const res = await fetch(`${config.apiUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      throw new Error(
        `api_error: ${body?.code ?? res.status} — ${body?.error ?? ""}`
      );
    }
    return body as T;
  }

  listProjects(): Promise<{ projects: ListedProject[] }> {
    return this.request("/v1/platform/projects");
  }

  async getProject(idOrSlug: string): Promise<ListedProject> {
    const { projects } = await this.listProjects();
    const found = projects.find(
      (p) => p.id === idOrSlug || p.slug === idOrSlug || p.oauthSlug === idOrSlug
    );
    if (!found) {
      throw new Error(`project_not_found: ${idOrSlug}`);
    }
    return found;
  }

  createProject(input: {
    name: string;
    slug?: string;
    environment?: "production" | "development" | "staging";
  }): Promise<CreatedProject> {
    return this.request("/v1/platform/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  patchProjectConfig(
    projectId: string,
    patch: {
      authMethods?: AuthMethodsPatch;
      redirectUrls?: string[];
      allowedOrigins?: string[];
      branding?: { logoUrl?: string; primaryColor?: string; accentColor?: string };
    }
  ): Promise<{ config: unknown }> {
    return this.request(`/v1/platform/projects/${projectId}/config`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  putProjectProvider(
    projectId: string,
    input: {
      provider: string;
      type?: "oidc" | "oauth";
      issuerUrl?: string;
      clientId: string;
      clientSecret: string;
      scopes?: string;
      enabled?: boolean;
    }
  ): Promise<{ provider: { name: string; type: string; enabled: boolean } }> {
    return this.request(`/v1/platform/projects/${projectId}/providers`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
}
