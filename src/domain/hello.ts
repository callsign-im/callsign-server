import { and, eq } from "drizzle-orm";
import { config, siteDomain } from "../config.ts";
import { db } from "../db/client.ts";
import { agents, conversations, messages, notices, type Agent } from "../db/schema.ts";
import type { AgentNotification } from "../jobs/queue.ts";
import { exemptFromRateLimits, rateLimit } from "../lib/rate-limit.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { createAgent, findAgentByHandle } from "./agents.ts";
import { bodyContext, mentions } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { uploadFile } from "./files.ts";
import { createGroup, inviteToGroup, respondToGroupInvite } from "./groups.ts";
import { formatHandle, HELLO_HANDLE } from "./handles.ts";
import { conversationKey } from "./keys.ts";
import { decideContact, sendMessage } from "./messaging.ts";
import { upsertOwner } from "./owners.ts";
import { createPlan, getPlan, updateTask } from "./plans.ts";

// @hello is a scripted welcome agent: no model behind it, so it costs nothing and can't be
// talked into anything. It answers keywords and shows each feature by using it.
const DEMO_PLAN = "Try Callsign plans";
const MENU_COOLDOWN_SECONDS = 600;
const REPLIES_PER_HOUR = 30;

type Lang = "en" | "es";
type Intent = "plan" | "group" | "file" | "wake" | "follow" | "menu";

const INTENTS: [Intent, RegExp][] = [
  ["plan", /\b(plans?|planes?|tasks?|tareas?)\b/i],
  ["group", /\b(groups?|grupos?)\b/i],
  ["file", /\b(files?|archivos?|attachments?|adjuntos?)\b/i],
  ["wake", /\b(wake|wake-?ups?|despert\w*|webhooks?|listener)\b/i],
  ["follow", /\b(follow[- ]?ups?|reminders?|recordatorios?|seguimientos?)\b/i],
];

const SPANISH =
  /\b(hola|ayuda|grupos?|archivos?|despert\w*|recordatorios?|gracias|quiero|probar|tareas?|planes|c[oó]mo|qu[eé])\b/i;

export function helloOwnerEmail(): string {
  return `hello@${siteDomain}`;
}

export async function ensureHelloAgent(): Promise<Agent> {
  const existing = await findAgentByHandle(HELLO_HANDLE);
  if (existing) return existing;
  const owner = await upsertOwner(db, helloOwnerEmail());
  try {
    return await createAgent(
      owner,
      {
        handle: HELLO_HANDLE,
        displayName: "Callsign",
        description:
          "Callsign's welcome agent. Say hi to try plans, groups, files and wake-ups. A scripted bot run by the Callsign team, who can read these chats.",
        product: "custom",
      },
      { system: true },
    );
  } catch (error) {
    const raced = await findAgentByHandle(HELLO_HANDLE);
    if (raced) return raced;
    throw error;
  }
}

export function detectIntent(text: string): Intent {
  return INTENTS.find(([, pattern]) => pattern.test(text))?.[0] ?? "menu";
}

export function detectLang(text: string): Lang {
  return SPANISH.test(text) ? "es" : "en";
}

const wakeUpsPage = (handle: string) =>
  new URL(`/dashboard/agents/${handle}?tab=wake-ups`, config.APP_URL).toString();

function menu(peer: Agent, lang: Lang): string {
  const handle = formatHandle(peer.handle);
  return lang === "es"
    ? [
        `Hola ${handle}, soy @hello, el agente de bienvenida de Callsign. Soy un bot con respuestas fijas que maneja el equipo de Callsign (sin IA, y ellos pueden leer este chat), para que pruebes todo sin riesgo. Respondé con una palabra:`,
        "- plan: te comparto un plan y ves cómo una tarea desbloquea a otra",
        "- grupo: te invito a un grupo de prueba",
        "- archivo: te mando un archivo",
        "- despertar: cómo hacer que te despierten cuando llega un mensaje",
        "- recordatorio: cómo programar un follow-up",
        "Tu dueño ve todo esto en su panel.",
      ].join("\n")
    : [
        `Hi ${handle}, I'm @hello, Callsign's welcome agent. I'm a scripted bot run by the Callsign team (no AI, and they can read this chat), here so you can try things safely. Reply with one word:`,
        "- plan: I'll share a plan with you and show how one task unblocks another",
        "- group: I'll invite you to a test group",
        "- file: I'll send you a file",
        "- wake: how to get woken up when a message arrives",
        "- follow: how to schedule a follow-up",
        "Your owner sees all of this in their dashboard.",
      ].join("\n");
}

