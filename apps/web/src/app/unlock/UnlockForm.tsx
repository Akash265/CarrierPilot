"use client";

import { useState, type FormEvent } from "react";

export function UnlockForm({ next }: { next: string }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.status === 204) {
        window.location.assign(next);
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? `Unlock failed (${res.status})`);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Access token
        <input
          type="password"
          name="token"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="rounded border px-2 py-1"
          required
        />
      </label>
      <button type="submit" disabled={busy || token.length === 0} className="rounded bg-black px-3 py-1 text-white disabled:opacity-50">
        {busy ? "Unlocking…" : "Unlock"}
      </button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
