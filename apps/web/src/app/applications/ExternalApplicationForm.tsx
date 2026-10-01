"use client";

import { useState, type FormEvent } from "react";

/** For jobs applied to outside the platform (design decision 1). */
export function ExternalApplicationForm({ onCreated }: { onCreated: () => void }) {
  const [companyName, setCompanyName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [appliedAt, setAppliedAt] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ external: { companyName, jobTitle, jobUrl: jobUrl || null }, appliedAt }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === "string" ? body.error : "Could not add the application.");
        return;
      }
      setCompanyName("");
      setJobTitle("");
      setJobUrl("");
      onCreated();
    } catch {
      setError("Could not add the application.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label="Add external application" className="flex flex-wrap items-end gap-3 rounded border p-4 text-sm">
      <label className="flex flex-col gap-1">Company<input value={companyName} onChange={(e) => setCompanyName(e.target.value)} required maxLength={200} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Job title<input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} required maxLength={300} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Posting URL (optional)<input type="url" value={jobUrl} onChange={(e) => setJobUrl(e.target.value)} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Applied on<input type="date" value={appliedAt} onChange={(e) => setAppliedAt(e.target.value)} required className="rounded border p-1" /></label>
      <button type="submit" disabled={submitting} className="rounded bg-black px-3 py-1.5 text-white disabled:opacity-50">Add external application</button>
      {error && <p role="alert" className="w-full text-red-600">{error}</p>}
    </form>
  );
}
