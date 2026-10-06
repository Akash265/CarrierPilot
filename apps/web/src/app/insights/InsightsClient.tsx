"use client";

import { useEffect, useState } from "react";
import type { Bucket, Dimension, Headline, Insights, Patterns, Tier } from "@ai-career/insights";

export type InsightsResponse = Insights & { settings: { undecidedDays: number; minBucket: number } };
type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: InsightsResponse };

const TIER_TITLE: Record<Tier, string> = { response: "Got a response", interview: "Got an interview" };
const TIER_BUTTON: Record<Tier, string> = { response: "Response", interview: "Interview" };
const TIER_NOUN: Record<Tier, string> = { response: "a response", interview: "an interview" };
const CAVEAT = "With this many comparisons, some differences appear by chance. Flags mark things worth a look, not conclusions.";
const pct = (value: number): string => `${Math.round(value * 100)}%`;

function HeadlineCard({ tier, headline }: { tier: Tier; headline: Headline }) {
  return (
    <section aria-label={TIER_TITLE[tier]} className="flex flex-col gap-1 rounded border p-4">
      <h2 className="font-medium">{TIER_TITLE[tier]}</h2>
      {headline.rate !== null && headline.interval !== null ? (
        <>
          <p className="text-2xl font-semibold">{`${pct(headline.rate)} (${headline.positives} of ${headline.decided})`}</p>
          <p className="text-sm text-gray-600">{`Likely between ${pct(headline.interval.low)} and ${pct(headline.interval.high)}.`}</p>
        </>
      ) : (
        <p className="text-sm text-gray-600">{`${headline.positives} of ${headline.decided} decided. Not enough data for a rate yet.`}</p>
      )}
      <p className="text-sm text-gray-600">{`${headline.undecided} still waiting · ${headline.excluded} withdrawn (not counted)`}</p>
    </section>
  );
}

function BucketRow({ bucket }: { bucket: Bucket }) {
  return (
    <tr className="border-t">
      <td className="py-1 pr-4">{bucket.label}</td>
      <td className="pr-4">{bucket.decided}</td>
      <td className="pr-4">{bucket.positives}</td>
      <td className="pr-4">
        {bucket.rate !== null && bucket.interval !== null ? (
          <div className="flex items-center gap-2">
            <span>{`${pct(bucket.rate)} (${Math.round(bucket.interval.low * 100)}–${pct(bucket.interval.high)})`}</span>
            <span aria-hidden="true" className="inline-block h-2 bg-gray-800" style={{ width: `${Math.round(bucket.rate * 80)}px` }} />
          </div>
        ) : (
          <span className="text-gray-500">Not enough data</span>
        )}
      </td>
      <td>
        {bucket.standsOut && (
          <span className={bucket.standsOut === "higher" ? "rounded bg-green-100 px-2 py-0.5 text-xs" : "rounded bg-red-100 px-2 py-0.5 text-xs"}>
            {`${bucket.standsOut === "higher" ? "Higher" : "Lower"} than your overall rate (n=${bucket.decided})`}
          </span>
        )}
      </td>
    </tr>
  );
}

function DimensionTable({ dimension }: { dimension: Dimension }) {
  return (
    <details open className="rounded border p-3">
      <summary className="cursor-pointer font-medium">{dimension.title}</summary>
      {dimension.buckets.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600">No applications in this group yet.</p>
      ) : (
        <table aria-label={dimension.title} className="mt-2 w-full text-left text-sm">
          <thead>
            <tr>
              <th className="pr-4 font-medium">Group</th>
              <th className="pr-4 font-medium">Decided</th>
              <th className="pr-4 font-medium">Yes</th>
              <th className="pr-4 font-medium">Rate (likely range)</th>
              <th className="font-medium" />
            </tr>
          </thead>
          <tbody>
            {dimension.buckets.map((bucket) => <BucketRow key={bucket.key} bucket={bucket} />)}
          </tbody>
        </table>
      )}
      {dimension.unknownCount > 0 && (
        <p className="mt-2 text-xs text-gray-500">{`${dimension.unknownCount} applications have no data for this.`}</p>
      )}
    </details>
  );
}

