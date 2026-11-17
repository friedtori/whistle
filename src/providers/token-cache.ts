import { asString, basicAuth, type HttpJson } from "../http.ts";

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

// Isolate-level cache: providers are built per request on Workers, but an
// OAuth client-credentials token is valid for an hour, so reuse it across
// requests served by the same isolate instead of spending a subrequest each time.
const tokens = new Map<string, TokenState>();
const inflight = new Map<string, Promise<string | null>>();

export async function clientCredentialsToken(
  http: HttpJson,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  const key = `${tokenUrl}|${clientId}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = (async () => {
    const res = await http<{ access_token?: string; expires_in?: number }>(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const access = asString(res.json?.access_token);
    if (!access) return null;
    tokens.set(key, {
      accessToken: access,
      expiresAt: Date.now() + (res.json?.expires_in ?? 3600) * 1000,
    });
    return access;
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/** Test hook. */
export function clearTokenCache(): void {
  tokens.clear();
  inflight.clear();
}
