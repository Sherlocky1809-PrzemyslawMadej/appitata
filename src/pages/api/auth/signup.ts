import type { APIRoute } from "astro";
import { z } from "zod";
import { createClient } from "@/lib/supabase";

const signupSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(6),
  display_name: z.string().trim().min(1).max(80),
  phone: z
    .string()
    .trim()
    .regex(/^\+[0-9 ]+$/, "Phone must start with + and contain only digits and spaces")
    .optional()
    .or(z.literal("")),
});

export const POST: APIRoute = async (context) => {
  const form = await context.request.formData();
  const parsed = signupSchema.safeParse(Object.fromEntries(form.entries()));

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid form input";
    return context.redirect(`/auth/signup?error=${encodeURIComponent(message)}`);
  }

  const { email, password, display_name } = parsed.data;
  // Normalise phone to digits + leading `+` on the way in, so the trigger and
  // find_parent_by_handle's normalisation match. Empty string -> null.
  const phoneRaw = parsed.data.phone ?? "";
  const phone = phoneRaw ? phoneRaw.replace(/[^0-9+]/g, "") : null;

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/auth/signup?error=${encodeURIComponent("Supabase is not configured")}`);
  }

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name, phone },
    },
  });

  if (error) {
    return context.redirect(`/auth/signup?error=${encodeURIComponent(error.message)}`);
  }

  return context.redirect("/auth/confirm-email");
};
