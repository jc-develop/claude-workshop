import { describe, it, expect } from "vitest";
import { isCrossSite } from "@/modules/auth/lib/same-origin";

const request = (headers: Record<string, string>) =>
  new Request("https://app.test/api/auth/email/send", { method: "POST", headers });

describe("isCrossSite", () => {
  it("lets a request from this app through", () => {
    expect(isCrossSite(request({ origin: "https://app.test", host: "app.test" }))).toBe(false);
  });

  it("catches a form posting from somewhere else", () => {
    expect(isCrossSite(request({ origin: "https://evil.example", host: "app.test" }))).toBe(true);
  });

  // A sibling host is still another site: cookies may be shared across a parent
  // domain, so "ends with our domain" is not the test.
  it("catches a lookalike subdomain", () => {
    expect(isCrossSite(request({ origin: "https://app.test.evil.example", host: "app.test" }))).toBe(true);
  });

  it("compares the port too", () => {
    expect(isCrossSite(request({ origin: "http://app.test:3001", host: "app.test:3000" }))).toBe(true);
  });

  it("ignores the scheme, which Host never carries", () => {
    expect(isCrossSite(request({ origin: "http://app.test", host: "app.test" }))).toBe(false);
  });

  // Non-browser callers and same-origin navigations omit it; SameSite cookies
  // are what cover that case, so refusing here would break more than it guards.
  it("allows a request with no Origin at all", () => {
    expect(isCrossSite(request({ host: "app.test" }))).toBe(false);
  });

  it("refuses an Origin that is not a URL", () => {
    expect(isCrossSite(request({ origin: "not a url", host: "app.test" }))).toBe(true);
  });
});
