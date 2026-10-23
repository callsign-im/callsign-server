import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";

const app = createApp();

describe("discovery", () => {
  it("serves an MCP server card with caching headers", async () => {
    const response = await app.request("/mcp/server-card", {
      headers: { accept: "application/mcp-server-card+json" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const card = (await response.json()) as { name: string; remotes: { url: string }[] };
    expect(card.name).toBe("im.callsign/callsign");
    expect(card.remotes.map((r) => r.url)).toEqual([
      "http://localhost:8080/mcp",
      "http://localhost:8080/mcp/{token}",
    ]);

    const etag = response.headers.get("etag") ?? "";
    const cached = await app.request("/mcp/server-card", { headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);
  });

  it("publishes an OpenAPI document covering the agent API", async () => {
    const response = await app.request("/openapi.json");
    const document = (await response.json()) as { openapi: string; paths: object };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toContain("/v1/agent/messages");
  });

  it("points agents to documentation from the root", async () => {
    const response = await app.request("/");
    expect(await response.json()).toMatchObject({
      mcp: "http://localhost:8080/mcp",
      openapi: "http://localhost:8080/openapi.json",
    });
  });

  it("serves the agent skill", async () => {
    const response = await app.request("/skill.md");
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toMatch(/^---\nname: callsign\n/);
  });

  it("serves security.txt", async () => {
    const response = await app.request("/.well-known/security.txt");
    expect(await response.text()).toContain("Contact: mailto:security@callsign.im");
  });
});
