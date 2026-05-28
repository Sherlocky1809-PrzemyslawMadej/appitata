import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";

// UUID-shape only; the DB FK + CHECK + RLS are the real boundary. Loose enough
// to accept fixture UUIDs whose version nibble isn't a real RFC 4122 version.
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const requestSchema = z.object({
  addressee_id: z.string().regex(UUID_SHAPE, "invalid UUID"),
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }

  const { addressee_id } = parsed.data;

  if (addressee_id === user.id) {
    return json({ error: "cannot request self" }, 422);
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return json({ error: "Supabase is not configured" }, 500);
  }

  // Pre-INSERT guard: catch the reverse-direction-after-accepted dangling-pending
  // case the UNIQUE (requester_id, addressee_id) constraint cannot, because the
  // accepted row already exists with (other, self) and the new INSERT would be
  // (self, other) — a different pair.
  //
  // TOCTOU race tolerated: two concurrent reverse-direction requests can both pass
  // this check and both INSERT, producing two dangling pending rows (both legal
  // under UNIQUE since direction differs). Worst case is UI weirdness at low qps,
  // not data corruption. Revisit if it ever surfaces.
  const { data: connected, error: connectedError } = await supabase.rpc("is_connected", {
    viewer: user.id,
    owner: addressee_id,
  });

  if (connectedError) {
    return json({ error: connectedError.message }, 500);
  }
  if (connected) {
    return json({ error: "already connected" }, 409);
  }

  const { data, error } = await supabase
    .from("friend_connections")
    .insert({ requester_id: user.id, addressee_id, status: "pending" })
    .select("id, status")
    .single();

  if (error) {
    if (error.code === "23505") return json({ error: "already requested" }, 409);
    if (error.code === "23514") return json({ error: "cannot request self" }, 422);
    if (error.code === "23503") return json({ error: "not found" }, 404);
    return json({ error: error.message }, 500);
  }

  return json({ id: data.id, status: data.status }, 201);
};
