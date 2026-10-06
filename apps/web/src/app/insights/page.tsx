import Link from "next/link";
import { InsightsClient } from "./InsightsClient";

export default function InsightsPage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-8">
      <Link href="/" className="text-sm underline">← Home</Link>
      <h1 className="text-2xl font-semibold">Insights</h1>
      <p className="text-sm text-gray-600">What your application history says about which applications get responses and interviews.</p>
      <InsightsClient />
    </main>
  );
}
