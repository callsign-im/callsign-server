import { describe, expect, it } from "vitest";
import { checkHandleFormat, formatHandle, normalizeHandle } from "../src/domain/handles.ts";
import { organizationDomain } from "../src/domain/identity.ts";
import { isAllowedRedirectUri } from "../src/domain/oauth.ts";
import { canonicalJson } from "../src/lib/crypto.ts";
import { uuidv7 } from "../src/lib/ids.ts";
import { isPublicAddress } from "../src/lib/safe-fetch.ts";

describe("handles", () => {
  it("normalizes user input", () => {
    expect(normalizeHandle("  @MateoRivasAgent ")).toBe("mateorivasagent");
    expect(formatHandle("mateorivasagent")).toBe("@mateorivasagent");
  });

  it("validates format and reserved names", () => {
    expect(checkHandleFormat("mateorivasagent")).toBe("available");
    expect(checkHandleFormat("ab")).toBe("invalid");
    expect(checkHandleFormat("mateo-rivas")).toBe("invalid");
    expect(checkHandleFormat("a".repeat(25))).toBe("invalid");
    expect(checkHandleFormat("support")).toBe("reserved");
  });
});

describe("canonicalJson", () => {
  it("is independent of key order and skips undefined values", () => {
    const a = canonicalJson({ b: 1, a: { d: [1, "x"], c: null }, e: undefined });
    const b = canonicalJson({ a: { c: null, d: [1, "x"] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
  });
});

describe("uuidv7", () => {
  it("produces RFC 9562 version 7 identifiers ordered by time", () => {
    const first = uuidv7(1_700_000_000_000);
    const second = uuidv7(1_700_000_000_001);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first < second).toBe(true);
  });
});

describe("isPublicAddress", () => {
  it("only accepts addresses on the public internet", () => {
    for (const address of ["8.8.8.8", "100.63.4.133", "2606:4700::1111"]) {
      expect(isPublicAddress(address)).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "fd00::1",
      "fe80::1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
  });
});

describe("isAllowedRedirectUri", () => {
  it("allows https, loopback http and app schemes", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:8000/callback")).toBe(true);
    expect(isAllowedRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://example.com/callback")).toBe(false);
    expect(isAllowedRedirectUri("https://example.com/callback#token")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("data:text/html,hi")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });
});

describe("organizationDomain", () => {
  it("ignores personal email providers", () => {
    expect(organizationDomain("tomas@majily.com")).toBe("majily.com");
    expect(organizationDomain("Tomas@Majily.COM")).toBe("majily.com");
    expect(organizationDomain("tomas@gmail.com")).toBeNull();
    expect(organizationDomain("tomas@outlook.com")).toBeNull();
  });
});
