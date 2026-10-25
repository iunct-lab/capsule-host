import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { fakeAuthenticator } from "./test-fixture";
import { rpIdOf, verifyAssertion, verifyRegistration } from "./webauthn";

const origin = "https://trip.example", rpId = "trip.example", now = +new Date("2026-09-20T00:00:00Z");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

const expected = (challenge: string) => ({ challenge, origin, rpId });

describe("WebAuthn verification without dependencies", () => {
  test("a registration yields only the credential id and public key, and the passkey then authenticates", () => {
    for (const rsa of [false, true]) {
      const device = fakeAuthenticator({ rsa }), passkey = verifyRegistration(device.register("c1"), expected("c1"), now);
      expect(passkey).toEqual({ id: device.id, publicKey: expect.any(String), algorithm: rsa ? -257 : -7, counter: 0, created: now });
      device.setCounter(1);
      expect(verifyAssertion(device.assert("c2"), expected("c2"), passkey)).toBe(1);
    }
  });
  test("a different challenge is refused", () => {
    const device = fakeAuthenticator(), passkey = verifyRegistration(device.register("c1"), expected("c1"), now);
    expect(() => verifyRegistration(device.register("other"), expected("c1"), now)).toThrow("passkey");
    expect(() => verifyAssertion(device.assert("other"), expected("c2"), passkey)).toThrow("passkey");
  });
  test("a different origin is refused", () => {
    const device = fakeAuthenticator(), passkey = verifyRegistration(device.register("c1"), expected("c1"), now);
    expect(() => verifyRegistration(device.register("c1", { origin: "https://evil.example" }), expected("c1"), now)).toThrow("passkey");
    expect(() => verifyAssertion(device.assert("c2", { origin: "https://evil.example" }), expected("c2"), passkey)).toThrow("passkey");
  });
  test("a different RP ID is refused", () => {
    const device = fakeAuthenticator(), passkey = verifyRegistration(device.register("c1"), expected("c1"), now);
    expect(() => verifyRegistration(device.register("c1", { rpId: "evil.example" }), expected("c1"), now)).toThrow("passkey");
    expect(() => verifyAssertion(device.assert("c2", { rpId: "evil.example" }), expected("c2"), passkey)).toThrow("passkey");
  });
  test("user verification is required; a ceremony of the other type is refused", () => {
    const device = fakeAuthenticator(), passkey = verifyRegistration(device.register("c1"), expected("c1"), now);
    expect(() => verifyRegistration(device.register("c1", { flags: 0x41 }), expected("c1"), now)).toThrow("passkey");
    expect(() => verifyRegistration(device.register("c1", { flags: 0x05 }), expected("c1"), now)).toThrow("passkey"); // no attested credential data
    expect(() => verifyRegistration(device.register("c1", { flags: 0x44 }), expected("c1"), now)).toThrow("passkey"); // no user presence
    expect(() => verifyAssertion(device.assert("c2", { flags: 0x01 }), expected("c2"), passkey)).toThrow("passkey");
    expect(() => verifyAssertion(device.assert("c2", { type: "webauthn.create" }), expected("c2"), passkey)).toThrow("passkey");
    expect(() => verifyRegistration(device.register("c1", { type: "webauthn.get" }), expected("c1"), now)).toThrow("passkey");
  });
  test("a tampered signature or another device's key is refused", () => {
    const device = fakeAuthenticator(), other = generateKeyPairSync("ec", { namedCurve: "P-256" }), passkey = verifyRegistration(device.register("c1"), expected("c1"), now);
    const good = device.assert("c2"), bytes = Buffer.from(good.signature, "base64url"); bytes[bytes.length - 1]! ^= 1;
    expect(() => verifyAssertion({ ...good, signature: b64(bytes) }, expected("c2"), passkey)).toThrow("passkey");
    expect(() => verifyAssertion(device.assert("c2", { key: other.privateKey }), expected("c2"), passkey)).toThrow("passkey");
    // Signed data that was altered after signing.
    expect(() => verifyAssertion({ ...good, authenticatorData: device.assert("c2", { flags: 0x0d }).authenticatorData }, expected("c2"), passkey)).toThrow("passkey");
  });
  test("a counter that does not advance is refused", () => {
    const device = fakeAuthenticator(), passkey = { ...verifyRegistration(device.register("c1"), expected("c1"), now), counter: 5 };
    device.setCounter(5); expect(() => verifyAssertion(device.assert("c2"), expected("c2"), passkey)).toThrow("passkey");
    device.setCounter(0); expect(() => verifyAssertion(device.assert("c2"), expected("c2"), passkey)).toThrow("passkey");
    device.setCounter(6); expect(verifyAssertion(device.assert("c2"), expected("c2"), passkey)).toBe(6);
  });
  test("authenticators that never count (both 0) are accepted", () => {
    const device = fakeAuthenticator(), passkey = verifyRegistration(device.register("c1"), expected("c1"), now);
    expect(verifyAssertion(device.assert("c2"), expected("c2"), passkey)).toBe(0);
  });
  test("malformed input is refused without detail", () => {
    const device = fakeAuthenticator(), good = device.register("c1");
    expect(() => verifyRegistration({ ...good, publicKey: b64(randomBytes(40)) }, expected("c1"), now)).toThrow("passkey");
    expect(() => verifyRegistration({ ...good, algorithm: -8 }, expected("c1"), now)).toThrow("passkey");
    expect(() => verifyRegistration({ ...good, algorithm: -257 }, expected("c1"), now)).toThrow("passkey"); // an EC key declared as RSA
    const wrongCurve = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ format: "der", type: "spki" });
    expect(() => verifyRegistration({ ...good, publicKey: b64(wrongCurve) }, expected("c1"), now)).toThrow("passkey"); // ES256 means P-256
    expect(() => verifyRegistration({ ...good, authenticatorData: b64(Buffer.from(good.authenticatorData, "base64url").subarray(0, 60)) }, expected("c1"), now)).toThrow("passkey");
    expect(() => verifyRegistration({ ...good, authenticatorData: b64(Buffer.from(good.authenticatorData, "base64url").subarray(0, 54)) }, expected("c1"), now)).toThrow("passkey"); // no room for the credential id
    // JSON that parses but is not an object must refuse like everything else, not throw its own error.
    for (const value of ["not json", "null", "1", '"x"', "[]"]) expect(() => verifyRegistration({ ...good, clientDataJSON: b64(Buffer.from(value)) }, expected("c1"), now)).toThrow("passkey");
    expect(() => verifyAssertion({ ...device.assert("c2"), clientDataJSON: b64(Buffer.from("null")) }, expected("c2"), verifyRegistration(good, expected("c1"), now))).toThrow("passkey");
  });
  test("the RP ID is the host name of the public origin", () => {
    expect(rpIdOf("https://d111111abcdef8.cloudfront.net")).toBe("d111111abcdef8.cloudfront.net");
    expect(rpIdOf("http://127.0.0.1:47840")).toBe("127.0.0.1");
  });
});
