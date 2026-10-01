"use client";

import { useState, type FormEvent } from "react";

export interface EditableFields {
  recruiterName: string | null;
  recruiterContact: string | null;
  salaryNotes: string | null;
  notes: string | null;
  followUpAt: string | null;
}

export function EditApplicationForm({ applicationId, initial, onSaved }: { applicationId: string; initial: EditableFields; onSaved: () => void }) {
  const [fields, setFields] = useState({
    recruiterName: initial.recruiterName ?? "",
    recruiterContact: initial.recruiterContact ?? "",
    salaryNotes: initial.salaryNotes ?? "",
    notes: initial.notes ?? "",
    followUpAt: initial.followUpAt ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof fields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const res = await fetch(`/api/applications/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recruiterName: fields.recruiterName || null,
          recruiterContact: fields.recruiterContact || null,
          salaryNotes: fields.salaryNotes || null,
          notes: fields.notes || null,
          followUpAt: fields.followUpAt || null,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(typeof b.error === "string" ? b.error : "Could not save.");
        return;
      }
      onSaved();
    } catch {
      setError("Could not save.");
    }
  };

  return (
    <form onSubmit={submit} aria-label="Edit application" className="grid grid-cols-2 gap-2 rounded border p-4 text-sm">
      <h2 className="col-span-2 font-medium">Details</h2>
      <label className="flex flex-col gap-1">Recruiter name<input value={fields.recruiterName} onChange={set("recruiterName")} maxLength={200} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Recruiter contact<input value={fields.recruiterContact} onChange={set("recruiterContact")} maxLength={300} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Salary notes<input value={fields.salaryNotes} onChange={set("salaryNotes")} maxLength={500} className="rounded border p-1" /></label>
      <label className="flex flex-col gap-1">Follow-up date<input type="date" value={fields.followUpAt} onChange={set("followUpAt")} className="rounded border p-1" /></label>
      <label className="col-span-2 flex flex-col gap-1">Notes<textarea value={fields.notes} onChange={set("notes")} maxLength={5000} className="rounded border p-1" /></label>
      {error && <p role="alert" className="col-span-2 text-red-600">{error}</p>}
      <button type="submit" className="self-start rounded bg-black px-3 py-1.5 text-white">Save details</button>
    </form>
  );
}
