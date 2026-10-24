import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.ts";
import { jobs, type Agent } from "../src/db/schema.ts";
import { updateAgent } from "../src/domain/agents.ts";
import { followUpTime, scheduleFollowUp } from "../src/domain/follow-ups.ts";
import { createGroup, respondToGroupInvite } from "../src/domain/groups.ts";
import { checkInbox, sendMessage, waitForInbox } from "../src/domain/messaging.ts";
import { listNotifications, unreadCount } from "../src/domain/notifications.ts";
import { addTasks, createPlan, getPlan, updateTask } from "../src/domain/plans.ts";
import { wakeFields } from "../src/domain/wake.ts";
import { processDueJobs } from "../src/jobs/runner.ts";
import { createAgentWithToken } from "./helpers.ts";

const receivers: { close: () => void }[] = [];

afterEach(() => {
  for (const receiver of receivers.splice(0)) receiver.close();
});

async function receiver() {
  const received: string[] = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  receivers.push(http);
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/hook`, received };
}

async function drainJobs() {
  while ((await processDueJobs()) > 0);
}

async function partners(): Promise<{ alice: Agent; bob: Agent }> {
  const { agent: alice } = await createAgentWithToken("alice_agent");
  const { agent: bob } = await createAgentWithToken("bob_agent");
  await sendMessage(alice, { to: "@bob_agent", body: "Let's plan the launch." });
  await sendMessage(bob, { to: "@alice_agent", body: "Sure." });
  await checkInbox(alice);
  await checkInbox(bob);
  return { alice, bob };
}

const launch = [
  { key: "post", title: "Write the post" },
  { key: "ads", title: "Set up the ads", assignee: "@bob_agent", dependsOn: ["post"] },
  { key: "go", title: "Publish everything", dependsOn: ["ads"] },
];

describe("plans", () => {
  it("shares a plan and tells the other agent about its tasks", async () => {
    const { alice, bob } = await partners();
    const plan = await createPlan(alice, { with: "@bob_agent", title: "Launch", tasks: launch });

    expect(plan).toMatchObject({ title: "Launch", with: "@bob_agent", createdBy: "@alice_agent" });
    expect(plan.progress).toEqual({ done: 0, total: 3 });
    expect(plan.tasks.map((t) => [t.key, t.assignee, t.ready, t.waitingOn])).toEqual([
      ["post", "@alice_agent", true, []],
      ["ads", "@bob_agent", false, ["post"]],
      ["go", "@alice_agent", false, ["ads"]],
    ]);

    expect(await unreadCount(bob.id)).toBe(1);
    const inbox = await checkInbox(bob);
    expect(inbox.notices).toHaveLength(1);
    expect(inbox.notices[0]).toMatchObject({ kind: "plan.shared", from: "@alice_agent" });
    expect(inbox.notices[0]?.text).toContain(`"ads" Set up the ads (waiting on "post")`);
    expect((await checkInbox(bob)).notices).toHaveLength(0);
  });

  it("wakes the next assignee when the task it waits on is done", async () => {
    const { alice, bob } = await partners();
    const plan = await createPlan(alice, { with: "@bob_agent", title: "Launch", tasks: launch });
    await checkInbox(bob);

    const updated = await updateTask(alice, plan.id, "post", {
      status: "done",
      note: "It's in the shared doc",
    });
    expect(updated.tasks.find((t) => t.key === "ads")).toMatchObject({
      ready: true,
      waitingOn: [],
    });

    const inbox = await checkInbox(bob);
    expect(inbox.notices.map((n) => n.kind)).toEqual(["task.ready"]);
    expect(inbox.notices[0]?.text).toContain(`Your task "ads" Set up the ads in "Launch"`);
    expect(inbox.notices[0]?.text).toContain(
      `finished "post" Write the post: "It's in the shared doc"`,
    );

    await updateTask(bob, plan.id, "ads", { status: "in_progress" });
    const aliceInbox = await checkInbox(alice);
    expect(aliceInbox.notices.map((n) => n.text)).toEqual([
      expect.stringContaining(`@bob_agent started "ads" Set up the ads`),
    ]);
  });

  it("only lets the assignee or the creator change a task", async () => {
    const { alice, bob } = await partners();
    const plan = await createPlan(alice, { with: "@bob_agent", title: "Launch", tasks: launch });

    await expect(updateTask(bob, plan.id, "post", { status: "done" })).rejects.toThrow(
      /assignee or the plan's creator/,
    );
    await expect(updateTask(bob, plan.id, "ads", { assignee: "@alice_agent" })).rejects.toThrow(
      /creator can reassign/,
    );
    const reassigned = await updateTask(alice, plan.id, "go", { assignee: "@bob_agent" });
    expect(reassigned.tasks.find((t) => t.key === "go")?.assignee).toBe("@bob_agent");
    await expect(updateTask(alice, plan.id, "post", {})).rejects.toThrow(/Change the status/);
  });

  it("rejects plans that don't add up", async () => {
    const { alice } = await partners();
    const { agent: carol } = await createAgentWithToken("carol_agent");
    const share = (tasks: Parameters<typeof createPlan>[1]["tasks"]) =>
      createPlan(alice, { with: "@bob_agent", title: "Bad", tasks });

    await expect(share([{ key: "a", title: "A", dependsOn: ["b"] }])).rejects.toThrow(
      /isn't in the plan/,
    );
    await expect(
      share([
        { key: "a", title: "A", dependsOn: ["b"] },
        { key: "b", title: "B", dependsOn: ["a"] },
      ]),
    ).rejects.toThrow(/loop/);
    await expect(share([{ title: "A", assignee: "@carol_agent" }])).rejects.toThrow(
      /isn't in this conversation/,
    );
    await expect(
      createPlan(carol, { with: "@alice_agent", title: "Hi", tasks: [{ title: "A" }] }),
    ).rejects.toThrow(/Message @alice_agent first/);
  });

  it("only notifies assignees in a group, and new assignees when tasks are added", async () => {
    const { agent: alice } = await createAgentWithToken("alice_agent");
    const { agent: bob } = await createAgentWithToken("bob_agent");
    const { agent: carol } = await createAgentWithToken("carol_agent");
    await createGroup(alice, { name: "launch", members: ["@bob_agent", "@carol_agent"] });
    await respondToGroupInvite(bob, "#launch", "accept", "agent");
    await respondToGroupInvite(carol, "#launch", "accept", "agent");
    await checkInbox(bob);
    await checkInbox(carol);

    const plan = await createPlan(alice, {
      with: "#launch",
      title: "Launch",
      tasks: [{ key: "ads", title: "Ads", assignee: "@bob_agent" }],
    });
    expect(plan.group).toBe("#launch");
    expect((await checkInbox(bob)).notices).toHaveLength(1);
    expect((await checkInbox(carol)).notices).toHaveLength(0);

    await addTasks(bob, plan.id, [
      { key: "copy", title: "Copy", assignee: "@carol_agent", dependsOn: ["ads"] },
    ]);
    const carolInbox = await checkInbox(carol);
    expect(carolInbox.notices[0]).toMatchObject({ kind: "task.assigned", from: "@bob_agent" });
    expect((await getPlan(carol, plan.id)).tasks).toHaveLength(2);
  });

  it("reminds the assignee and the creator when a task is overdue", async () => {
    const { alice, bob } = await partners();
    const plan = await createPlan(alice, {
      with: "@bob_agent",
      title: "Launch",
      tasks: [{ key: "ads", title: "Ads", assignee: "@bob_agent", due: "2020-01-01" }],
    });
    await checkInbox(alice);
    await checkInbox(bob);
    await drainJobs();

    expect((await checkInbox(bob)).notices[0]).toMatchObject({ kind: "task.overdue" });
    expect((await checkInbox(alice)).notices[0]?.text).toContain("@bob_agent's task");
    expect((await getPlan(alice, plan.id)).tasks[0]?.overdue).toBe(true);

    await updateTask(bob, plan.id, "ads", { status: "done" });
    await drainJobs();
    expect((await checkInbox(alice)).notices.map((n) => n.kind)).toEqual(["task.updated"]);
  });

  it("wakes the agent up for plan updates, without their contents", async () => {
    const { alice, bob } = await partners();
    const hook = await receiver();
    await updateAgent(bob, { wake: await wakeFields(bob, { kind: "webhook", url: hook.url }) });

    const before = await listNotifications(bob, undefined);
    await createPlan(alice, { with: "@bob_agent", title: "Secret launch", tasks: launch });
    await drainJobs();

    expect(hook.received).toHaveLength(1);
    expect(JSON.parse(hook.received[0] ?? "{}")).toMatchObject({
      type: "notice.received",
      notice: "plan.shared",
      from: "@alice_agent",
    });
    expect(hook.received[0]).not.toContain("Secret");
    const feed = await listNotifications(bob, before.cursor);
    expect(feed.notifications).toEqual([
      expect.objectContaining({ type: "notice.received", notice: "plan.shared" }),
    ]);
  });
});

describe("follow-ups", () => {
  it("parses delays and refuses unreasonable ones", () => {
    const now = Date.now();
    expect(followUpTime({ in: "2d" }).getTime()).toBeGreaterThan(now + 2 * 86_400_000 - 5000);
    expect(followUpTime({ in: "45 min" }).getTime()).toBeGreaterThan(now + 44 * 60_000);
    expect(() => followUpTime({ in: "soon" })).toThrow(/isn't a delay/);
    expect(() => followUpTime({ in: "60d" })).toThrow(/30 days/);
    expect(() => followUpTime({})).toThrow(/Say when/);
  });

  it("wakes the agent with its own note when the time comes", async () => {
    const { alice } = await partners();
    const followUp = await scheduleFollowUp(alice, {
      in: "2h",
      note: "Check whether Bob confirmed the budget",
      about: "@bob_agent",
    });
    expect(followUp.about).toBe("@bob_agent");
    await drainJobs();
    expect((await checkInbox(alice)).notices).toHaveLength(0);

    await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.kind, "follow_up.due"));
    const waiting = waitForInbox(alice, 5);
    await drainJobs();
    const inbox = await waiting;
    expect(inbox.notices).toEqual([
      expect.objectContaining({
        kind: "follow_up",
        from: null,
        text: `Follow-up you scheduled about @bob_agent: "Check whether Bob confirmed the budget"`,
      }),
    ]);
  });
});
