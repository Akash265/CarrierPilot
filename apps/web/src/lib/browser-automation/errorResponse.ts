import { NextResponse } from "next/server";
import { AutomationError } from "@ai-career/browser";

/** Maps a domain error class to its HTTP answer; null means "not ours, rethrow". */
export function automationErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof AutomationError)) return null;
  switch (error.errorClass) {
    case "job_not_found":
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    case "not_found":
      return NextResponse.json({ error: "Autofill session not found" }, { status: 404 });
    case "profile_missing":
      return NextResponse.json({ error: "Create your candidate profile first" }, { status: 409 });
    case "session_active":
      return NextResponse.json({ error: "An autofill session is already running. Finish or cancel it first." }, { status: 409 });
    case "not_cancellable":
      return NextResponse.json({ error: "This autofill session has already ended" }, { status: 409 });
    case "unsupported":
      return NextResponse.json({ error: "Autofill is not supported for this job", reason: error.detail }, { status: 422 });
  }
}
