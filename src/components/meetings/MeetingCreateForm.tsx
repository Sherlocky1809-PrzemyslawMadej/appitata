import { useState } from "react";
import { Building2, CalendarClock, CalendarPlus, FileText, Globe, Hash, MapPin, Users } from "lucide-react";
import { FormField } from "@/components/auth/FormField";
import { ServerError } from "@/components/auth/ServerError";
import { Button } from "@/components/ui/button";

interface Friend {
  id: string;
  display_name: string | null;
}

interface Props {
  friends: Friend[];
}

type FieldErrors = Partial<Record<"starts_at" | "street" | "city" | "postal_code" | "country" | "description", string>>;

const textareaClass =
  "w-full rounded-lg border bg-white/10 px-3 py-2 pl-10 text-white placeholder-white/40 transition-colors focus:outline-none focus:ring-2 resize-y";

export default function MeetingCreateForm({ friends }: Props) {
  const [startsAtLocal, setStartsAtLocal] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");
  const [description, setDescription] = useState("");
  const [selectedInvitees, setSelectedInvitees] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  if (friends.length === 0) {
    return (
      <p className="text-sm text-blue-100/70">
        Connect with a friend on{" "}
        <a href="/friends" className="underline hover:text-white">
          /friends
        </a>{" "}
        before creating a meeting.
      </p>
    );
  }

  function toggleInvitee(id: string) {
    setSelectedInvitees((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    if (!startsAtLocal) errs.starts_at = "pick a date and time";
    if (!street.trim()) errs.street = "street is required";
    else if (street.trim().length > 200) errs.street = "street is too long";
    if (!city.trim()) errs.city = "city is required";
    else if (city.trim().length > 100) errs.city = "city is too long";
    if (!postalCode.trim()) errs.postal_code = "postal code is required";
    else if (postalCode.trim().length > 20) errs.postal_code = "postal code is too long";
    if (!country.trim()) errs.country = "country is required";
    else if (country.trim().length > 100) errs.country = "country is too long";
    if (!description.trim()) errs.description = "description is required";
    else if (description.trim().length > 500) errs.description = "description is too long (max 500)";
    return errs;
  }

  async function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }

    // `<input type="datetime-local">` produces a wall-clock string with no
    // timezone. Convert via the browser's local TZ → UTC ISO before POSTing.
    const parsed = new Date(startsAtLocal);
    if (Number.isNaN(parsed.getTime())) {
      setFieldErrors({ starts_at: "invalid date/time" });
      return;
    }
    const startsAtIso = parsed.toISOString();

    setFieldErrors({});
    setSubmitting(true);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          starts_at: startsAtIso,
          street: street.trim(),
          city: city.trim(),
          postal_code: postalCode.trim(),
          country: country.trim(),
          description: description.trim(),
          invitee_ids: Array.from(selectedInvitees),
        }),
      });
      if (res.status === 201) {
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not create meeting");
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  const descriptionErr = fieldErrors.description;
  const disabled = submitting || selectedInvitees.size === 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <FormField
        id="starts_at"
        label="Date & time"
        type="datetime-local"
        value={startsAtLocal}
        onChange={setStartsAtLocal}
        icon={<CalendarClock className="size-4" />}
        error={fieldErrors.starts_at}
      />
      <FormField
        id="street"
        label="Street"
        value={street}
        onChange={setStreet}
        placeholder="ul. Marszałkowska 1"
        icon={<MapPin className="size-4" />}
        error={fieldErrors.street}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="city"
          label="City"
          value={city}
          onChange={setCity}
          placeholder="Warsaw"
          icon={<Building2 className="size-4" />}
          error={fieldErrors.city}
        />
        <FormField
          id="postal_code"
          label="Postal code"
          value={postalCode}
          onChange={setPostalCode}
          placeholder="00-001"
          icon={<Hash className="size-4" />}
          error={fieldErrors.postal_code}
        />
      </div>
      <FormField
        id="country"
        label="Country"
        value={country}
        onChange={setCountry}
        placeholder="PL"
        icon={<Globe className="size-4" />}
        error={fieldErrors.country}
      />

      <div>
        <label htmlFor="description" className="mb-1 block text-sm text-blue-100/80">
          Description
        </label>
        <div className="relative">
          <span className="absolute top-3 left-3 size-4 text-white/40">
            <FileText className="size-4" />
          </span>
          <textarea
            id="description"
            name="description"
            rows={4}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            placeholder="What's the plan?"
            className={`${textareaClass} ${descriptionErr ? "border-red-400/60 focus:ring-red-400" : "border-white/20 focus:ring-purple-400"}`}
          />
        </div>
        {descriptionErr ? (
          <p className="mt-1 text-xs text-red-300">{descriptionErr}</p>
        ) : (
          <p className="mt-1 text-xs text-blue-100/50">Up to 500 characters.</p>
        )}
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm text-blue-100/80">
          <Users className="size-4" />
          Invite friends
        </h3>
        <ul className="space-y-2">
          {friends.map((f) => (
            <li key={f.id} className="rounded-lg border border-white/15 bg-white/5 px-3 py-2">
              <label className="flex cursor-pointer items-center gap-3 text-white">
                <input
                  type="checkbox"
                  checked={selectedInvitees.has(f.id)}
                  onChange={() => {
                    toggleInvitee(f.id);
                  }}
                  className="size-4 accent-purple-500"
                />
                <span>{f.display_name ?? "Unnamed friend"}</span>
              </label>
            </li>
          ))}
        </ul>
        {selectedInvitees.size === 0 ? (
          <p className="mt-2 text-xs text-blue-100/50">Select at least one friend.</p>
        ) : null}
      </div>

      <ServerError message={error} />

      <Button
        type="submit"
        disabled={disabled}
        className="w-full rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="flex items-center justify-center gap-2">
          <CalendarPlus className="size-4" />
          {submitting ? "Creating..." : "Create meeting"}
        </span>
      </Button>
    </form>
  );
}
