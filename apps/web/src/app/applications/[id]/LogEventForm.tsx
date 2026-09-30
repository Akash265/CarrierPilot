"use client";

import { useState, type FormEvent } from "react";

type Kind = "note" | "recruiter_contact" | "interview";

/** Posts one user event; `onLogged` reloads the page data. */
export function LogEventForm({ applicationId, onLogged }: { applicationId: string; onLogged: () => void }) {
  const [kind, setKind] = useState<Kind>("note");
  const [text, setText] = useState("");
  const [channel, setChannel] = useState("email");
  const [interviewKind, setInterviewKind] = useState("phone_screen");
  const [round, setRound] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const body =
      kind === "note"
        ? { type: "note", detail: { text } }
        : kind === "recruiter_contact"
          ? { type: "recruiter_contact", detail: { channel, summary: text } }
          : {
              type: "interview",
              detail: {
                kind: interviewKind,
                summary: text,
                ...(round ? { round: Number(round) } : {}),
                ...(scheduledFor ? { scheduledFor: new Date(scheduledFor).toISOString() } : {}),
              },
            };
    try {
      const res = await fetch(`/api/applications/${applicationId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(typeof b.error === "string" ? b.error : "Could not log the event.");
        return;
      }
      setText("");
      onLogged();
    } catch {
      setError("Could not log the event.");
    }
  };

  return (
    <form onSubmit={submit} aria-label="Log event" className="flex flex-col gap-2 rounded border p-4 text-sm">
      <h2 className="font-medium">Log an event</h2>
      <label className="flex flex-col gap-1">
        Event type
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="rounded border p-1">
          <option value="note">Note</option>
          <option value="recruiter_contact">Recruiter contact</option>
          <option value="interview">Interview</option>
        </select>
      </label>
      {kind === "recruiter_contact" && (
        <label className="flex flex-col gap-1">
          Channel
          <select value={channel} onChange={(e) => setChannel(e.target.value)} className="rounded border p-1">
            <option value="email">Email</option><option value="phone">Phone</option><option value="linkedin">LinkedIn</option><option value="other">Other</option>
          </select>
        </label>
      )}
      {kind === "interview" && (
        <div className="flex gap-2">
          <label className="flex flex-col gap-1">
            Interview kind
            <select value={interviewKind} onChange={(e) => setInterviewKind(e.target.value)} className="rounded border p-1">
              <option value="phone_screen">Phone screen</option><option value="technical">Technical</option><option value="behavioral">Behavioral</option>
              <option value="onsite">Onsite</option><option value="panel">Panel</option><option value="other">Other</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">Round<input type="number" min={1} max={20} value={round} onChange={(e) => setRound(e.target.value)} className="w-16 rounded border p-1" /></label>
          <label className="flex flex-col gap-1">Scheduled for<input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} className="rounded border p-1" /></label>
        </div>
      )}
      <label className="flex flex-col gap-1">
        {kind === "note" ? "Note" : "Summary (optional)"}
        <textarea value={text} onChange={(e) => setText(e.target.value)} required={kind === "note"} maxLength={kind === "note" ? 5000 : 2000} className="rounded border p-1" />
      </label>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <button type="submit" className="self-start rounded bg-black px-3 py-1.5 text-white">Log event</button>
    </form>
  );
}
