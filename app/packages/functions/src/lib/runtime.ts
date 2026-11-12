import type { AudienceType, RayfinContext } from '@microsoft/fabric-user-data-functions';
import { AzureOpenAiClient, FabricClient, UnavailableLlm, type LlmClient } from '@rayfin-app/engine';
import type { UniversalAppSchema } from '@rayfin-app/shared';

export type AppSchema = UniversalAppSchema;

/** Must stay identical to the annotation on every handler in function_app.ts. */
export type Ctx = RayfinContext<AppSchema, AudienceType.Fabric | AudienceType.AzureAI | AudienceType.Storage>;

/** Optional configuration. Values come from `rayfin secret set`, or process.env when running locally. */
export function config(ctx: Ctx, name: 'AOAI_ENDPOINT' | 'AOAI_DEPLOYMENT' | 'AOAI_API_VERSION' | 'PORTFOLIO_PATH' | 'SIGNING_KEY' | 'APP_ADMINS'): string | undefined {
  try {
    const bag = ctx.Secrets as unknown as Record<string, string | undefined>;
    const v = bag[name];
    if (v && v.trim()) return v.trim();
  } catch {
    // A secret that was never set throws; treat it as not configured.
  }
  const env = process.env[name];
  return env && env.trim() ? env.trim() : undefined;
}

export function fabricClient(ctx: Ctx): FabricClient {
  // The Fabric audience token is accepted by both api.fabric.microsoft.com and api.powerbi.com.
  return new FabricClient({ getToken: async () => ctx.Tokens.Fabric, lroTimeoutMs: 150_000 });
}

export function llmClient(ctx: Ctx): LlmClient {
  const endpoint = config(ctx, 'AOAI_ENDPOINT');
  if (!endpoint) return new UnavailableLlm();
  if (!/^https:\/\/[a-z0-9-]+\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)\/?$/i.test(endpoint)) {
    return new UnavailableLlm();
  }
  const apiVersion = config(ctx, 'AOAI_API_VERSION');
  return new AzureOpenAiClient({
    endpoint,
    deployment: config(ctx, 'AOAI_DEPLOYMENT') ?? 'gpt-4.1',
    // An unset or malformed value keeps the engine default rather than sending an odd query string.
    ...(apiVersion && /^\d{4}-\d{2}-\d{2}(-preview)?$/.test(apiVersion) ? { apiVersion } : {}),
    getToken: async () => ctx.Tokens.AzureAI,
  });
}

/** Best-effort caller label for the audit trail. The platform already authenticated the token. */
export function actorOf(ctx: Ctx): string {
  try {
    const payload = ctx.accessToken.split('.')[1];
    if (payload) {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
      const pick = ['preferred_username', 'upn', 'email', 'unique_name', 'name', 'sub', 'oid'].map((k) => claims[k]).find((v) => typeof v === 'string' && v);
      if (typeof pick === 'string') return (/\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(pick)?.[1] ?? pick).slice(0, 200);
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

/** Short, readable error text: drops service markup and diagnostics ids and puts the real reason first. */
export function errorMessage(e: unknown): string {
  let m = (e instanceof Error ? e.message : String(e)).replace(/<\/?oii>/g, '').replace(/\{\s*"RootActivityId"\s*:\s*"[^"]*"\s*\}/g, '');
  const reason = /Error returned:\s*'([\s\S]*?)'\.?\s*$/.exec(m)?.[1]?.replace(/\s+/g, ' ').trim();
  if (reason && /failed to import|FailedToImport/i.test(m)) m = `The service rejected the model definition: ${reason}`;
  m = m.replace(/\s+/g, ' ').trim();
  return m.length > 500 ? `${m.slice(0, 500)}...` : m;
}
