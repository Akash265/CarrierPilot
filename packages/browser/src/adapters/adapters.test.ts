import { describe, it, expect } from "vitest";
import { greenhouseV1, leverV1, getAdapter } from "./index";

describe("adapters", () => {
  it("build canonical hosted form URLs", () => {
    expect(greenhouseV1.buildFormUrl({ slug: "acme", externalId: "1234567" })).toBe("https://job-boards.greenhouse.io/acme/jobs/1234567");
    expect(leverV1.buildFormUrl({ slug: "acme", externalId: "6ed76ce8-4156" })).toBe("https://jobs.lever.co/acme/6ed76ce8-4156/apply");
  });

  it("are looked up by portal and carry versions", () => {
    expect(getAdapter("greenhouse")).toBe(greenhouseV1);
    expect(getAdapter("lever")).toBe(leverV1);
    expect(greenhouseV1.version).toBe("greenhouse-v1");
    expect(leverV1.version).toBe("lever-v1");
  });

  it("only allow their own hosts", () => {
    expect(greenhouseV1.allowedHosts).toEqual(["job-boards.greenhouse.io", "boards.greenhouse.io"]);
    expect(leverV1.allowedHosts).toEqual(["jobs.lever.co"]);
  });
});
