import type { SubrequestBudget } from "./http.ts";
import { generateNonce, NONCE_TTL_MS } from "./verification.ts";

const RETAIN_MS = 2 * 24 * 60 * 60 * 1000;

/** D1 bookkeeping for the verification handshake: nonces and quota counters. */
export class AuthStore {
  constructor(
    private readonly db: D1Database,
    private readonly budget?: SubrequestBudget,
  ) {}

  /**
   * Issue a single-use nonce valid for 5 minutes. Old nonces and counter
   * windows are pruned in the same round trip (challenges are rare, so this
   * keeps the tables small without a cron).
   */
  async issueNonce(now: number): Promise<{ nonce: string; expiresAt: number }> {
    const nonce = generateNonce();
    const expiresAt = now + NONCE_TTL_MS;
    this.budget?.charge(1);
    await this.db.batch([
      this.db
        .prepare("INSERT INTO verification_nonces (nonce, issued_at, expires_at) VALUES (?, ?, ?)")
        .bind(nonce, now, expiresAt),
      this.db.prepare("DELETE FROM verification_nonces WHERE expires_at < ?").bind(now - RETAIN_MS),
      this.db.prepare("DELETE FROM quota_counters WHERE window_start < ?").bind(now - RETAIN_MS),
    ]);
    return { nonce, expiresAt };
  }

  /**
   * Atomically mark an issued, unexpired, unused nonce as used. Returns false
   * for unknown, expired, or already-used nonces (a single UPDATE, so two
   * concurrent proofs of the same nonce cannot both succeed).
   */
  async consumeNonce(nonce: string, now: number): Promise<boolean> {
    this.budget?.charge(1);
    const row = await this.db
      .prepare(
        `UPDATE verification_nonces SET used_at = ?
         WHERE nonce = ? AND used_at IS NULL AND expires_at > ?
         RETURNING nonce`,
      )
      .bind(now, nonce, now)
      .first<{ nonce: string }>();
    return row?.nonce === nonce;
  }

  /** Add `by` to a fixed-window counter and return the new total. */
  async increment(key: string, windowStart: number, by: number): Promise<number> {
    this.budget?.charge(1);
    const row = await this.db
      .prepare(
        `INSERT INTO quota_counters (key, window_start, count) VALUES (?, ?, ?)
         ON CONFLICT (key, window_start) DO UPDATE SET count = count + excluded.count
         RETURNING count`,
      )
      .bind(key, windowStart, by)
      .first<{ count: number }>();
    return row?.count ?? by;
  }
}
