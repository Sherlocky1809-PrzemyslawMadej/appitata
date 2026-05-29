import { useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ClashingMeetingSummary, PendingInvitation } from "./types";

interface Props {
  invitations: PendingInvitation[];
  conflicts: Record<string, ClashingMeetingSummary[]>;
}

function formatStartsAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatAddress(m: PendingInvitation["meeting"]): string {
  return `${m.street}, ${m.city} ${m.postal_code}, ${m.country}`;
}

export default function PendingInvitationsList({ invitations, conflicts }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(invitationId: string, action: "accept" | "decline") {
    setPendingId(invitationId);
    setError(null);
    try {
      const res = await fetch("/api/meetings/invitations/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitation_id: invitationId, action }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not respond");
    } catch {
      setError("Network error");
    } finally {
      setPendingId(null);
    }
  }

  if (invitations.length === 0) {
    return <p className="text-sm text-blue-100/60">No pending invitations.</p>;
  }

  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      <ul className="space-y-3">
        {invitations.map((r) => {
          const m = r.meeting;
          const rowConflicts = conflicts[r.invitation_id] ?? [];
          const isPending = pendingId === r.invitation_id;
          return (
            <li
              key={r.invitation_id}
              data-testid="pending-invitation"
              data-invitation-id={r.invitation_id}
              className="space-y-3 rounded-lg border border-white/15 bg-white/5 p-4"
            >
              <div>
                <p className="font-medium text-white">{formatStartsAt(m.starts_at)}</p>
                <p className="text-xs text-blue-100/60">
                  {m.duration_minutes} min · Created by {m.creator?.display_name ?? "Unnamed friend"}
                </p>
              </div>
              <div>
                <p className="text-xs text-blue-100/50">Address</p>
                <p className="text-sm text-white">{formatAddress(m)}</p>
              </div>
              <div>
                <p className="text-xs text-blue-100/50">Description</p>
                <p className="text-sm whitespace-pre-line text-white">{m.description}</p>
              </div>
              {rowConflicts.length > 0 ? (
                <div
                  data-testid="conflict-warning"
                  className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-amber-200"
                >
                  <p className="text-sm font-medium">Heads up — this overlaps with:</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                    {rowConflicts.map((c) => (
                      <li key={c.id}>
                        {formatStartsAt(c.starts_at)} ({c.duration_minutes} min)
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  data-testid="accept-button"
                  onClick={() => respond(r.invitation_id, "accept")}
                  disabled={isPending}
                  className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Check className="size-4" />
                  Accept
                </Button>
                <Button
                  type="button"
                  data-testid="decline-button"
                  onClick={() => respond(r.invitation_id, "decline")}
                  disabled={isPending}
                  variant="outline"
                  className="rounded-lg border-white/30 bg-white/5 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <X className="size-4" />
                  Decline
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
