import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// A software passkey for tests: ES256 keys, "none" attestation and just enough CBOR to encode
// what an authenticator sends.

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [key: string]: Cbor };

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const bytes = Buffer.alloc(3);
    bytes[0] = (major << 5) | 25;
    bytes.writeUInt16BE(length, 1);
    return bytes;
  }
  const bytes = Buffer.alloc(5);
  bytes[0] = (major << 5) | 26;
  bytes.writeUInt32BE(length, 1);
  return bytes;
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ]);
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export type SoftPasskey = {
  credentialId: Buffer;
  privateKey: KeyObject;
  counter: number;
};

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

function rpIdHash(rpId: string): Buffer {
  return createHash("sha256").update(rpId).digest();
}

function counterBytes(counter: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(counter);
  return bytes;
}

export function createPasskey(
  options: { challenge: string; rp: { id?: string } },
  overrides: { origin?: string; rpId?: string } = {},
): { passkey: SoftPasskey; response: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = cbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x ?? "", "base64url")],
      [-3, Buffer.from(jwk.y ?? "", "base64url")],
    ]),
  );
  const credentialId = randomBytes(16);
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    rpIdHash(overrides.rpId ?? options.rp.id ?? "localhost"),
    Buffer.from([UP | UV | AT]),
    counterBytes(0),
    Buffer.alloc(16),
    idLength,
    credentialId,
    cose,
  ]);
  const id = credentialId.toString("base64url");
  return {
    passkey: { credentialId, privateKey, counter: 0 },
    response: {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: clientData(
          "webauthn.create",
          options.challenge,
          overrides.origin ?? "http://localhost:3001",
        ).toString("base64url"),
        attestationObject: cbor({ fmt: "none", attStmt: {}, authData }).toString("base64url"),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    },
  };
}

export function usePasskey(
  passkey: SoftPasskey,
  options: { challenge: string; rpId?: string },
  overrides: { origin?: string; counter?: number } = {},
): Record<string, unknown> {
  passkey.counter = overrides.counter ?? passkey.counter + 1;
  const authenticatorData = Buffer.concat([
    rpIdHash(options.rpId ?? "localhost"),
    Buffer.from([UP | UV]),
    counterBytes(passkey.counter),
  ]);
  const clientDataJSON = clientData(
    "webauthn.get",
    options.challenge,
    overrides.origin ?? "http://localhost:3001",
  );
  const signature = sign(
    "sha256",
    Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
    passkey.privateKey,
  );
  const id = passkey.credentialId.toString("base64url");
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: clientDataJSON.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url"),
    },
    clientExtensionResults: {},
  };
}

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

function dashboardPost(app: App, cookie: string, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { cookie, origin: "http://localhost:3001", "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** Registers a software passkey for the signed-in owner. */
export async function enrollPasskey(app: App, cookie: string): Promise<SoftPasskey> {
  const started = await dashboardPost(app, cookie, "/v1/me/passkeys/options");
  const { options } = (await started.json()) as {
    options: { challenge: string; rp: { id?: string } };
  };
  const { passkey, response } = createPasskey(options);
  const created = await dashboardPost(app, cookie, "/v1/me/passkeys", { response });
  if (created.status !== 201) throw new Error(`passkey enrollment failed: ${created.status}`);
  return passkey;
}

/** Confirms a passkey, raising the session for sensitive changes. */
export async function elevate(app: App, cookie: string, passkey: SoftPasskey): Promise<void> {
  const started = await dashboardPost(app, cookie, "/v1/me/step-up/options");
  const { options } = (await started.json()) as { options: { challenge: string; rpId?: string } };
  const done = await dashboardPost(app, cookie, "/v1/me/step-up", {
    response: usePasskey(passkey, options),
  });
  if (done.status !== 200) throw new Error(`step-up failed: ${done.status}`);
}
