export interface RetryOptions {
  attempts?: number; // total attempts, default 3
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; status: number | null; delayMs: number; error?: string }) => void;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

export const isRetryableStatus = (s: number) => s === 429 || s >= 500;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter. Retries only 429, 5xx and network errors. Honours Retry-After (seconds). */
export async function fetchWithRetry(doFetch: () => Promise<Response>, opts: RetryOptions = {}): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 250;
  const max = opts.maxMs ?? 4000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    let netErr: unknown = null;
    try {
      res = await doFetch();
    } catch (e) {
      netErr = e;
    }
    const retryable = netErr !== null || (res !== null && isRetryableStatus(res.status));
    if (!retryable || attempt >= attempts) {
      if (netErr) throw netErr;
      return res!;
    }
    const retryAfter = Number(res?.headers.get("retry-after"));
    const backoff = Math.min(max, base * 2 ** (attempt - 1));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(max, retryAfter * 1000) : Math.round(random() * backoff);
    opts.onRetry?.({ attempt, status: res?.status ?? null, delayMs, error: netErr ? String(netErr) : undefined });
    await sleep(delayMs);
  }
}

export async function httpJson<T = unknown>(url: string, init: RequestInit, opts: RetryOptions & { fetchImpl?: typeof fetch } = {}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const res = await fetchWithRetry(() => f(url, init), opts);
  const text = await res.text();
  if (!res.ok) throw new HttpError(`${init.method ?? "GET"} ${new URL(url).pathname} failed with ${res.status}`, res.status, text.slice(0, 500));
  return (text ? JSON.parse(text) : {}) as T;
}
