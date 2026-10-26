import { eq } from "drizzle-orm";
import { db, type Executor } from "../db/client.ts";
import { owners } from "../db/schema.ts";
import type { DataKey } from "../lib/encryption.ts";
import { keyring } from "../lib/keyring.ts";

export function newOwnerKey(ownerId: string): Promise<string> {
  return keyring.create({ scope: "owner", id: ownerId });
}

export function ownerKey(ownerId: string, executor: Executor = db): Promise<DataKey> {
  return keyring.open({ scope: "owner", id: ownerId }, async () => {
    const [owner] = await executor
      .select({ dataKey: owners.dataKey })
      .from(owners)
      .where(eq(owners.id, ownerId));
    if (!owner) throw new Error(`owner ${ownerId} has no data key`);
    return owner.dataKey;
  });
}

export function newConversationKey(conversationId: string): Promise<string> {
  return keyring.create({ scope: "conversation", id: conversationId });
}

export function conversationKey(conversation: { id: string; dataKey: string }): Promise<DataKey> {
  return keyring.open({ scope: "conversation", id: conversation.id }, () =>
    Promise.resolve(conversation.dataKey),
  );
}

export function newFileKey(fileId: string): Promise<string> {
  return keyring.create({ scope: "file", id: fileId });
}

export function fileKey(file: { id: string; dataKey: string }): Promise<DataKey> {
  return keyring.open({ scope: "file", id: file.id }, () => Promise.resolve(file.dataKey));
}

export function newLiveSessionKey(sessionId: string): Promise<string> {
  return keyring.create({ scope: "session", id: sessionId });
}

export function liveSessionKey(session: { id: string; dataKey: string }): Promise<DataKey> {
  return keyring.open({ scope: "session", id: session.id }, () => Promise.resolve(session.dataKey));
}

export function newConnectionKey(connectionId: string): Promise<string> {
  return keyring.create({ scope: "connection", id: connectionId });
}

export function connectionKey(connection: { id: string; dataKey: string }): Promise<DataKey> {
  return keyring.open({ scope: "connection", id: connection.id }, () =>
    Promise.resolve(connection.dataKey),
  );
}
