export interface JsonResponse<T> {
  ok: boolean;
  status: number;
  json: T | null;
  text: string;
}

export async function httpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<JsonResponse<T>> {
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
