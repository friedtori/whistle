import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AuthStore } from "./auth-store.ts";
import type { Config } from "./config.ts";
import type { D1Store } from "./db.ts";
import { HttpError, normalizePlatform } from "./ids.ts";
import type { SubrequestBudget } from "./http.ts";
import { present, resolveTrack } from "./pipeline.ts";
import type { Platform, ProviderMap, ResolveQuery } from "./types.ts";
import { PLATFORMS } from "./types.ts";
import {
  anonymousClientKey,
  checkProof,
  importLicencePublicKey,
  issueSessionToken,
  parseEnvelope,
  readCookie,
  readSessionToken,
  SESSION_COOKIE,
  sessionCookieHeader,
} from "./verification.ts";

/**
 * D1 round trips one resolve may need on top of its provider calls (input
 * lookup, reuse lookups, snapshot loads, the commit batch, the reload).
 */
export const D1_CALLS_PER_RESOLVE = 8;

/** Everything one request needs. Built per request so the subrequest budget is per invocation. */
export interface RequestServices {
  config: Pick<Config, "resolveSubrequestCap" | "batchMaxInputs" | "gitCommit">;
  budget: SubrequestBudget;
  db: D1Store;
  /** Providers whose outbound calls spend from `budget`. */
  providers(budget: SubrequestBudget): ProviderMap;
  /** Gum verification handshake and quotas. Omitted only in tests that exercise resolving alone. */
  verification?: VerificationServices;
  /** Clock (ms). Injectable for tests. */
  now?: () => number;
}

export interface VerificationServices {
  store: AuthStore;
  config: Pick<
    Config,
    "anonResolvesPerHour" | "verifiedResolvesPerDay" | "gumLicensePublicKey" | "sessionSecret"
  >;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** `env` is the Worker bindings object. */
export type ServicesFactory = (env: Record<string, unknown>) => RequestServices;

type AppEnv = { Bindings: Record<string, unknown>; Variables: { services: RequestServices } };

const batchItemSchema = z
  .object({
    isrc: z.string().optional(),
    platform: z.string().optional(),
    id: z.string().optional(),
    url: z.string().optional(),
    artist: z.string().optional(),
    title: z.string().optional(),
    album: z.string().optional(),
    duration_ms: z.number().optional(),
    duration: z.number().optional(),
  })
  .refine(
    (value) =>
      Boolean(value.isrc || value.url || (value.platform && value.id) || (value.artist && value.title)),
    {
      message: "Each input needs isrc, url, platform+id, or artist+title",
    },
  );

function batchSchema(maxInputs: number) {
  return z.object({
    inputs: z.array(batchItemSchema).min(1).max(maxInputs),
  });
}

const correctionSchema = z
  .object({
    link_id: z.string().optional(),
    recording_id: z.string().optional(),
    platform: z.string().optional(),
    reason: z.enum(["wrong", "missing"]),
  })
  .refine((value) => {
    if (value.reason === "wrong") return Boolean(value.link_id);
    return Boolean(value.recording_id && value.platform);
  }, {
    message: "wrong requires link_id; missing requires recording_id and platform",
  });

export function createApp(services: ServicesFactory): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("services", services(c.env));
    await next();
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  });

  app.options("*", (c) => c.body(null, 204));

  app.get("/health", (c) => c.json({ ok: true, service: "whistle", version: "0.1.0" }));

  app.get("/v1/resolve", async (c) => {
    const svc = c.get("services");
    const refused = await meter(c, 1);
    if (refused) return refused;
    const query = resolveQueryFromRequest(c);
    const result = await resolveTrack(query, resolveDeps(svc, svc.budget));
    return c.json(result);
  });

  app.post(
    "/v1/resolve/batch",
    bodyLimit({ maxSize: 100 * 1024, onError: (c) => tooLarge(c) }),
    async (c) => {
      const svc = c.get("services");
      const parsed = batchSchema(svc.config.batchMaxInputs).safeParse(await jsonBody(c));
      if (!parsed.success) {
        throw new HttpError(400, "bad_request", parsed.error.issues[0]?.message ?? "Invalid batch");
      }
      const refused = await meter(c, parsed.data.inputs.length);
      if (refused) return refused;
      const perResolve = svc.config.resolveSubrequestCap + D1_CALLS_PER_RESOLVE;
      const results = [];
      for (const input of parsed.data.inputs) {
        if (svc.budget.remaining < perResolve) {
          results.push({
            input,
            ok: false,
            error: {
              code: "subrequest_budget_exhausted",
              message: "Not attempted: this request's subrequest budget is spent. Retry the input in a new request.",
            },
          });
          continue;
        }
        try {
          const resolved = await resolveTrack(input, resolveDeps(svc, svc.budget));
          results.push({ input, ok: true, ...resolved });
        } catch (err) {
          const httpErr = err instanceof HttpError ? err : null;
          results.push({
            input,
            ok: false,
            error: {
              code: httpErr?.code ?? "resolve_failed",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
      return c.json({ results });
    },
  );

  app.post(
    "/auth/session",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => tooLarge(c) }),
    async (c) => {
      const svc = c.get("services");
      const v = svc.verification;
      if (!v?.config.sessionSecret || !v.config.gumLicensePublicKey) {
        console.error("[whistle] /auth/session: SESSION_SECRET or GUM_LICENSE_PUBLIC_KEY is not configured");
        return c.json({ error: { code: "verification_unavailable" } }, 503);
      }
      const envelope = parseEnvelope(await jsonBody(c));
      if (!envelope) return c.json({ error: { code: "bad_request" } }, 400);
      const now = clock(svc);
      const check = await checkProof(envelope, {
        publicKey: await licenceKey(v.config.gumLicensePublicKey),
        now,
      });
      if (!check.ok) {
        return c.json({ error: { code: "verification_failed", reason: check.reason } }, 403);
      }
      if (!(await v.store.consumeNonce(check.nonce, now))) {
        return c.json({ error: { code: "verification_failed", reason: "nonce_not_valid" } }, 403);
      }
      const { token } = await issueSessionToken(v.config.sessionSecret, now);
      return c.body(null, 204, { "Set-Cookie": sessionCookieHeader(token) });
    },
  );

  app.get("/v1/recordings/:id", async (c) => {
    const svc = c.get("services");
    // Read through a unit so the recording, identifiers and links load in one D1 round trip.
    const store = svc.db.unit();
    const recording = await store.findRecordingById(c.req.param("id"));
    if (!recording) throw new HttpError(404, "not_found", "Recording not found");
    const providers = svc.providers(svc.budget.child(0));
    return c.json(await present(store, recording, true, { providers, commit: svc.config.gitCommit }));
  });

  app.post(
    "/v1/corrections",
    bodyLimit({ maxSize: 100 * 1024, onError: (c) => tooLarge(c) }),
    async (c) => {
      const svc = c.get("services");
      const parsed = correctionSchema.safeParse(await jsonBody(c));
      if (!parsed.success) {
        throw new HttpError(400, "bad_request", parsed.error.issues[0]?.message ?? "Invalid correction");
      }
      const body = parsed.data;
      if (body.reason === "wrong") {
        const link = await svc.db.getLink(body.link_id!);
        if (!link) throw new HttpError(404, "not_found", "Link not found");
      }
      if (body.reason === "missing") {
        const recording = await svc.db.findRecordingById(body.recording_id!);
        if (!recording) throw new HttpError(404, "not_found", "Recording not found");
        const platform = normalizePlatform(body.platform!);
        if (!platform || platform === "isrc" || !PLATFORMS.includes(platform as Platform)) {
          throw new HttpError(400, "bad_request", `Unsupported platform: ${body.platform}`);
        }
      }
      const correction = await svc.db.createCorrection({
        link_id: body.link_id,
        recording_id: body.recording_id,
        platform:
          body.platform && body.platform !== "isrc" ? (normalizePlatform(body.platform) as Platform) : null,
        reason: body.reason,
      });
      return c.json({ correction }, 201);
    },
  );

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404),
  );

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("[whistle]", err);
    return c.json({ error: { code: "internal_error", message } }, 500);
  });

  return app;
}