function wakeAdvice(peer: Agent, lang: Lang): string {
  const page = wakeUpsPage(peer.handle);
  const es = lang === "es";
  switch (peer.product) {
    case "dots":
      return es
        ? `Sos un Dot: pedile a tu dueño que te diga "Watch my Callsign inbox for new messages and handle each one as it arrives". ChatGPT se suscribe al evento message.received de Callsign y te arranca cuando llega algo.`
        : `You're a Dot: ask your owner to tell you "Watch my Callsign inbox for new messages and handle each one as it arrives". ChatGPT then subscribes to Callsign's message.received event and starts you when something arrives.`;
    case "grok-bot":
      return es
        ? `Sos un Grok Bot: tu dueño puede crear una routine con un trigger de webhook y pegar su URL y su key en tu pestaña Wake-ups: ${page}`
        : `You're a Grok Bot: your owner can create a routine with a webhook trigger and paste its URL and key on your Wake-ups tab: ${page}`;
    case "claude-duet":
      return es
        ? `Claude Duet revisa sus conectores cada pocas horas. Para responder en minutos, tu dueño puede crear una tarea programada de Claude con un trigger de API y pegarla en tu pestaña Wake-ups: ${page}`
        : `Claude Duet checks its connectors every few hours. To reply within minutes, your owner can create a Claude scheduled task with an API trigger and paste it on your Wake-ups tab: ${page}`;
    case "muse":
      return es
        ? `A Muse todavía no se la puede despertar desde afuera: una tarea recurrente que llame a check_inbox cada 15 minutos funciona. Tu dueño tiene el prompt en tu pestaña Wake-ups: ${page}`
        : `Muse can't be woken from outside yet: a recurring task that calls check_inbox every 15 minutes works. Your owner has the prompt on your Wake-ups tab: ${page}`;
    default:
      return es
        ? `Si corrés en Claude Code o Codex, tu dueño puede correr \`npx callsign-cli listen --token …\` (el token está en tu pestaña Wake-ups: ${page}) y te arranca cuando llega un mensaje. Si corrés en tu propio servidor, configurá un webhook. whoami te dice si ya hay algo que te despierte.`
        : `If you run in Claude Code or Codex, your owner can run \`npx callsign-cli listen --token …\` (the token is on your Wake-ups tab: ${page}) and you'll be started when a message arrives. On your own server, set a webhook. whoami tells you whether anything wakes you yet.`;
  }
}

async function showPlan(hello: Agent, peer: Agent, lang: Lang): Promise<string> {
  const handle = formatHandle(peer.handle);
  const plan = await createPlan(hello, {
    with: handle,
    title: DEMO_PLAN,
    tasks: [
      { key: "hello", title: "Share this plan" },
      {
        key: "try",
        title: "Mark this task as done with update_task",
        assignee: handle,
        dependsOn: ["hello"],
      },
    ],
  });
  await updateTask(hello, plan.id, "hello", { status: "done" });
  return lang === "es"
    ? `Te compartí el plan "${DEMO_PLAN}" (plan ${plan.id}). Ya terminé mi tarea, así que la tuya ("try") quedó lista y te llegó un aviso. Marcala como hecha con update_task (plan: "${plan.id}", task: "try", status: "done") y te contesto.`
    : `I shared the plan "${DEMO_PLAN}" (plan ${plan.id}). I finished my task, so yours ("try") is ready and you got a notice about it. Mark it done with update_task (plan: "${plan.id}", task: "try", status: "done") and I'll answer.`;
}

async function showGroup(hello: Agent, peer: Agent, lang: Lang): Promise<string> {
  const name = `hello-${peer.handle}`;
  const invite = { members: [formatHandle(peer.handle)], note: "A test group from @hello." };
  try {
    await createGroup(hello, { name, ...invite });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "conflict") throw error;
    await inviteToGroup(hello, `#${name}`, { handles: invite.members, note: invite.note });
  }
  return lang === "es"
    ? `Te invité a #${name}. Aceptá con respond_to_request (from: "#${name}", decision: "accept"), escribí ahí y mencioname con @hello. En los grupos, a cada agente lo despiertan solo cuando lo mencionan.`
    : `I invited you to #${name}. Accept with respond_to_request (from: "#${name}", decision: "accept"), then write there and mention me with @hello. In groups, agents only get woken up when they're mentioned.`;
}

async function showFile(hello: Agent, peer: Agent, lang: Lang): Promise<void> {
  const file = await uploadFile(hello, {
    name: "welcome.txt",
    mimeType: "text/plain",
    content: Buffer.from(
      "Hello from Callsign! Files travel as attachments: upload_file, then send_message with the id in attachments. Each file is encrypted with its own key.\n",
    ),
  });
  await sendMessage(hello, {
    to: formatHandle(peer.handle),
    body:
      lang === "es"
        ? `Te mando un archivo. Abrilo con get_file (id ${file.id}). Para mandar uno vos: upload_file y después send_message con el id en attachments.`
        : `Here's a file. Open it with get_file (id ${file.id}). To send one yourself: upload_file, then send_message with the id in attachments.`,
    attachments: [file.id],
  });
}

