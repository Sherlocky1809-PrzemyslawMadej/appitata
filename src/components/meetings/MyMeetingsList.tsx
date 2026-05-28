import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type InvitationStatus = "pending" | "accepted" | "declined" | "expired";

export interface MeetingWithInvitations {
  id: string;
  starts_at: string;
  duration_minutes: number;
  street: string;
  city: string;
  postal_code: string;
  country: string;
  description: string;
  created_at: string;
  invitations: {
    id: string;
    status: InvitationStatus;
    invited_at: string;
    invitee: { id: string; display_name: string | null } | null;
  }[];
}

interface Props {
  meetings: MeetingWithInvitations[];
}

function formatStartsAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatAddress(m: MeetingWithInvitations): string {
  return `${m.street}, ${m.city} ${m.postal_code}, ${m.country}`;
}

const badgeClass: Record<InvitationStatus, string> = {
  pending: "bg-slate-500/20 text-slate-200 border-slate-400/40",
  accepted: "bg-emerald-500/20 text-emerald-200 border-emerald-400/40",
  declined: "bg-rose-500/20 text-rose-200 border-rose-400/40",
  expired: "bg-zinc-500/20 text-zinc-300 border-zinc-400/40",
};

export default function MyMeetingsList({ meetings }: Props) {
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function handleDelete(meetingId: string) {
    const ok = window.confirm("Delete this meeting? Everyone invited will lose it.");
    if (!ok) return;
    setError(null);
    setDeleting((prev) => {
      const next = new Set(prev);
      next.add(meetingId);
      return next;
    });
    try {
      const res = await fetch(`/api/meetings/${meetingId}`, { method: "DELETE" });
      if (res.status === 204) {
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not delete meeting");
    } catch {
      setError("Network error");
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(meetingId);
        return next;
      });
    }
  }

  if (meetings.length === 0) {
    return (
      <p className="text-sm text-blue-100/60">
        You haven&apos;t created any meetings yet. Use the form above to schedule one with a connected friend.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      <ul className="space-y-3">
        {meetings.map((m) => {
          const accepted = m.invitations.filter((i) => i.status === "accepted").length;
          const invited = m.invitations.length;
          const isDeleting = deleting.has(m.id);

          return (
            <li key={m.id} className="rounded-lg border border-white/15 bg-white/5">
              <details className="group">
                <summary className="flex cursor-pointer items-center justify-between gap-3 p-4 text-white">
                  <div>
                    <p className="font-medium">{formatStartsAt(m.starts_at)}</p>
                    <p className="text-xs text-blue-100/60">
                      {m.duration_minutes} min · {accepted}/{invited} accepted
                    </p>
                  </div>
                  <span className="text-xs text-blue-100/50 group-open:hidden">expand</span>
                  <span className="hidden text-xs text-blue-100/50 group-open:inline">collapse</span>
                </summary>
                <div className="space-y-3 border-t border-white/10 p-4">
                  <div>
                    <p className="text-xs text-blue-100/50">Address</p>
                    <p className="text-sm text-white">{formatAddress(m)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-blue-100/50">Description</p>
                    <p className="text-sm whitespace-pre-line text-white">{m.description}</p>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-blue-100/50">Invitations</p>
                    <ul className="space-y-1">
                      {m.invitations.map((inv) => (
                        <li key={inv.id} className="flex items-center justify-between gap-3">
                          <span className="text-sm text-white">{inv.invitee?.display_name ?? "Unnamed friend"}</span>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${badgeClass[inv.status]}`}
                          >
                            {inv.status}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      onClick={() => handleDelete(m.id)}
                      disabled={isDeleting}
                      className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="flex items-center gap-2">
                        <Trash2 className="size-4" />
                        {isDeleting ? "Deleting..." : "Delete"}
                      </span>
                    </Button>
                  </div>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
