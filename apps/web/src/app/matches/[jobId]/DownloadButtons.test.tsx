// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DownloadButtons, DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";

beforeEach(() => vi.unstubAllGlobals());

function mockPost(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("DownloadButtons", () => {
  it("POSTs the export, announces the change, then navigates to the download URL", async () => {
    const fetchMock = mockPost(201, { document: { downloadUrl: "/api/documents/d1/download" } });
    const navigate = vi.fn();
    const changed = vi.fn();
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, changed);
    render(<DownloadButtons jobId="j1" kind="resume" sourceId="o1" navigate={navigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/api/documents/d1/download"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/documents");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: "resume", jobId: "j1", sourceId: "o1", format: "pdf" });
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(DOCUMENTS_CHANGED_EVENT, changed);
  });

  it("sends format docx for the DOCX button", async () => {
    const fetchMock = mockPost(201, { document: { downloadUrl: "/x" } });
    render(<DownloadButtons jobId="j1" kind="pitch" sourceId="p1" navigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Download DOCX" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ kind: "pitch", format: "docx" });
  });

  it("shows the server's message on an error and does not navigate", async () => {
    mockPost(409, { error: "Your profile changed since this optimization. Regenerate it first." });
    const navigate = vi.fn();
    render(<DownloadButtons jobId="j1" kind="resume" sourceId="o1" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your profile changed since this optimization");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("disables both buttons when disabled", () => {
    render(<DownloadButtons jobId="j1" kind="pitch" sourceId="p1" disabled navigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download DOCX" })).toBeDisabled();
  });
});
