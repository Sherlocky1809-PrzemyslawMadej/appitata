import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const createSchema = z.object({
  // Strict ISO with timezone — the UI must convert `<input type="datetime-local">`'s
  // wall-clock string via `new Date(value).toISOString()` before POSTing, otherwise
  // Postgres interprets a bare wall-clock with the session TZ (which on Workers is
  // not the user's). See plan §Critical Implementation Details — Datetime client-side
  // conversion is load-bearing.
  starts_at: z.iso.datetime({ message: "starts_at must be a strict ISO datetime with timezone" }),
  duration_minutes: z.number().int().min(1).max(1440).optional(),
  street: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  postal_code: z.string().trim().min(1).max(20),
  country: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  // Cap mirrors the RPC's defense-in-depth cap (see meetings_foundation migration).
  invitee_ids: z.array(z.string().regex(UUID_SHAPE, "invalid UUID")).min(1).max(50),
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST: APIRoute = async (context) => {
  if (!context.locals.user) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }

  const { starts_at, duration_minutes, street, city, postal_code, country, description, invitee_ids } = parsed.data;

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return json({ error: "Supabase is not configured" }, 500);
  }

  const { data, error } = await supabase.rpc("create_meeting_with_invitations", {
    p_starts_at: starts_at,
    p_duration_minutes: duration_minutes ?? 60,
    p_street: street,
    p_city: city,
    p_postal_code: postal_code,
    p_country: country,
    p_description: description,
    p_invitee_ids: invitee_ids,
  });

  if (error) {
    // Postgres-native error codes from constraint violations
    if (error.code === "23505") return json({ error: "duplicate invitee in request" }, 422);
    if (error.code === "23514") return json({ error: "invalid field shape" }, 400);
    // RPC-raised exceptions (same SQLSTATE 42501/22023; message disambiguates)
    if (error.message === "invitee not connected") {
      return json({ error: "one or more invitees are not connected friends" }, 403);
    }
    if (error.message === "authentication required") {
      // Defense-in-depth: the locals.user guard above should have caught this already.
      return json({ error: "unauthorized" }, 401);
    }
    if (error.message === "at least one invitee required") {
      return json({ error: "at least one invitee required" }, 400);
    }
    if (error.message === "too many invitees (max 50)") {
      return json({ error: "too many invitees (max 50)" }, 400);
    }
    // SQLSTATE fallback: a renamed RAISE message degrades to the right HTTP class, not 500.
    if (error.code === "42501") return json({ error: "unauthorized" }, 403);
    if (error.code === "22023") return json({ error: "invalid request" }, 400);
    return json({ error: error.message }, 500);
  }

  return json({ meeting_id: data }, 201);
};
