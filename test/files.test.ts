import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../src/db/client.ts";
import { uploadFile } from "../src/domain/files.ts";
import { checkInbox, sendMessage } from "../src/domain/messaging.ts";
import { createApp } from "../src/http/app.ts";
import { createAgentWithToken, startServer } from "./helpers.ts";

const app = createApp();
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
});

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("files", () => {
  it("sends attachments that only the conversation can open", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    const carol = await createAgentWithToken("carol_agent");

    const uploaded = await app.request("/v1/agent/files", {
      method: "POST",
      headers: auth(alice.token),
      body: JSON.stringify({
        name: "budget.csv",
        mimeType: "text/csv",
        text: "item,cost\nads,500\n",
      }),
    });
    expect(uploaded.status).toBe(201);
    const file = (await uploaded.json()) as { id: string; size: number };
    expect(file.size).toBe(18);

    await sendMessage(alice.agent, {
      to: "@bob_agent",
      body: "Budget attached",
      attachments: [file.id],
    });
    const inbox = await checkInbox(bob.agent);
    expect(inbox.threads[0]?.messages[0]?.attachments).toEqual([
      { id: file.id, name: "budget.csv", mimeType: "text/csv", size: 18 },
    ]);

    const download = await app.request(`/v1/agent/files/${file.id}`, { headers: auth(bob.token) });
    expect(download.headers.get("content-disposition")).toContain("budget.csv");
    expect(await download.text()).toBe("item,cost\nads,500\n");
    const outsider = await app.request(`/v1/agent/files/${file.id}`, {
      headers: auth(carol.token),
    });
    expect(outsider.status).toBe(404);

    await expect(
      sendMessage(alice.agent, { to: "@carol_agent", body: "Again", attachments: [file.id] }),
    ).rejects.toThrow(/haven't been sent yet/);
    const [stored] = await sql<{ data: Buffer }[]>`select data from files where id = ${file.id}`;
    expect(stored?.data.toString("utf8")).not.toContain("ads,500");
  });

  it("refuses files that are too big or belong to someone else", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    await expect(
      uploadFile(alice.agent, { name: "big.bin", content: Buffer.alloc(5 * 1024 * 1024 + 1) }),
    ).rejects.toThrow(/limited to 5 MB/);
    const theirs = await uploadFile(bob.agent, { name: "notes.txt", content: Buffer.from("hi") });
    await expect(
      sendMessage(alice.agent, { to: "@bob_agent", body: "Stolen", attachments: [theirs.id] }),
    ).rejects.toThrow(/upload_file/);
  });

  it("uploads and opens files over MCP", async () => {
    const alice = await createAgentWithToken("alice_agent");
    const bob = await createAgentWithToken("bob_agent");
    const connect = async (token: string) => {
      const client = new Client({ name: "files-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    };
    const aliceClient = await connect(alice.token);
    const upload = await aliceClient.callTool({
      name: "upload_file",
      arguments: { name: "logo.png", mime_type: "image/png", base64: PNG.toString("base64") },
    });
    const { id } = upload.structuredContent as { id: string };
    await aliceClient.callTool({
      name: "send_message",
      arguments: { to: "@bob_agent", body: "New logo", attachments: [id] },
    });

    const bobClient = await connect(bob.token);
    const inbox = await bobClient.callTool({ name: "check_inbox", arguments: {} });
    const [text] = inbox.content as { text?: string }[];
    expect(text?.text).toContain(`logo.png (image/png, 1 KB, file ${id})`);
    const opened = await bobClient.callTool({ name: "get_file", arguments: { id } });
    expect(opened.content).toContainEqual({
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });
    await Promise.all([aliceClient.close(), bobClient.close()]);
  });
});
