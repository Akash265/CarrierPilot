"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { UsageSummary } from "../lib/aiUsage/summarizeUsage";
import { percentOfCeiling } from "../lib/aiUsage/format";

type Badge = { tone: "warn" | "over"; text: string } | null;

/**
 * The home page's link to /usage (Phase 11a design §9). Fetched in the browser because the home page is
 * prerendered: a server query would freeze build-time numbers into the page. The badge appears only at
 * "warn" or "over"; loading, errors, "ok" and "unlimited" show the plain link.
 */
export function AiUsageLink() {
  const [badge, setBadge] = useState<Badge>(null);

  useEffect(() => {
    let ignore = false;
    fetch("/api/usage")
      .then((res) => (res.ok ? (res.json() as Promise<UsageSummary>) : null))
      .then((data) => {
        if (ignore || !data || data.ceilingUsd === null) return;
        if (data.state === "over") setBadge({ tone: "over", text: "AI budget reached" });
        else if (data.state === "warn") setBadge({ tone: "warn", text: `${percentOfCeiling(data.spentUsd, data.ceilingUsd)}% of AI budget` });
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <span className="flex items-center gap-2">
      <Link href="/usage" className="underline">
        8. AI usage — estimated spend against your monthly budget
      </Link>
      {badge && (
        <span className={badge.tone === "over" ? "rounded bg-red-100 px-2 py-0.5 text-xs" : "rounded bg-amber-100 px-2 py-0.5 text-xs"}>
          {badge.text}
        </span>
      )}
    </span>
  );
}
