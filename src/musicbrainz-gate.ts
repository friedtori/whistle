import { DurableObject } from "cloudflare:workers";
import { DEFAULT_MUSICBRAINZ_MIN_INTERVAL_MS } from "./config.ts";
import type { Env } from "./env.ts";
import { createHttpJson, type JsonResponse, type SubrequestBudget } from "./http.ts";
import { musicBrainzRequest, type MbGate } from "./providers/musicbrainz.ts";

/** A caller waiting longer than this for its slot is refused, so a resolve skips MusicBrainz instead of stalling. */
export const MUSICBRAINZ_MAX_QUEUE_MS = 4000;
const DEFAULT_UA = "Whistle/1.0 ( https://github.com/friedtori/whistle )";

/**
 * Global MusicBrainz rate gate. A single named instance ("global") receives
 * every MusicBrainz request from every isolate, so the <= 1 request/second
 * rule holds across the whole deployment, which a per-isolate limiter cannot
 * guarantee on Workers.
 *
 * Scheduling is an in-memory queue of start slots: each call reserves the
 * next slot synchronously (Durable Object code is single-threaded, so two
 * calls can never take the same slot), sleeps until it, then fetches. Slots
 * are `MUSICBRAINZ_MIN_INTERVAL_MS` apart (default 1100 ms). The reservation
 * is not persisted: the object is only evicted after it has been idle, by
 * which point every reserved slot is already in the past.
 */
export class MusicBrainzGate extends DurableObject<Env> {
  private nextSlot = 0;

  private intervalMs(): number {
    const raw = Number(this.env.MUSICBRAINZ_MIN_INTERVAL_MS);
    return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_MUSICBRAINZ_MIN_INTERVAL_MS;
  }

  /** Reserve a start time; returns the wait in ms, or null when the queue is too long. */
  reserve(now = Date.now()): number | null {
    const slot = Math.max(now, this.nextSlot);
    const wait = slot - now;
    if (wait > MUSICBRAINZ_MAX_QUEUE_MS) return null;
    this.nextSlot = slot + this.intervalMs();
    return wait;
  }

  async get(path: string): Promise<JsonResponse<unknown>> {
    if (!/^[a-z-]+[/?]/.test(path)) {
      return { ok: false, status: 400, json: null, text: "invalid_path" };
    }
    const wait = this.reserve();
    if (wait == null) return { ok: false, status: 503, json: null, text: "musicbrainz_gate_busy" };
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const userAgent = this.env.MUSICBRAINZ_USER_AGENT?.trim() || DEFAULT_UA;
    return musicBrainzRequest(createHttpJson(), userAgent, path);
  }
}

/** Worker-side gate: one Durable Object call per MusicBrainz request, charged to the budget. */
export function createDurableMbGate(
  namespace: DurableObjectNamespace<MusicBrainzGate>,
  budget?: SubrequestBudget,
): MbGate {
  const stub = namespace.get(namespace.idFromName("global"));
  return {
    async get<T>(path: string): Promise<JsonResponse<T>> {
      if (budget && !budget.tryTake()) {
        return { ok: false, status: 0, json: null, text: "subrequest_budget_exhausted" };
      }
      try {
        return (await stub.get(path)) as JsonResponse<T>;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 0, json: null, text: message };
      }
    },
  };
}