function clock(svc: RequestServices): number {
  return svc.now ? svc.now() : Date.now();
}

const licenceKeys = new Map<string, Promise<CryptoKey>>();

function licenceKey(base64: string): Promise<CryptoKey> {
  let key = licenceKeys.get(base64);
  if (!key) {
    key = importLicencePublicKey(base64);
    key.catch(() => licenceKeys.delete(base64));
    licenceKeys.set(base64, key);
  }
  return key;
}

/**
 * Quota gate for resolve endpoints. A request carrying a valid session cookie
 * is counted against that session's daily quota and is never challenged; past
 * that quota it gets `rate_limited`, not `verification_required`. Anything
 * else is anonymous and counted per client network per hour; past that quota
 * the response is the 429 challenge with a fresh single-use nonce.
 */
async function meter(c: Context<AppEnv>, units: number): Promise<Response | null> {
  const svc = c.get("services");
  const v = svc.verification;
  if (!v) return null;
  const now = clock(svc);

  const token = readCookie(c.req.header("Cookie"), SESSION_COOKIE);
  const session =
    token && v.config.sessionSecret ? await readSessionToken(v.config.sessionSecret, token, now) : null;
  if (session) {
    const day = Math.floor(now / DAY_MS) * DAY_MS;
    const used = await v.store.increment(`session:${session.id}`, day, units);
    if (used <= v.config.verifiedResolvesPerDay) return null;
    const retryAfter = Math.ceil((day + DAY_MS - now) / 1000);
    return c.json(
      { error: { code: "rate_limited", message: "Daily quota for this session is used up" } },
      429,
      { "Retry-After": String(retryAfter) },
    );
  }

  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const client = await anonymousClientKey(c.req.header("CF-Connecting-IP"));
  const used = await v.store.increment(client, hour, units);
  if (used <= v.config.anonResolvesPerHour) return null;
  const { nonce, expiresAt } = await v.store.issueNonce(now);
  return c.json(
    {
      error: { code: "verification_required" },
      verification: { nonce, expires_at: expiresAt, endpoint: "/auth/session" },
    },
    429,
  );
}

function resolveDeps(svc: RequestServices, budget: SubrequestBudget) {
  return {
    db: svc.db,
    providers: svc.providers(budget.child(svc.config.resolveSubrequestCap)),
    commit: svc.config.gitCommit,
  };
}

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function tooLarge(c: Context<AppEnv>) {
  return c.json({ error: { code: "payload_too_large", message: "Body exceeds 100kb" } }, 413);
}

function resolveQueryFromRequest(c: Context<AppEnv>): ResolveQuery {
  const q = (name: string) => c.req.query(name);
  return {
    isrc: q("isrc"),
    platform: q("platform"),
    id: q("id"),
    url: q("url"),
    artist: q("artist"),
    title: q("title"),
    album: q("album"),
    duration_ms: q("duration_ms"),
    duration: q("duration"),
  };
}
