import { useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface IncomingRequest {
  id: string;
  requested_at: string;
  requester: {
    id: string;
    display_name: string | null;
    email: string;
  };
}

interface Props {
  requests: IncomingRequest[];
}

function formatRequestedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function IncomingRequestsList({ requests }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(requestId: string, action: "accept" | "decline") {
    setPendingId(requestId);
    setError(null);
    try {
      const res = await fetch("/api/friends/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId, action }),
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

  if (requests.length === 0) {
    return <p className="text-sm text-blue-100/60">No incoming requests.</p>;
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
              <p className="font-medium text-white">{r.requester.display_name ?? r.requester.email}</p>
              <p className="text-xs text-blue-100/60">Requested {formatRequestedAt(r.requested_at)}</p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => respond(r.id, "accept")}
                disabled={pendingId === r.id}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
              >
                <Check className="size-4" />
                Accept
              </Button>
              <Button
                type="button"
                onClick={() => respond(r.id, "decline")}
                disabled={pendingId === r.id}
                variant="outline"
                className="rounded-lg border-white/30 bg-white/5 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10"
              >
                <X className="size-4" />
                Decline
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
