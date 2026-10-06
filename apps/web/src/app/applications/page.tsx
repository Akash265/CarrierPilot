import Link from "next/link";
import { ApplicationsClient } from "./ApplicationsClient";

export default function ApplicationsPage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-8">
      <Link href="/" className="text-sm underline">← Home</Link>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Applications</h1>
        <Link href="/insights" className="text-sm underline">Insights →</Link>
      </div>
      <ApplicationsClient />
    </main>
  );
}
