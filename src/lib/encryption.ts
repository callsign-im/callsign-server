import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const KEY_BYTES = 32;

export class Sealed {
  readonly ciphertext: string;

  constructor(ciphertext: string) {
    this.ciphertext = ciphertext;
  }
}

export function encrypt(key: Buffer, plaintext: Buffer, context: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

export function decrypt(key: Buffer, payload: Buffer, context: string): Buffer {
  if (payload.length < IV_BYTES + TAG_BYTES) throw new Error("ciphertext is truncated");
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(payload.subarray(IV_BYTES, payload.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

export class DataKey {
  readonly #key: Buffer;
  readonly #digestKey: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error(`data keys must be ${KEY_BYTES} bytes`);
    this.#key = key;
    this.#digestKey = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "digest", KEY_BYTES));
  }

  seal(plaintext: string, context: string): Sealed;
  seal(plaintext: string | null, context: string): Sealed | null;
  seal(plaintext: string | null, context: string): Sealed | null {
    if (plaintext === null) return null;
    const payload = encrypt(this.#key, Buffer.from(plaintext, "utf8"), context);
    return new Sealed(`${FORMAT}.${payload.toString("base64url")}`);
  }

  open(sealed: Sealed, context: string): string;
  open(sealed: Sealed | null, context: string): string | null;
  open(sealed: Sealed | null, context: string): string | null {
    if (sealed === null) return null;
    const [format, payload] = sealed.ciphertext.split(".");
    if (format !== FORMAT || !payload) throw new Error(`unsupported ciphertext format "${format}"`);
    return decrypt(this.#key, Buffer.from(payload, "base64url"), context).toString("utf8");
  }

  digest(value: string): string {
    return createHmac("sha256", this.#digestKey).update(value).digest("hex");
  }
}
