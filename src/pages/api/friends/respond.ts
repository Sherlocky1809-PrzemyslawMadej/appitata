import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const respondSchema = z.object({
  request_id: z.string().regex(UUID_SHAPE, "invalid UUID"),
  action: z.enum(["accept", "decline"]),
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

  const parsed = respondSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return json({ error: "Supabase is not configured" }, 500);
  }

  const nextStatus = parsed.data.action === "accept" ? "accepted" : "declined";

  const { data, error } = await supabase
    .from("friend_connections")
    .update({ status: nextStatus })
    .eq("id", parsed.data.request_id)
    .select("id, status")
    .maybeSingle();

  if (error) {
    return json({ error: error.message }, 500);
  }
  if (!data) {
    // RLS USING filtered the row out: either it doesn't exist, the caller is
    // not the addressee, or the status is no longer pending.
    return json({ error: "not found" }, 404);
  }

  return json({ id: data.id, status: data.status }, 200);
};
