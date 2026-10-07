import { describe, it, expect } from "vitest";
import { Redactor } from "./redactor";

describe("Redactor", () => {
  it("replaces each known value case-insensitively", () => {
    const r = new Redactor();
    r.setValues(["Jane Doe", "+44 7700 900123"]);
    expect(r.redact("user JANE DOE called from +44 7700 900123 and jane doe again")).toBe(
      "user [REDACTED] called from [REDACTED] and [REDACTED] again"
    );
  });

  it("replaces the longest value first, so a full value wins over a value it contains", () => {
    const r = new Redactor();
    r.setValues(["Main", "12 Main Street"]);
    expect(r.redact("lives at 12 Main Street")).toBe("lives at [REDACTED]");
  });

  it("escapes regex metacharacters in values", () => {
    const r = new Redactor();
    r.setValues(["https://linkedin.com/in/jane.doe?x=(1)"]);
    expect(r.redact("profile https://linkedin.com/in/jane.doe?x=(1) end")).toBe("profile [REDACTED] end");
    expect(r.redact("profile https://linkedin.com/in/janeXdoe?x=(1) end")).toContain("janeXdoe");
  });

  it("trims values and ignores ones shorter than 3 characters", () => {
    const r = new Redactor();
    r.setValues(["  Jo  ", "", "  Ann  ", "a"]);
    expect(r.redact("Jo and Ann and a")).toBe("Jo and [REDACTED] and a");
  });

  it("always redacts email addresses, even with no known values", () => {
    const r = new Redactor();
    expect(r.redact("contact recruiter.name+tag@example.co.uk now")).toBe("contact [REDACTED_EMAIL] now");
  });

  it("redacts a known email as a known value before the generic pattern", () => {
    const r = new Redactor();
    r.setValues(["jane@example.com"]);
    expect(r.redact("from jane@example.com")).toBe("from [REDACTED]");
  });

  it("replaces the whole set on setValues", () => {
    const r = new Redactor();
    r.setValues(["Alice Smith"]);
    r.setValues(["Bob Jones"]);
    expect(r.redact("Alice Smith and Bob Jones")).toBe("Alice Smith and [REDACTED]");
  });

  it("leaves text without matches unchanged", () => {
    expect(new Redactor().redact("matching run 42 completed")).toBe("matching run 42 completed");
  });
});