function PatternsSection({ patterns }: { patterns: Patterns }) {
  const noun = TIER_NOUN[patterns.tier];
  const high = patterns.highCoverage;
  return (
    <section aria-labelledby="patterns-heading" className="flex flex-col gap-2">
      <h2 id="patterns-heading" className="text-lg font-medium">Rejection patterns</h2>
      <p className="text-sm text-gray-600">{`Based on whether you got ${noun}.`}</p>
      {patterns.missedTerms.length === 0 ? (
        patterns.negativesWithData === 0 ? (
          <p className="text-sm">
            {`Missed requirements are recorded for applications sent with an optimized resume. None of your applications without ${noun} have this data yet.`}
          </p>
        ) : (
          <p className="text-sm">{`No requirement was missed in two or more applications without ${noun}.`}</p>
        )
      ) : (
        <ul className="list-disc pl-5 text-sm">
          {patterns.missedTerms.map((t) => (
            <li key={t.term}>
              {`${t.term}: missed in ${t.missedInNegatives} of ${t.negativesWithData} applications without ${noun}, and ${t.missedInPositives} of ${t.positivesWithData} with one.`}
            </li>
          ))}
        </ul>
      )}
      {high ? (
        <p className="text-sm">
          {`With 80%+ required keyword coverage: ${pct(high.rate)} (${high.positives} of ${high.decided}) got ${noun}, likely between ${pct(high.interval.low)} and ${pct(high.interval.high)}${high.standsOut ? `, ${high.standsOut === "higher" ? "higher" : "lower"} than your overall rate (n=${high.decided})` : ""}.`}
        </p>
      ) : (
        <p className="text-sm text-gray-600">Not enough applications with 80%+ required keyword coverage yet.</p>
      )}
    </section>
  );
}

function HowCalculated({ settings }: { settings: InsightsResponse["settings"] }) {
  return (
    <details className="rounded border p-3 text-sm">
      <summary className="cursor-pointer font-medium">How this is calculated</summary>
      <ul className="mt-2 list-disc pl-5">
        <li>An application got a response if it ever reached screening or later, or you logged a recruiter contact or an interview.</li>
        <li>It got an interview if it ever reached interviewing or later, or you logged an interview. An offer counts as both.</li>
        <li>{`An open application counts as "no" after ${settings.undecidedDays} days without activity, and turns back to "yes" if a response arrives later.`}</li>
        <li>Withdrawn applications are not counted, unless they had already got a response or interview.</li>
        <li>Role family is the career-goal target role the job title matches best; titles that match none are grouped as Other.</li>
        <li>{`A group shows a rate only with at least ${settings.minBucket} decided applications. The likely range is a 95% confidence interval.`}</li>
        {/* Worded differently from CAVEAT on purpose: the exact caveat sentence appears once, above the tables. */}
        <li>Some differences appear by chance; flags mark things worth a look, not conclusions.</li>
      </ul>
    </details>
  );
}

/** Phase 10a spec §7.2. Read-only: everything is computed by GET /api/insights. */
export function InsightsClient() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [tier, setTier] = useState<Tier>("response");

  useEffect(() => {
    let ignore = false;
    fetch("/api/insights")
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json() as Promise<InsightsResponse>;
      })
      .then((data) => {
        if (!ignore) setState({ kind: "ready", data });
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, []);

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "error") return <p role="alert" className="text-red-600">Could not load insights. Try again.</p>;

  const { data } = state;
  const response = data.tiers.response;
  return (
    <div className="flex flex-col gap-6">
      {response.decided < data.settings.minBucket && (
        <p role="status" className="rounded border border-yellow-300 bg-yellow-50 p-3 text-sm">
          {`Insights appear after ${data.settings.minBucket} decided applications. You have ${response.decided} (${response.undecided} still waiting).`}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <HeadlineCard tier="response" headline={data.tiers.response} />
        <HeadlineCard tier="interview" headline={data.tiers.interview} />
      </div>

      <section aria-labelledby="breakdowns-heading" className="flex flex-col gap-3">
        <h2 id="breakdowns-heading" className="text-lg font-medium">Breakdowns</h2>
        <div role="group" aria-label="Outcome" className="flex gap-2">
          {(["response", "interview"] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tier === t}
              onClick={() => setTier(t)}
              className={tier === t ? "rounded bg-black px-3 py-1 text-sm text-white" : "rounded border px-3 py-1 text-sm"}
            >
              {TIER_BUTTON[t]}
            </button>
          ))}
        </div>
        <p className="text-sm text-gray-600">{CAVEAT}</p>
        {data.breakdowns[tier].map((dimension) => <DimensionTable key={dimension.key} dimension={dimension} />)}
      </section>

      <PatternsSection patterns={data.patterns} />
      <HowCalculated settings={data.settings} />
    </div>
  );
}
