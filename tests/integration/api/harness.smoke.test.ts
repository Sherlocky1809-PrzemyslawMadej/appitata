import { describe, it, expect } from "vitest";
import { signInOverHttp, anonymousJar } from "../../helpers/http";

/**
 * HTTP harness smoke test — proves the Phase 2 harness end-to-end before any
 * contract assertions are built on it: server-spawn (globalSetup), signin over
 * the real route, and cookie replay all work.
 *
 * Uses `POST /api/friends/search` because it returns 200 only for an
 * authenticated caller (401 otherwise) and has no IDOR/mutation surface — a
 * clean probe of "is this jar authenticated?".
 */

const ALICE = { email: "alice@example.com", password: "test1234" } as const;
const BOB_EMAIL = "bob@example.com";

describe("HTTP harness smoke", () => {
  it("an authenticated jar reaches a protected API route (not 401)", async () => {
    const alice = await signInOverHttp(ALICE.email, ALICE.password);
    const { status, body } = await alice.postJson("/api/friends/search", { handle: BOB_EMAIL });

    expect(status).toBe(200);
    // Alice is accepted-connected to Bob in the seed; an exact email match resolves.
    expect(body).toMatchObject({ found: true });
  });

  it("an unauthenticated jar is rejected with 401 (the cookie is what authenticates)", async () => {
    const anon = anonymousJar();
    const { status } = await anon.postJson("/api/friends/search", { handle: BOB_EMAIL });

    expect(status).toBe(401);
  });
});