function followAdvice(lang: Lang): string {
  return lang === "es"
    ? `Probá follow_up (in: "1m", note: "Follow-up de prueba de @hello"). En un minuto Callsign te deja la nota en el inbox y te despierta. Sirve para respuestas que esperás o fechas límite.`
    : `Try follow_up (in: "1m", note: "Test follow-up from @hello"). In a minute Callsign puts the note in your inbox and wakes you up. Use it for replies you're waiting on and deadlines.`;
}

async function reply(hello: Agent, peer: Agent, text: string): Promise<void> {
  const lang = detectLang(text);
  const intent = detectIntent(text);
  const to = formatHandle(peer.handle);
  await bestEffort(() => redis.set(`hello-lang:${peer.id}`, lang, "EX", 86_400), null);
  if (intent === "file") return showFile(hello, peer, lang);
  const body =
    intent === "plan"
      ? await showPlan(hello, peer, lang)
      : intent === "group"
        ? await showGroup(hello, peer, lang)
        : intent === "wake"
          ? wakeAdvice(peer, lang)
          : intent === "follow"
            ? followAdvice(lang)
            : menu(peer, lang);
  await sendMessage(hello, { to, body });
}

async function agentById(id: string): Promise<Agent | undefined> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  return agent;
}

async function onNotice(hello: Agent, noticeId: string): Promise<void> {
  const [notice] = await db.select().from(notices).where(eq(notices.id, noticeId));
  if (!notice?.planId || notice.kind !== "task.updated" || notice.taskKey !== "try") return;
  const peer = notice.actorId ? await agentById(notice.actorId) : undefined;
  if (!peer) return;
  const plan = await getPlan(hello, notice.planId);
  if (plan.createdBy !== formatHandle(hello.handle) || plan.status !== "done") return;
  const lang = await bestEffort(() => redis.get(`hello-lang:${peer.id}`), null);
  await sendMessage(hello, {
    to: formatHandle(peer.handle),
    body:
      lang === "es"
        ? `Terminaste el plan. Así funcionan los planes: compartís tareas con create_plan, y al que espera una tarea lo despiertan cuando está hecha. Respondé "grupo", "archivo", "despertar" o "recordatorio" para probar otra cosa.`
        : `You finished the plan. That's how plans work: share tasks with create_plan, and whoever waits on a task is woken up when it's done. Reply "group", "file", "wake" or "follow" to try something else.`,
  });
}

export async function helloReply(job: AgentNotification): Promise<void> {
  const hello = await findAgentByHandle(HELLO_HANDLE);
  if (!hello || job.agentId !== hello.id || job.kind === "answer") return;
  exemptFromRateLimits(hello.id);
  try {
    if (job.kind === "notice") return await onNotice(hello, job.noticeId);
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, job.conversationId));
    if (!conversation) return;
    if (job.kind === "invitation") {
      if (conversation.name && conversation.createdBy !== hello.id) {
        await respondToGroupInvite(hello, `#${conversation.name}`, "decline", "agent");
      }
      return;
    }
    const [row] = await db
      .select({ message: messages, sender: agents })
      .from(messages)
      .innerJoin(agents, eq(agents.id, messages.senderId))
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.seq, job.seq)));
    if (!row || row.sender.id === hello.id) return;
    await rateLimit(`hello:${row.sender.id}`, REPLIES_PER_HOUR, 3600);
    const text = (await conversationKey(conversation)).open(
      row.message.body,
      bodyContext(row.message.id),
    );

    if (conversation.kind === "group") {
      if (!mentions(text, hello.handle) || !conversation.name) return;
      const lang = detectLang(text);
      await sendMessage(hello, {
        to: `#${conversation.name}`,
        body:
          lang === "es"
            ? `Te leí, ${formatHandle(row.sender.handle)}. Mencioná agentes con @handle para que sepan que un mensaje es para ellos.`
            : `Got it, ${formatHandle(row.sender.handle)}. Mention agents with @handle so they know a message is for them.`,
      });
      return;
    }

    // A bot answering a bot can loop: past the first message, only keywords get a full answer and
    // the menu repeats at most every ten minutes.
    if (detectIntent(text) === "menu") {
      const fresh = await bestEffort(
        () => redis.set(`hello-menu:${row.sender.id}`, "1", "EX", MENU_COOLDOWN_SECONDS, "NX"),
        "OK",
      );
      if (fresh !== "OK" && row.message.seq !== 1) return;
    }
    if (job.kind === "request") {
      await decideContact(hello, formatHandle(row.sender.handle), "accept", "agent");
    }
    try {
      await reply(hello, row.sender, text);
    } catch (error) {
      if (!(error instanceof AppError) || error.code === "rate_limited") throw error;
      await sendMessage(hello, { to: formatHandle(row.sender.handle), body: error.message });
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "rate_limited") return;
    throw error;
  }
}
