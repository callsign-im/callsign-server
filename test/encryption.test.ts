import { randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import { describe, expect, it, vi } from "vitest";
import { DataKey } from "../src/lib/encryption.ts";
import {
  Keyring,
  kmsWrapper,
  localWrapper,
  type KeyContext,
  type KeyWrapper,
} from "../src/lib/keyring.ts";

const context = { scope: "owner", id: "0199f6a0-0000-7000-8000-000000000001" } as const;

describe("data keys", () => {
  const key = new DataKey(randomBytes(32));

  it("seals and opens values bound to their context", () => {
    const sealed = key.seal("Never share bank details.", "agents.rules:a1");
    expect(sealed.ciphertext).toMatch(/^v1\./);
    expect(sealed.ciphertext).not.toContain("bank");
    expect(key.seal("Never share bank details.", "agents.rules:a1").ciphertext).not.toBe(
      sealed.ciphertext,
    );
    expect(key.open(sealed, "agents.rules:a1")).toBe("Never share bank details.");
    expect(key.seal(null, "agents.rules:a1")).toBeNull();
    expect(key.open(null, "agents.rules:a1")).toBeNull();
  });

  it("rejects ciphertext moved to another row or tampered with", () => {
    const sealed = key.seal("Invoice is ready", "messages.body:m1");
    expect(() => key.open(sealed, "messages.body:m2")).toThrow();

    const bytes = Buffer.from(sealed.ciphertext.slice(3), "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const tampered = { ciphertext: `v1.${bytes.toString("base64url")}` };
    expect(() => key.open(tampered, "messages.body:m1")).toThrow();
    expect(() => new DataKey(randomBytes(32)).open(sealed, "messages.body:m1")).toThrow();
  });

  it("computes digests that depend on the key", () => {
    expect(key.digest("ok")).toBe(key.digest("ok"));
    expect(key.digest("ok")).not.toBe(new DataKey(randomBytes(32)).digest("ok"));
  });
});

describe("key wrappers", () => {
  it("wraps data keys locally with the master key", async () => {
    const wrapper = localWrapper(randomBytes(32));
    const { key, wrapped } = await wrapper.generate(context);
    expect(wrapped).toMatch(/^local\./);
    expect(await wrapper.unwrap(wrapped, context)).toEqual(key);
    await expect(wrapper.unwrap(wrapped, { ...context, id: "another" })).rejects.toThrow();
    await expect(wrapper.unwrap("kms.AAAA", context)).rejects.toThrow(/not wrapped with local/);
  });

  it("asks KMS for data keys bound to an encryption context", async () => {
    const plaintext = randomBytes(32);
    const send = vi.fn((command: GenerateDataKeyCommand | DecryptCommand) =>
      Promise.resolve(
        command instanceof GenerateDataKeyCommand
          ? { Plaintext: plaintext, CiphertextBlob: Buffer.from("blob") }
          : { Plaintext: plaintext },
      ),
    );
    const wrapper = kmsWrapper({ send } as unknown as KMSClient, "alias/callsign");

    const { key, wrapped } = await wrapper.generate(context);
    expect(key).toEqual(plaintext);
    expect(wrapped).toBe(`kms.${Buffer.from("blob").toString("base64")}`);
    expect(await wrapper.unwrap(wrapped, context)).toEqual(plaintext);

    const [generate, decrypt] = send.mock.calls.map(([command]) => command);
    expect(generate).toBeInstanceOf(GenerateDataKeyCommand);
    expect(generate?.input).toEqual({
      KeyId: "alias/callsign",
      KeySpec: "AES_256",
      EncryptionContext: { scope: "owner", id: context.id },
    });
    expect(decrypt).toBeInstanceOf(DecryptCommand);
    expect(decrypt?.input).toEqual({
      KeyId: "alias/callsign",
      CiphertextBlob: Buffer.from("blob"),
      EncryptionContext: { scope: "owner", id: context.id },
    });
  });
});

describe("keyring", () => {
  function countingWrapper() {
    const wrapper = localWrapper(randomBytes(32));
    const unwrap = vi.fn((wrapped: string, ctx: KeyContext) => wrapper.unwrap(wrapped, ctx));
    return { wrapper: { ...wrapper, unwrap } satisfies KeyWrapper, unwrap };
  }

  it("unwraps each data key once and shares it between callers", async () => {
    const { wrapper, unwrap } = countingWrapper();
    const wrapped = await new Keyring(wrapper).create(context);
    const keyring = new Keyring(wrapper);
    const load = vi.fn(() => Promise.resolve(wrapped));

    const [first, second] = await Promise.all([
      keyring.open(context, load),
      keyring.open(context, load),
    ]);
    expect(first).toBe(second);
    expect(await keyring.open(context, load)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(unwrap).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const { wrapper } = countingWrapper();
    const wrapped = await new Keyring(wrapper).create(context);
    const keyring = new Keyring(wrapper);

    await expect(keyring.open(context, () => Promise.reject(new Error("down")))).rejects.toThrow(
      "down",
    );
    await expect(keyring.open(context, () => Promise.resolve(wrapped))).resolves.toBeInstanceOf(
      DataKey,
    );
  });
});
