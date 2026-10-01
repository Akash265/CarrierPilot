import { STATUS_LABELS } from "../../../lib/applications/statusLabels";

export interface EventView {
  id: string;
  type: string;
  occurredAt: string;
  fromStatus: string | null;
  toStatus: string | null;
  detail: unknown;
}

const label = (s: string | null) => (s ? STATUS_LABELS[s] ?? s : "");
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function describeEvent(e: EventView): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "status_change":
      return e.fromStatus ? `Status: ${label(e.fromStatus)} → ${label(e.toStatus)}` : label(e.toStatus);
    case "note":
      return `Note: ${str(d.text)}`;
    case "recruiter_contact":
      return `Recruiter contact (${str(d.channel)})${str(d.summary) ? `: ${str(d.summary)}` : ""}`;
    case "interview": {
      const round = typeof d.round === "number" ? ` round ${d.round}` : "";
      const when = str(d.scheduledFor) ? ` scheduled for ${new Date(str(d.scheduledFor)).toLocaleString()}` : "";
      return `Interview${round} (${str(d.kind)})${when}${str(d.summary) ? `: ${str(d.summary)}` : ""}`;
    }
    case "follow_up_done":
      return "Follow-up done";
    case "follow_up_snoozed":
      return `Follow-up snoozed to ${str(d.newFollowUpAt)}`;
    case "documents_purged":
      return "Generated documents deleted after the retention period";
    default:
      return e.type;
  }
}

export function EventTimeline({ events }: { events: EventView[] }) {
  return (
    <section aria-labelledby="timeline-heading">
      <h2 id="timeline-heading" className="mb-2 font-medium">Timeline</h2>
      <ol className="flex flex-col gap-1 text-sm">
        {events.map((e) => (
          <li key={e.id}>
            <span className="text-gray-600">{new Date(e.occurredAt).toLocaleDateString()}</span> — {describeEvent(e)}
          </li>
        ))}
      </ol>
    </section>
  );
}
