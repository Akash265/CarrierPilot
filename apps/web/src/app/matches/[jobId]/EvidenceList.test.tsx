// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EvidenceList } from "./EvidenceList";

describe("EvidenceList", () => {
  it("renders nothing for no evidence", () => {
    const { container } = render(<EvidenceList evidence={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels each item and links only http(s) sources with safe attributes", () => {
    render(<EvidenceList evidence={[
      { id: "r:1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" },
      { id: "r:2", kind: "research", text: "Sneaky.", sourceUrl: "javascript:alert(1)" },
      { id: "p:1", kind: "profile", text: "Built SQL", sourceUrl: null },
    ]} />);
    expect(screen.getByText("Evidence (3)")).toBeInTheDocument();
    expect(screen.getByText(/Your profile: Built SQL/)).toBeInTheDocument();
    const links = screen.getAllByRole("link", { hidden: true });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });
});
