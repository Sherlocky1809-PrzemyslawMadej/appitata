/**
 * HTTP cookie-jar helper for the API integration suite.
 *
 * The API routes authenticate from a cookie-bound Supabase SSR client — there is
 * no bearer-token path (see research.md §"The harness question"). So a test acts
 * as a real user by signing in through the real `/api/auth/signin` route and
 * replaying the resulting session cookie on every subsequent request.
 *
 * Each jar is independent, so two distinct authenticated users can be exercised
 * in the same test (`const alice = await signInOverHttp(...); const bob = ...`).
 *
 * Talks to the server stood up by `tests/setup/server.ts` (globalSetup) at
 * TEST_BASE_URL (default http://localhost:4321).
 */

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:4321";

export interface JsonResponse {
  status: number;
  body: unknown;
}

export interface Jar {
  /** The replayed `Cookie` header value (empty string for an anonymous jar). */
  readonly cookie: string;
  /** Low-level fetch against the test server with the jar's cookie attached. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Fetch + parse the body as JSON (falls back to raw text on parse failure). */
  json(path: string, init?: RequestInit): Promise<JsonResponse>;
  /** POST a JSON body and parse the response. */
  postJson(path: string, data: unknown): Promise<JsonResponse>;
}

/**
 * `@supabase/ssr` may chunk a large session across `sb-…-auth-token.0/.1`, so we
 * must capture EVERY Set-Cookie value, not just the first. Node's `fetch` exposes
 * `Headers.getSetCookie()` for exactly this; fall back to the single-header getter
 * on older runtimes.
 */
function captureSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

/** Reduce Set-Cookie directives to a replayable `name=value; name=value` string. */
function toCookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

function makeJar(cookie: string): Jar {
  const jarFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("Cookie", cookie);
    // Same-origin `Origin` header, as a real browser `fetch` always sends on a
    // non-GET request. Astro's CSRF middleware 403s any non-safe method whose
    // `origin` doesn't match the server's when there's no form content-type —
    // notably a body-less DELETE. Without this, every DELETE would 403 before
    // reaching the route (and an anon DELETE's real 401 would be masked). JSON
    // POSTs are CSRF-exempt, so the Phase-1 smoke test never exercised this.
    if (!headers.has("Origin")) headers.set("Origin", BASE_URL);
    // `redirect: "manual"` so a 302 (e.g. a middleware redirect) is observable as
    // a status rather than silently followed — API routes return JSON, but this
    // keeps the contract honest for any route that redirects.
    return fetch(`${BASE_URL}${path}`, { ...init, headers, redirect: "manual" });
  };

  const jarJson = async (path: string, init?: RequestInit): Promise<JsonResponse> => {
    const res = await jarFetch(path, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text — a non-JSON body is itself a useful assertion target
    }
    return { status: res.status, body };
  };

  return {
    cookie,
    fetch: jarFetch,
    json: jarJson,
    postJson: (path, data) =>
      jarJson(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
  };
}

/**
 * Sign in as a seeded identity over the real HTTP auth path and return an
 * authenticated jar.
 *
 * Posts form-encoded credentials to `/api/auth/signin` with redirects NOT
 * followed, then asserts the route returned `302 → /` — a `302 → /auth/signin?error=…`
 * means bad credentials. Throwing here is the HTTP edition of the silent-pass
 * guard: a non-owner 404 and a no-session 404 are indistinguishable, so a broken
 * login must never silently degrade into an anonymous jar.
 */
export async function signInOverHttp(email: string, password: string): Promise<Jar> {
  const res = await fetch(`${BASE_URL}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE_URL },
    body: new URLSearchParams({ email, password }),
    redirect: "manual",
  });

  const location = res.headers.get("location");
  if (res.status !== 302 || location !== "/") {
    const text = await res.text().catch(() => "");
    throw new Error(`signInOverHttp(${email}) failed: status=${res.status} location=${location} body=${text}`);
  }

  const cookie = toCookieHeader(captureSetCookies(res));
  if (!cookie) {
    throw new Error(`signInOverHttp(${email}) returned no Set-Cookie — session cookie missing, jar would be anonymous`);
  }
  return makeJar(cookie);
}

/** An unauthenticated jar — the negative control proving the cookie is what authenticates. */
export function anonymousJar(): Jar {
  return makeJar("");
}
