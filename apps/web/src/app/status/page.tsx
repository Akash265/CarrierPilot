import Link from "next/link";
import { StatusClient } from "./StatusClient";

export default function StatusPage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-8">
      <Link href="/" className="text-sm underline">← Home</Link>
      <h1 className="text-2xl font-semibold">System status</h1>
      <p className="text-sm text-gray-600">Whether the background workers are running, and what is waiting in their queues.</p>
      <StatusClient />
    </main>
  );
}
