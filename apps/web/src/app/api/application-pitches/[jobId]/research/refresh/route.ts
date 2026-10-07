// apps/web/src/app/api/application-pitches/[jobId]/research/refresh/route.ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { AiBudgetExceededError, createAnthropicFor } from "@ai-career/ai";
import { ensureCompanyResearch, CompanyResearchRefreshFailedError } from "@ai-career/application-package";
import { toResearchView } from "../../../../../../lib/applicationPitch/serializePitch";
import { createUsageSink } from "../../../../../../lib/aiUsage/createUsageSink";
import { budgetExceededResponse } from "../../../../../../lib/aiUsage/budgetResponse";
import { withRouteErrors } from "../../../../../../lib/http/withRouteErrors";
import { withRateLimit } from "../../../../../../lib/http/rateLimit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { jobs } = schema;

async function handlePOST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const [job] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .select({ id: jobs.id, companyKey: jobs.companyKey, companyName: jobs.companyName, title: jobs.title })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
    );
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const anthropicFor = createAnthropicFor(env, createUsageSink(db, env));
    const research = await ensureCompanyResearch(db, env.DEFAULT_USER_ID, anthropicFor("company_research"), env, job, { forceRefresh: true });
    return NextResponse.json({ research: toResearchView(research) });
  } catch (error) {
    if (error instanceof AiBudgetExceededError) return budgetExceededResponse(error);
    if (error instanceof CompanyResearchRefreshFailedError) {
      return NextResponse.json({ error: "Research refresh failed; your existing research was kept." }, { status: 502 });
    }
    throw error;
  } finally {
    await closeDbClient(db);
  }
}

export const POST = withRouteErrors("/api/application-pitches/[jobId]/research/refresh", withRateLimit("ai", "/api/application-pitches/[jobId]/research/refresh", handlePOST));
