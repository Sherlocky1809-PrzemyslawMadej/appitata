import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface OutgoingRequest {
  id: string;
  requested_at: string;
  addressee: {
    id: string;
    display_name: string | null;
    email: string;
  };
}

interface Props {
  requests: OutgoingRequest[];
}

function formatRequestedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function OutgoingPendingList({ requests }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function cancel(requestId: string) {
    setPendingId(requestId);
    setError(null);
    try {
      const res = await fetch(`/api/friends/requests/${requestId}`, {
        method: "DELETE",
      });
      if (res.status === 204) {
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not cancel");
    } catch {
      setError("Network error");
    } finally {
      setPendingId(null);
    }
  }

  if (requests.length === 0) {
    return <p className="text-sm text-blue-100/60">No pending requests sent.</p>;
  }

  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      <ul className="space-y-2">
        {requests.map((r) => (
          <li
            key={r.id}
            className="flex flex-col gap-3 rounded-lg border border-white/15 bg-white/5 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="font-medium text-white">{r.addressee.display_name ?? r.addressee.email}</p>
              <p className="text-xs text-blue-100/60">Sent {formatRequestedAt(r.requested_at)}</p>
            </div>
            <Button
              type="button"
              onClick={() => cancel(r.id)}
              disabled={pendingId === r.id}
              variant="outline"
              className="rounded-lg border-white/30 bg-white/5 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              <Trash2 className="size-4" />
              Cancel
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
