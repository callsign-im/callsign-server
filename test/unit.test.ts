import { describe, expect, it } from "vitest";
import { checkHandleFormat, formatHandle, normalizeHandle } from "../src/domain/handles.ts";
import { canonicalJson } from "../src/lib/crypto.ts";
import { uuidv7 } from "../src/lib/ids.ts";

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
