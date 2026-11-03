export interface JsonResponse<T> {
  ok: boolean;
  status: number;
  json: T | null;
  text: string;
}

export type HttpJson = <T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<JsonResponse<T>>;

/**
 * Counts outbound subrequests for one Worker invocation. Workers fail the whole
 * invocation once the platform limit is hit, so callers spend from a budget and
 * degrade (skip a provider, defer a batch item) before that happens. A child
 * budget caps one resolve and also spends from its parent.
 */
export class SubrequestBudget {
  private used = 0;

  constructor(
    readonly limit: number,
    private readonly parent?: SubrequestBudget,
  ) {}

  get remaining(): number {
    const own = this.limit - this.used;
    return this.parent ? Math.min(own, this.parent.remaining) : own;
  }

  get spent(): number {
    return this.used;
  }

  /** Returns false (and spends nothing) when the budget cannot cover `n`. */
  tryTake(n = 1): boolean {
    if (this.remaining < n) return false;
    this.used += n;
    this.parent?.tryTake(n);
    return true;
  }

  /**
   * Record a call that must happen regardless (D1 reads/writes). It is
   * counted against the budget but never refused; callers keep a reserve for it.
   */
  charge(n = 1): void {
    this.used += n;
    this.parent?.charge(n);
  }

  child(limit: number): SubrequestBudget {
    return new SubrequestBudget(limit, this);
  }
}

export const BUDGET_EXHAUSTED = "subrequest_budget_exhausted";

export function createHttpJson(budget?: SubrequestBudget): HttpJson {
  return async function request<T>(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<JsonResponse<T>> {
    if (budget && !budget.tryTake()) {
      return { ok: false, status: 0, json: null, text: BUDGET_EXHAUSTED };
    }
    const { timeoutMs = 8000, ...rest } = init;
    const signal = rest.signal ?? AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal });
      const text = await res.text();
      let json: T | null = null;
      if (text) {
        try {
          json = JSON.parse(text) as T;
        } catch {
          json = null;
        }
      }
      return { ok: res.ok, status: res.status, json, text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, json: null, text: message };
    }
  };
}

/** Unbudgeted request helper (Node scripts, tests). */
export const httpJson: HttpJson = createHttpJson();

/** RFC 7617 Basic credentials without Node's Buffer. */
export function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
