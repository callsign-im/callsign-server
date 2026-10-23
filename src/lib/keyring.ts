import { randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { config } from "../config.ts";
import { DataKey, decrypt, encrypt, KEY_BYTES } from "./encryption.ts";

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 10_000;

export type KeyScope = "owner" | "conversation" | "file";
export type KeyContext = { scope: KeyScope; id: string };

export type KeyWrapper = {
  generate(context: KeyContext): Promise<{ key: Buffer; wrapped: string }>;
  unwrap(wrapped: string, context: KeyContext): Promise<Buffer>;
};

function payloadOf(wrapped: string, prefix: string): string {
  if (!wrapped.startsWith(`${prefix}.`)) {
    throw new Error(`data key was not wrapped with ${prefix}, check KMS_KEY_ID and ENCRYPTION_KEY`);
  }
  return wrapped.slice(prefix.length + 1);
}

export function localWrapper(masterKey: Buffer): KeyWrapper {
  if (masterKey.length !== KEY_BYTES) throw new Error(`ENCRYPTION_KEY must be ${KEY_BYTES} bytes`);
  const aad = ({ scope, id }: KeyContext) => `${scope}:${id}`;
  return {
    generate(context) {
      return new Promise((resolve) => {
        const key = randomBytes(KEY_BYTES);
        const wrapped = encrypt(masterKey, key, aad(context)).toString("base64url");
        resolve({ key, wrapped: `local.${wrapped}` });
      });
    },
    unwrap(wrapped, context) {
      return new Promise((resolve) => {
        const payload = Buffer.from(payloadOf(wrapped, "local"), "base64url");
        resolve(decrypt(masterKey, payload, aad(context)));
      });
    },
  };
}

export function kmsWrapper(client: KMSClient, keyId: string): KeyWrapper {
  const encryptionContext = ({ scope, id }: KeyContext) => ({ scope, id });
  return {
    async generate(context) {
      const output = await client.send(
        new GenerateDataKeyCommand({
          KeyId: keyId,
          KeySpec: "AES_256",
          EncryptionContext: encryptionContext(context),
        }),
      );
      if (!output.Plaintext || !output.CiphertextBlob) throw new Error("KMS returned no data key");
      return {
        key: Buffer.from(output.Plaintext),
        wrapped: `kms.${Buffer.from(output.CiphertextBlob).toString("base64")}`,
      };
    },
    async unwrap(wrapped, context) {
      const output = await client.send(
        new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: Buffer.from(payloadOf(wrapped, "kms"), "base64"),
          EncryptionContext: encryptionContext(context),
        }),
      );
      if (!output.Plaintext) throw new Error("KMS returned no plaintext");
      return Buffer.from(output.Plaintext);
    },
  };
}

type CacheEntry = { key: Promise<DataKey>; expiresAt: number };

export class Keyring {
  readonly #wrapper: KeyWrapper;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(wrapper: KeyWrapper) {
    this.#wrapper = wrapper;
  }

  async create(context: KeyContext): Promise<string> {
    const { key, wrapped } = await this.#wrapper.generate(context);
    this.#remember(context, Promise.resolve(new DataKey(key)));
    return wrapped;
  }

  open(context: KeyContext, load: () => Promise<string>): Promise<DataKey> {
    const cached = this.#cache.get(cacheKey(context));
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    const key = load()
      .then((wrapped) => this.#wrapper.unwrap(wrapped, context))
      .then((plaintext) => new DataKey(plaintext));
    this.#remember(context, key);
    return key;
  }

  #remember(context: KeyContext, key: Promise<DataKey>): void {
    const id = cacheKey(context);
    this.#cache.delete(id);
    this.#cache.set(id, { key, expiresAt: Date.now() + CACHE_TTL_MS });
    key.catch(() => {
      if (this.#cache.get(id)?.key === key) this.#cache.delete(id);
    });
    if (this.#cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
  }
}

function cacheKey({ scope, id }: KeyContext): string {
  return `${scope}:${id}`;
}

function configuredWrapper(): KeyWrapper {
  if (config.KMS_KEY_ID) return kmsWrapper(new KMSClient({}), config.KMS_KEY_ID);
  if (config.ENCRYPTION_KEY) return localWrapper(Buffer.from(config.ENCRYPTION_KEY, "base64"));
  throw new Error("Set KMS_KEY_ID or ENCRYPTION_KEY to encrypt stored data.");
}

export const keyring = new Keyring(configuredWrapper());
