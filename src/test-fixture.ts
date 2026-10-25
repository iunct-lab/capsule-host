import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { emptyTrip } from "./template";
// Fictional test data only. Not imported by client or production entrypoints.
// The day n days after `start` (YYYY-MM-DD), counted in UTC like `emptyTrip`.
export function tripDay(start: string, n: number) {
  const d = new Date(start); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function testTrip(start = "2026-09-24") {
  const [d0, d1, d2] = [0, 1, 2].map(n => tripDay(start, n));
  const seed = emptyTrip(d0!, d2!, "テスト旅行");
  seed.document.items = [
    { id: "arrival", title: "集合", day: d0!, startsAt: `${d0}T13:15:00+09:00`, kind: "transport", status: "confirmed", revision: 1 },
    { id: "dinner", title: "夕食", day: d1!, startsAt: `${d1}T19:00:00+09:00`, kind: "meal", status: "confirmed", revision: 1 },
    { id: "walk", title: "公園の散歩", day: d2!, startsAt: `${d2}T10:00:00+09:00`, timeTentative: true, kind: "activity", status: "proposed", revision: 1 },
  ];
  return seed;
}

// Stands in for a platform authenticator: builds the two byte strings a browser hands to the server.
export function fakeAuthenticator(options: { rsa?: boolean; origin?: string } = {}) {
  const origin = options.origin ?? "https://trip.example", rpId = new URL(origin).hostname, b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  const pair = options.rsa ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(20);
  let counter = 0;
  const authData = (flags: number, site: string, attested: boolean) => {
    const head = Buffer.alloc(37); createHash("sha256").update(site).digest().copy(head); head[32] = flags; head.writeUInt32BE(counter, 33);
    if (!attested) return head;
    const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), length, credentialId, Buffer.from([0xa5, 0x01, 0x02])]); // AAGUID, id, then the COSE key the server never parses
  };
  const clientData = (type: string, challenge: string, from: string) => Buffer.from(JSON.stringify({ type, challenge, origin: from, crossOrigin: false }));
  return {
    id: b64(credentialId),
    setCounter(n: number) { counter = n; },
    register(challenge: string, o: { origin?: string; rpId?: string; flags?: number; type?: string } = {}) {
      return { clientDataJSON: b64(clientData(o.type ?? "webauthn.create", challenge, o.origin ?? origin)), authenticatorData: b64(authData(o.flags ?? 0x45, o.rpId ?? rpId, true)), publicKey: b64(pair.publicKey.export({ format: "der", type: "spki" })), algorithm: options.rsa ? -257 : -7 };
    },
    assert(challenge: string, o: { origin?: string; rpId?: string; flags?: number; type?: string; key?: KeyObject } = {}) {
      const data = authData(o.flags ?? 0x05, o.rpId ?? rpId, false), client = clientData(o.type ?? "webauthn.get", challenge, o.origin ?? origin);
      const signature = sign("sha256", Buffer.concat([data, createHash("sha256").update(client).digest()]), o.key ?? pair.privateKey);
      return { clientDataJSON: b64(client), authenticatorData: b64(data), signature: b64(signature) };
    },
  };
}
