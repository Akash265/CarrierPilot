import { loadEnv } from "@ai-career/config";
import { ApplicationDetailClient } from "./ApplicationDetailClient";

// Next 16: dynamic route params arrive as a Promise.
export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-3xl p-8">
      <ApplicationDetailClient id={id} retentionDays={loadEnv().RETENTION_DAYS} />
    </main>
  );
}
