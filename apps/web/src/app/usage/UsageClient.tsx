"use client";

import { useEffect, useState } from "react";
import type { UsageSummary } from "../../lib/aiUsage/summarizeUsage";
import { formatUsd, operationLabel, percentOfCeiling } from "../../lib/aiUsage/format";

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: UsageSummary };

const day = (iso: string) => iso.slice(0, 10);
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

function SpendSummary({ data }: { data: UsageSummary }) {
  if (data.ceilingUsd === null) {
    return <p className="text-2xl font-semibold">{`${formatUsd(data.spentUsd)} this month · no monthly ceiling`}</p>;
  }
  const percent = percentOfCeiling(data.spentUsd, data.ceilingUsd);
  const barColor = data.state === "over" ? "bg-red-600" : data.state === "warn" ? "bg-amber-500" : "bg-gray-800";
  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xl font-semibold">{`${formatUsd(data.spentUsd)} of ${formatUsd(data.ceilingUsd)} this month`}</p>
      <div
        role="progressbar"
        aria-label="Share of monthly AI budget used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(percent, 100)}
        className="h-2 w-full rounded bg-gray-200"
      >
        <div className={`h-2 rounded ${barColor}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      {data.state === "warn" && (
        <p className="rounded bg-amber-100 px-2 py-1 text-sm">{`Over ${data.warnPercent}% of your monthly AI budget.`}</p>
      )}
      {data.state === "over" && (
        <p role="alert" className="rounded bg-red-100 px-2 py-1 text-sm">
          {`Monthly AI budget reached. New AI calls are blocked until ${day(data.month.resetsAt)} (UTC) or until AI_MONTHLY_BUDGET_USD is raised.`}
        </p>
      )}
    </div>
  );
}

export function UsageClient() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let ignore = false;
    fetch("/api/usage")
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json() as Promise<UsageSummary>;
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

  if (state.kind === "loading") return <p className="text-sm text-gray-600">Loading…</p>;
  if (state.kind === "error") return <p className="text-sm text-red-700">Could not load AI usage.</p>;
  const { data } = state;

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Monthly spend" className="flex flex-col gap-1 rounded border p-4">
        <SpendSummary data={data} />
        <p className="text-sm text-gray-600">{`Resets ${day(data.month.resetsAt)} (UTC).`}</p>
      </section>

      {data.unknownPriceModels.length > 0 && (
        <p className="rounded bg-amber-100 px-2 py-1 text-sm">
          {`No price is configured for ${data.unknownPriceModels.join(", ")}; its cost is estimated at the most expensive known rate.`}
        </p>
      )}

      {data.usageEstimatedCalls > 0 && (
        <p className="rounded bg-amber-100 px-2 py-1 text-sm">
          {`${data.usageEstimatedCalls} ${data.usageEstimatedCalls === 1 ? "call" : "calls"} did not report token usage; their cost is estimated from the request size.`}
        </p>
      )}

      {data.byOperation.length === 0 ? (
        <p className="text-sm text-gray-600">No AI calls yet this month.</p>
      ) : (
        <>
          <table aria-label="By feature" className="text-sm">
            <thead>
              <tr className="text-left">
                <th className="pr-4">Feature</th>
                <th className="pr-4">Calls</th>
                <th className="pr-4">Blocked</th>
                <th className="pr-4">Failed</th>
                <th className="pr-4">Tokens in</th>
                <th className="pr-4">Tokens out</th>
                <th className="pr-4">Web searches</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.byOperation.map((op) => (
                <tr key={op.operation} className="border-t">
                  <td className="py-1 pr-4">{operationLabel(op.operation)}</td>
                  <td className="pr-4">{op.calls}</td>
                  <td className="pr-4">{op.blocked}</td>
                  <td className="pr-4">{op.failed}</td>
                  <td className="pr-4">{op.inputTokens.toLocaleString("en-US")}</td>
                  <td className="pr-4">{op.outputTokens.toLocaleString("en-US")}</td>
                  <td className="pr-4">{op.webSearches}</td>
                  <td>{formatUsd(op.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.byModel.length > 0 && (
            <table aria-label="By model" className="text-sm">
              <thead>
                <tr className="text-left">
                  <th className="pr-4">Model</th>
                  <th className="pr-4">Calls</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((m) => (
                  <tr key={m.model} className="border-t">
                    <td className="py-1 pr-4">{m.model}</td>
                    <td className="pr-4">{m.calls}</td>
                    <td>{formatUsd(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {data.recentFailures.length > 0 && (
        <table aria-label="Recent failed and blocked calls" className="text-sm">
          <thead>
            <tr className="text-left">
              <th className="pr-4">When (UTC)</th>
              <th className="pr-4">Feature</th>
              <th className="pr-4">Model</th>
              <th className="pr-4">Outcome</th>
              <th>Code</th>
            </tr>
          </thead>
          <tbody>
            {data.recentFailures.map((f, i) => (
              <tr key={`${f.createdAt}-${i}`} className="border-t">
                <td className="py-1 pr-4">{when(f.createdAt)}</td>
                <td className="pr-4">{operationLabel(f.operation)}</td>
                <td className="pr-4">{f.model}</td>
                <td className="pr-4">{f.outcome === "blocked" ? "Blocked" : "Failed"}</td>
                <td>{f.errorCode ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="text-xs text-gray-500">Costs are estimates from a built-in price table, not your Anthropic or Voyage invoice.</p>
    </div>
  );
}
