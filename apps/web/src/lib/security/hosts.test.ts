import { describe, it, expect } from "vitest";
import { hostnameOf, isLoopbackHostname, isExposedWithoutToken } from "./hosts";

describe("hostnameOf", () => {
  it("strips the port, keeps IPv6 brackets, lower-cases", () => {
    expect(hostnameOf("LocalHost:3000")).toBe("localhost");
    expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
    expect(hostnameOf("[::1]:3000")).toBe("[::1]");
    expect(hostnameOf("[::1]")).toBe("[::1]");
  });
});

describe("isLoopbackHostname", () => {
  it("accepts localhost, 127.0.0.1 and ::1 only", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "::1"]) expect(isLoopbackHostname(h)).toBe(true);
    for (const h of ["0.0.0.0", "192.168.1.2", "localhost.evil.com", "127.0.0.1.nip.io", ""]) expect(isLoopbackHostname(h)).toBe(false);
  });
});

describe("isExposedWithoutToken", () => {
  it("is true only when listening beyond loopback with no access token", () => {
    expect(isExposedWithoutToken({ APP_HOST: "127.0.0.1" })).toBe(false);
    expect(isExposedWithoutToken({ APP_HOST: "localhost" })).toBe(false);
    expect(isExposedWithoutToken({ APP_HOST: "0.0.0.0" })).toBe(true);
    expect(isExposedWithoutToken({ APP_HOST: "192.168.1.20" })).toBe(true);
    expect(isExposedWithoutToken({ APP_HOST: "0.0.0.0", APP_ACCESS_TOKEN: "x".repeat(32) })).toBe(false);
  });
});
