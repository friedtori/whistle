import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Store } from "./db.ts";
import { HttpError, normalizePlatform } from "./ids.ts";
import { resolveTrack, type ResolveDeps } from "./pipeline.ts";
import type { Platform, ProviderMap, ResolveQuery } from "./types.ts";
import { PLATFORMS } from "./types.ts";

const batchItemSchema = z
  .object({
    isrc: z.string().optional(),
    platform: z.string().optional(),
    id: z.string().optional(),
    url: z.string().optional(),
    artist: z.string().optional(),
    title: z.string().optional(),
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

const batchSchema = z.object({
  inputs: z.array(batchItemSchema).min(1).max(100),
});

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

export interface AppDeps extends ResolveDeps {
  db: Store;
  providers: ProviderMap;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "whistle", version: "0.1.0" });
  });

  app.get("/v1/resolve", async (req, res, next) => {
    try {
      const query = resolveQueryFromRequest(req);
      const result = await resolveTrack(query, deps);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post("/v1/resolve/batch", async (req, res, next) => {
    try {
      const parsed = batchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "bad_request", parsed.error.issues[0]?.message ?? "Invalid batch");
      }
      const results = [];
      for (const input of parsed.data.inputs) {
        try {
          const resolved = await resolveTrack(input, deps);
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
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  app.get("/v1/recordings/:id", (req, res, next) => {
    try {
      const recording = deps.db.findRecordingById(req.params.id);
      if (!recording) throw new HttpError(404, "not_found", "Recording not found");
      const identifiers = deps.db.listIdentifiers(recording.id).map(({ kind, value }) => ({
        kind,
        value,
      }));
      const links = deps.db.listLinks(recording.id);
      res.json({
        recording: {
          id: recording.id,
          title: recording.title,
          artists: recording.artists,
          duration_ms: recording.duration_ms,
          mbid: recording.mbid,
        },
        identifiers,
        links,
        cached: true,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/v1/corrections", (req, res, next) => {
    try {
      const parsed = correctionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "bad_request", parsed.error.issues[0]?.message ?? "Invalid correction");
      }
      const body = parsed.data;
      if (body.reason === "wrong") {
        const link = deps.db.getLink(body.link_id!);
        if (!link) throw new HttpError(404, "not_found", "Link not found");
      }
      if (body.reason === "missing") {
        const recording = deps.db.findRecordingById(body.recording_id!);
        if (!recording) throw new HttpError(404, "not_found", "Recording not found");
        const platform = normalizePlatform(body.platform!);
        if (!platform || platform === "isrc" || !PLATFORMS.includes(platform as Platform)) {
          throw new HttpError(400, "bad_request", `Unsupported platform: ${body.platform}`);
        }
      }
      const correction = deps.db.createCorrection({
        link_id: body.link_id,
        recording_id: body.recording_id,
        platform: body.platform && body.platform !== "isrc" ? (normalizePlatform(body.platform) as Platform) : null,
        reason: body.reason,
      });
      res.status(201).json({ correction });
    } catch (err) {
      next(err);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("[whistle]", err);
    res.status(500).json({ error: { code: "internal_error", message } });
  });

  return app;
}

function resolveQueryFromRequest(req: Request): ResolveQuery {
  const q = req.query;
  return {
    isrc: typeof q.isrc === "string" ? q.isrc : undefined,
    platform: typeof q.platform === "string" ? q.platform : undefined,
    id: typeof q.id === "string" ? q.id : undefined,
    url: typeof q.url === "string" ? q.url : undefined,
    artist: typeof q.artist === "string" ? q.artist : undefined,
    title: typeof q.title === "string" ? q.title : undefined,
    duration_ms: typeof q.duration_ms === "string" ? q.duration_ms : undefined,
    duration: typeof q.duration === "string" ? q.duration : undefined,
  };
}
