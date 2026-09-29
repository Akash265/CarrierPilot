// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { DocumentsList } from "./DocumentsList";
import { DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";

const doc = { id: "d1", kind: "resume", format: "pdf", sourceVersion: 3, downloadFilename: "Jane - Acme - Resume.pdf",
  byteSize: 1000, createdAt: "2026-09-24T00:00:00Z", downloadUrl: "/api/documents/d1/download" };

beforeEach(() => vi.unstubAllGlobals());

describe("DocumentsList", () => {
  it("shows an empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ documents: [] }) } as Response));
    render(<DocumentsList jobId="j1" />);
    expect(await screen.findByText(/no documents exported yet/i)).toBeInTheDocument();
  });

  it("lists documents with kind, version, format and a download link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ documents: [doc] }) } as Response));
    render(<DocumentsList jobId="j1" />);
    expect(await screen.findByText(/Resume v3 · PDF/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute("href", "/api/documents/d1/download");
  });

  it("reloads when a documents-changed event fires", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [doc] }) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsList jobId="j1" />);
    await screen.findByText(/no documents exported yet/i);
    act(() => { window.dispatchEvent(new Event(DOCUMENTS_CHANGED_EVENT)); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Resume v3 · PDF/)).toBeInTheDocument();
  });
});
