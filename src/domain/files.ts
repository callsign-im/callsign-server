import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { db, type Executor, type Tx } from "../db/client.ts";
import { conversationMembers, files, type Agent, type StoredFile } from "../db/schema.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { AppError } from "./errors.ts";
import { fileKey, newFileKey } from "./keys.ts";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
const UNATTACHED_TTL_MS = 24 * 3_600_000;
const READABLE_STATUSES = ["active", "pending", "invited"];

export type AttachmentView = { id: string; name: string; mimeType: string; size: number };

const nameContext = (fileId: string) => `files.name:${fileId}`;
const dataContext = (fileId: string) => `files.data:${fileId}`;

function cleanMimeType(raw: string | undefined): string {
  const value = raw?.trim().toLowerCase() ?? "";
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value) ? value : "application/octet-stream";
}

function cleanName(raw: string): string {
  const name = raw.replace(/[/\\\0]/g, "_").trim();
  if (!name) throw new AppError("invalid_input", "Give the file a name.");
  return name.slice(0, 200);
}

async function view(file: StoredFile): Promise<AttachmentView> {
  const key = await fileKey(file);
  return {
    id: file.id,
    name: key.open(file.name, nameContext(file.id)),
    mimeType: file.mimeType,
    size: file.size,
  };
}

export async function uploadFile(
  uploader: Agent,
  input: { name: string; mimeType?: string | undefined; content: Buffer },
): Promise<AttachmentView> {
  if (input.content.length === 0) throw new AppError("invalid_input", "The file is empty.");
  if (input.content.length > MAX_FILE_BYTES) {
    throw new AppError("invalid_input", `Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  await rateLimit(`upload:${uploader.id}`, 60, 3600);
  const id = uuidv7();
  const dataKey = await newFileKey(id);
  const key = await fileKey({ id, dataKey });
  const [file] = await db
    .insert(files)
    .values({
      id,
      uploaderId: uploader.id,
      name: key.seal(cleanName(input.name), nameContext(id)),
      mimeType: cleanMimeType(input.mimeType),
      size: input.content.length,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
      dataKey,
      data: key.sealBytes(input.content, dataContext(id)),
    })
    .returning();
  if (!file) throw new Error("file insert returned no row");
  return view(file);
}

// Attaching moves a file from its uploader into one message; each upload can be sent only once.
export async function attachFiles(
  tx: Tx,
  sender: Agent,
  fileIds: string[],
  target: { conversationId: string; messageId: string },
  reservedBy?: string,
): Promise<{ id: string; contentHash: string }[]> {
  if (fileIds.length === 0) return [];
  if (fileIds.length > MAX_ATTACHMENTS) {
    throw new AppError("invalid_input", `Attach up to ${MAX_ATTACHMENTS} files per message.`);
  }
  const attached = await tx
    .update(files)
    .set({ ...target, heldActionId: null })
    .where(
      and(
        inArray(files.id, fileIds),
        eq(files.uploaderId, sender.id),
        isNull(files.messageId),
        reservedBy ? eq(files.heldActionId, reservedBy) : isNull(files.heldActionId),
      ),
    )
    .returning({ id: files.id, contentHash: files.contentHash });
  if (attached.length !== new Set(fileIds).size) {
    throw new AppError(
      "invalid_input",
      "Attach files you uploaded with upload_file that haven't been sent yet.",
    );
  }
  return attached;
}

export async function attachmentsFor(messageIds: string[]): Promise<Map<string, AttachmentView[]>> {
  const byMessage = new Map<string, AttachmentView[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db.select().from(files).where(inArray(files.messageId, messageIds));
  for (const file of rows) {
    if (!file.messageId) continue;
    const list = byMessage.get(file.messageId) ?? [];
    list.push(await view(file));
    byMessage.set(file.messageId, list);
  }
  return byMessage;
}

async function canRead(agent: Agent, file: StoredFile): Promise<boolean> {
  if (file.uploaderId === agent.id) return true;
  if (!file.conversationId) return false;
  const [member] = await db
    .select({ status: conversationMembers.status })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, file.conversationId),
        eq(conversationMembers.agentId, agent.id),
      ),
    );
  return member !== undefined && READABLE_STATUSES.includes(member.status);
}

export async function readFile(
  agent: Agent,
  fileId: string,
): Promise<{ file: AttachmentView; content: Buffer }> {
  const [file] = await db.select().from(files).where(eq(files.id, fileId));
  if (!file || !(await canRead(agent, file))) {
    throw new AppError("not_found", "File not found, or it wasn't shared with you.");
  }
  const key = await fileKey(file);
  return { file: await view(file), content: key.openBytes(file.data, dataContext(file.id)) };
}

/** Holds a message's files while its owner decides, so nothing else can send or prune them. */
export async function reserveFiles(
  tx: Tx,
  sender: Agent,
  fileIds: string[],
  holdId: string,
): Promise<void> {
  if (fileIds.length === 0) return;
  if (fileIds.length > MAX_ATTACHMENTS) {
    throw new AppError("invalid_input", `Attach up to ${MAX_ATTACHMENTS} files per message.`);
  }
  const reserved = await tx
    .update(files)
    .set({ heldActionId: holdId })
    .where(
      and(
        inArray(files.id, fileIds),
        eq(files.uploaderId, sender.id),
        isNull(files.messageId),
        isNull(files.heldActionId),
      ),
    )
    .returning({ id: files.id });
  if (reserved.length !== new Set(fileIds).size) {
    throw new AppError(
      "invalid_input",
      "Attach files you uploaded with upload_file that haven't been sent yet.",
    );
  }
}

export async function unreserveFiles(executor: Executor, holdId: string): Promise<void> {
  await executor.update(files).set({ heldActionId: null }).where(eq(files.heldActionId, holdId));
}

export async function pruneUnsentFiles(): Promise<void> {
  await db
    .delete(files)
    .where(
      and(
        isNull(files.messageId),
        isNull(files.heldActionId),
        lt(files.createdAt, new Date(Date.now() - UNATTACHED_TTL_MS)),
      ),
    );
}
