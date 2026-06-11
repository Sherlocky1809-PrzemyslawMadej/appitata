import { useState } from "react";
import { Search, UserPlus } from "lucide-react";
import { FormField } from "@/components/auth/FormField";
import { Button } from "@/components/ui/button";

type SearchResult = { found: true; id: string; display_name: string | null } | { found: false };

export default function FriendSearch() {
  const [handle, setHandle] = useState("");
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function handleSearch(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!handle.trim()) return;
    setSearching(true);
    setError(null);
    setInfo(null);
    setResult(null);
    try {
      const res = await fetch("/api/friends/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: handle.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Search failed");
        return;
      }
      const body: SearchResult = await res.json();
      setResult(body);
    } catch {
      setError("Network error");
    } finally {
      setSearching(false);
    }
  }

  async function handleSendRequest() {
    if (!result?.found) return;
    setSending(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/friends/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addressee_id: result.id }),
      });
      if (res.status === 201) {
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 409) {
        setInfo(body.error === "already connected" ? "Already connected." : "Request already sent.");
      } else {
        setError(body.error ?? "Could not send request");
      }
    } catch {
      setError("Network error");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSearch} className="space-y-3">
        <FormField
          id="handle"
          label="Find by email or phone"
          value={handle}
          onChange={setHandle}
          placeholder="friend@example.com or +48 123 456 789"
          icon={<Search className="size-4" />}
        />
        <Button
          type="submit"
          disabled={searching || !handle.trim()}
          className="w-full rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500"
        >
          {searching ? "Searching..." : "Search"}
        </Button>
      </form>

      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      {info ? <p className="text-sm text-blue-100/80">{info}</p> : null}

      {result?.found ? (
        <div className="flex items-center justify-between rounded-lg border border-white/15 bg-white/5 p-4">
          <div>
            <p className="font-medium text-white">{result.display_name ?? "Unnamed parent"}</p>
            <p className="text-xs text-blue-100/60">Send a friend request</p>
          </div>
          <Button
            type="button"
            onClick={handleSendRequest}
            disabled={sending}
            className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500"
          >
            <UserPlus className="size-4" />
            {sending ? "Sending..." : "Send request"}
          </Button>
        </div>
      ) : null}

      {result && !result.found ? <p className="text-sm text-blue-100/70">No parent found with that handle.</p> : null}
    </div>
  );
}
