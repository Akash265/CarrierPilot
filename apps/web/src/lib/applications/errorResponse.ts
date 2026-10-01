import { NextResponse } from "next/server";
import { ApplicationError } from "@ai-career/applications";

/** Maps a domain error class to its HTTP answer; null means "not ours, rethrow". */
export function applicationErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof ApplicationError)) return null;
  switch (error.errorClass) {
    case "job_not_found":
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    case "not_found":
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    case "already_applied":
      return NextResponse.json({ error: "You already have an application for this job" }, { status: 409 });
    case "same_status":
      return NextResponse.json({ error: "The application already has this status" }, { status: 409 });
    case "document_mismatch":
      return NextResponse.json({ error: "A selected document does not belong to this job" }, { status: 422 });
  }
}
