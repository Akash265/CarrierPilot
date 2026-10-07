import Link from "next/link";
import { UsageClient } from "./UsageClient";

export default function UsagePage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-8">
      <Link href="/" className="text-sm underline">← Home</Link>
      <h1 className="text-2xl font-semibold">AI usage</h1>
      <p className="text-sm text-gray-600">Estimated spend on AI calls this month (UTC), against your monthly budget.</p>
      <UsageClient />
    </main>
  );
}
