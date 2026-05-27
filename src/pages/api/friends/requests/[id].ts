import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const paramSchema = z.string().regex(UUID_SHAPE, "invalid UUID");

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const DELETE: APIRoute = async (context) => {
  if (!context.locals.user) {
    return json({ error: "unauthorized" }, 401);
  }

  const parsed = paramSchema.safeParse(context.params.id);
  if (!parsed.success) {
    return json({ error: "invalid id" }, 400);
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return json({ error: "Supabase is not configured" }, 500);
  }

  const { data, error } = await supabase
    .from("friend_connections")
    .delete()
    .eq("id", parsed.data)
    .select("id")
    .maybeSingle();

  if (error) {
    return json({ error: error.message }, 500);
  }
  if (!data) {
    // RLS USING filtered the row out: either it doesn't exist, the caller is
    // not the requester, or the status is no longer pending.
    return json({ error: "not found" }, 404);
  }

  return new Response(null, { status: 204 });
};
