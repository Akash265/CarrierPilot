import { describe, it, expect, vi } from "vitest";
import { warnIfExposed } from "./startupCheck";

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("warnIfExposed", () => {
  it("warns once at startup when the app listens beyond localhost without an access token", () => {
    const log = logger();
    warnIfExposed({ HOST: "0.0.0.0" }, log);
    expect(log.warn).toHaveBeenCalledWith("exposed_without_token", { host: "0.0.0.0" });
  });

  it("stays quiet on localhost or with a token", () => {
    const log = logger();
    warnIfExposed({ HOST: "127.0.0.1" }, log);
    warnIfExposed({ HOST: "0.0.0.0", APP_ACCESS_TOKEN: "x".repeat(32) }, log);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
