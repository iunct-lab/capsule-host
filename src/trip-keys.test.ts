import { describe, expect, test } from "bun:test";
import { open, seal } from "./private-entries";
import { testTrip } from "./test-fixture";
import { sealedOperationSchema, type Document } from "./schema";
import { confirmationCodes, openField, openTrip, sealOperation, sealTrip, matchesCommitment, newAttempt, newHandoffKeys, newSeatKeys, newTripKey, signEdge, verifyEdge, seatPublic, unwrapSeatSecret, unwrapTripKey, wrapSeatSecret, wrapTripKey } from "./trip-keys";

const prf = () => crypto.getRandomValues(new Uint8Array(32));
const shape = /^v1\.[A-Za-z0-9_-]+$/;

describe("trip keys", () => {
  test("包む → 開く → 同じ鍵", async () => {
    const seat = await newSeatKeys(), trip = await newTripKey(), pub = await seatPublic(seat);
    expect(Buffer.from(pub.x25519, "base64url").length).toBe(32);
    expect(Buffer.from(pub.ed25519, "base64url").length).toBe(32);
    const { wrapped, ephemeral } = await wrapTripKey(trip, pub.x25519, "trip-a", 1);
    expect(wrapped).toMatch(shape); expect(wrapped.length).toBeLessThanOrEqual(200);
    expect(Buffer.from(ephemeral, "base64url").length).toBe(32);
    const opened = await unwrapTripKey(wrapped, ephemeral, seat.x25519.privateKey, "trip-a", 1);
    expect(await open(opened, await seal(trip, "旅行の鍵", "aad"), "aad")).toBe("旅行の鍵");
    await expect(crypto.subtle.exportKey("raw", opened)).rejects.toThrow();
  });
  test("別の席の秘密鍵では開けない", async () => {
    const mine = await newSeatKeys(), other = await newSeatKeys(), trip = await newTripKey();
    const { wrapped, ephemeral } = await wrapTripKey(trip, (await seatPublic(mine)).x25519, "trip-a", 1);
    await expect(unwrapTripKey(wrapped, ephemeral, other.x25519.privateKey, "trip-a", 1)).rejects.toThrow();
  });
  test("世代とカプセルの id が違うと開けない", async () => {
    const seat = await newSeatKeys(), trip = await newTripKey();
    const { wrapped, ephemeral } = await wrapTripKey(trip, (await seatPublic(seat)).x25519, "trip-a", 1);
    await expect(unwrapTripKey(wrapped, ephemeral, seat.x25519.privateKey, "trip-a", 2)).rejects.toThrow();
    await expect(unwrapTripKey(wrapped, ephemeral, seat.x25519.privateKey, "trip-b", 1)).rejects.toThrow();
  });
  test("PRF で包んだ席の秘密鍵", async () => {
    const seat = await newSeatKeys(), trip = await newTripKey(), mine = prf();
    const { wrapped, ephemeral } = await wrapTripKey(trip, (await seatPublic(seat)).x25519, "trip-a", 1);
    const secret = await wrapSeatSecret(seat, mine, "trip-a");
    expect(secret.x25519).toMatch(shape); expect(secret.x25519.length).toBeLessThanOrEqual(200);
    expect(secret.ed25519).toMatch(shape); expect(secret.ed25519.length).toBeLessThanOrEqual(200);
    const back = await unwrapSeatSecret(secret, mine, "trip-a");
    const opened = await unwrapTripKey(wrapped, ephemeral, back.x25519, "trip-a", 1);
    expect(await open(opened, await seal(trip, "x", "a"), "a")).toBe("x");
    // The unwrapped Ed25519 key signs what the published key verifies.
    const sig = await crypto.subtle.sign("Ed25519", back.ed25519, new TextEncoder().encode("m"));
    expect(await crypto.subtle.verify("Ed25519", seat.ed25519.publicKey, sig, new TextEncoder().encode("m"))).toBe(true);
    await expect(crypto.subtle.exportKey("pkcs8", back.x25519)).rejects.toThrow();
    await expect(unwrapSeatSecret(secret, prf(), "trip-a")).rejects.toThrow();
    await expect(unwrapSeatSecret(secret, mine, "trip-b")).rejects.toThrow();
    await expect(unwrapSeatSecret({ x25519: secret.ed25519, ed25519: secret.x25519 }, mine, "trip-a")).rejects.toThrow();
  });
});

describe("確認コードの受け渡し（§2.1 案 A）", () => {
  const cap = "trip-a";
  const parties = async () => {
    const giverSeat = await seatPublic(await newSeatKeys()), memberSeat = await seatPublic(await newSeatKeys());
    const { ephemeral } = await newHandoffKeys();
    const attempt = await newAttempt(memberSeat, cap);
    return { giver: { ephemeral, ...giverSeat }, member: { ...memberSeat, nonce: attempt.nonce }, attempt, memberSeat };
  };
  test("確認コード: 同じ入力から同じ 6 桁 2 つ、ハッシュの別の部分から", async () => {
    const p = await parties();
    const a = await confirmationCodes({ capsuleId: cap, giver: p.giver, member: p.member });
    expect(await confirmationCodes({ capsuleId: cap, giver: p.giver, member: p.member })).toEqual(a);
    expect(a.member).toMatch(/^\d{6}$/); expect(a.giver).toMatch(/^\d{6}$/);
    const h = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.concat([
      Buffer.from(`capsule handoff codes v1/${cap}`), ...[p.giver.ephemeral, p.giver.x25519, p.giver.ed25519, p.member.x25519, p.member.ed25519, p.member.nonce].map((v) => Buffer.from(v, "base64url")),
    ])));
    expect(a.member).toBe(String(h.readUInt32BE(0) % 1_000_000).padStart(6, "0"));
    expect(a.giver).toBe(String(h.readUInt32BE(4) % 1_000_000).padStart(6, "0"));
  });
  test("確認コード: 入力を固定すると、2 つは違う値になる", async () => {
    const key = (n: number) => Buffer.alloc(32, n).toString("base64url");
    const fixed = { capsuleId: cap, giver: { ephemeral: key(1), x25519: key(2), ed25519: key(3) }, member: { x25519: key(4), ed25519: key(5), nonce: Buffer.alloc(16, 6).toString("base64url") } };
    const codes = await confirmationCodes(fixed);
    expect(codes).toEqual(await confirmationCodes(fixed));
    expect(codes.member).not.toBe(codes.giver);
  });
  test("コミットメント: 試みごとに違い、同じ値でだけ合う", async () => {
    const p = await parties();
    const again = await newAttempt(p.memberSeat, cap);
    expect(again.nonce).not.toBe(p.attempt.nonce);
    expect(again.commitment).not.toBe(p.attempt.commitment);
    expect(Buffer.from(p.attempt.nonce, "base64url").length).toBe(16);
    expect(await matchesCommitment(p.attempt.commitment, p.memberSeat, p.attempt.nonce, cap)).toBe(true);
    expect(await matchesCommitment(p.attempt.commitment, p.memberSeat, p.attempt.nonce, "trip-b")).toBe(false);
  });
  test("すり替え: 公開鍵を替えるとコミットメントもコードも合わない", async () => {
    const p = await parties();
    const other = await seatPublic(await newSeatKeys());
    expect(await matchesCommitment(p.attempt.commitment, { ...p.memberSeat, x25519: other.x25519 }, p.attempt.nonce, cap)).toBe(false);
    expect(await matchesCommitment(p.attempt.commitment, { ...p.memberSeat, ed25519: other.ed25519 }, p.attempt.nonce, cap)).toBe(false);
    const orig = await confirmationCodes({ capsuleId: cap, giver: p.giver, member: p.member });
    for (const swapped of [
      { giver: p.giver, member: { ...p.member, x25519: other.x25519 } },
      { giver: p.giver, member: { ...p.member, ed25519: other.ed25519 } },
      { giver: { ...p.giver, ephemeral: (await newHandoffKeys()).ephemeral }, member: p.member },
      { giver: { ...p.giver, x25519: other.x25519 }, member: p.member },
    ]) {
      const c = await confirmationCodes({ capsuleId: cap, ...swapped });
      expect(c.member).not.toBe(orig.member); expect(c.giver).not.toBe(orig.giver);
    }
  });
  test("使い捨ての鍵で包んだ旅行の鍵を、席の秘密鍵と ephemeral で開ける", async () => {
    const seat = await newSeatKeys(), trip = await newTripKey(), h = await newHandoffKeys();
    const { wrapped, ephemeral } = await wrapTripKey(trip, (await seatPublic(seat)).x25519, cap, 1, h.pair);
    expect(ephemeral).toBe(h.ephemeral);
    const opened = await unwrapTripKey(wrapped, ephemeral, seat.x25519.privateKey, cap, 1);
    expect(await open(opened, await seal(trip, "鍵", "a"), "a")).toBe("鍵");
    await expect(crypto.subtle.exportKey("pkcs8", h.pair.privateKey)).rejects.toThrow();
  });
  test("辺: 署名 → 確かめる。別のカプセル・席・公開鍵では偽", async () => {
    const mine = await newSeatKeys(), mePub = await seatPublic(mine), other = { seat: "s2", ...(await seatPublic(await newSeatKeys())) };
    const sig = await signEdge(mine.ed25519.privateKey, other, cap);
    expect(Buffer.from(sig, "base64url").length).toBe(64);
    expect(await verifyEdge(mePub.ed25519, sig, other, cap)).toBe(true);
    expect(await verifyEdge(mePub.ed25519, sig, other, "trip-b")).toBe(false);
    expect(await verifyEdge(mePub.ed25519, sig, { ...other, seat: "s3" }, cap)).toBe(false);
    expect(await verifyEdge(mePub.ed25519, sig, { ...other, x25519: (await seatPublic(await newSeatKeys())).x25519 }, cap)).toBe(false);
    expect(await verifyEdge((await seatPublic(await newSeatKeys())).ed25519, sig, other, cap)).toBe(false);
  });
});

// A trip with every kind of record, its words marked so a leak shows in the stored JSON.
function fullTrip() {
  const t = testTrip();
  t.spec.presentation = { kicker: "見出しの言葉", postcardLabel: "絵はがき", postcardCaption: "添え書き", dayHeadings: [{ day: t.spec.trip.startsOn, title: "一日目の見出し" }], travelers: [{ name: "同行者の名前", note: "メモ" }] };
  t.document.items[0]!.place = { label: "駅前の広場", address: "港町1丁目", publicUrl: "https://example.com/plaza" };
  t.document.items[0]!.description = "集合の説明"; t.document.items[0]!.tags = ["タグ語"];
  t.document.suggestions = [{ id: "s1", author: "候補の人", body: "朝市に行きたい。".repeat(20), createdAt: "2026-09-20T00:00:00.000Z", promoted: false }];
  t.document.comments = [{ id: "m1", author: "相談の人", body: "相談の本文", createdAt: "2026-09-20T00:00:00.000Z" }];
  t.document.reflections = [{ id: "r1", author: "思い出の人", body: "思い出の本文", createdAt: "2026-09-26T00:00:00.000Z", included: true }];
  t.document.budget = [{ id: "b1", title: "宿代", amount: 98765, description: "費用の説明" }];
  t.document.notes = "旅のメモの本文";
  return t;
}
const words = ["テスト旅行", "行き先未定", "旅程", "見出しの言葉", "一日目の見出し", "同行者の名前", "集合", "駅前の広場", "example.com", "集合の説明", "タグ語", "候補の人", "朝市", "相談の本文", "思い出の本文", "宿代", "98765", "費用の説明", "旅のメモの本文", "集合場所を決める", "transport", "confirmed"];

describe("sealed trip records", () => {
  test("往復: sealTrip → openTrip gives the trip back, and the stored JSON holds none of its words", async () => {
    const key = await newTripKey(), t = fullTrip(), sealed = await sealTrip(key, "trip-a", 1, { ...t, previous: { spec: t.spec, document: { items: t.document.items, notes: t.document.notes, checklist: t.document.checklist, budget: t.document.budget }, revisedIds: { suggestions: ["s1"], comments: [] } } });
    const stored = JSON.stringify(sealed);
    for (const w of words) expect(stored).not.toContain(w);
    const p = sealed.spec.presentation!, post = sealed.document.suggestions[0]!, line = sealed.document.budget[0]!;
    for (const c of [sealed.spec.title, sealed.spec.summary!, sealed.spec.trip.destinations, ...sealed.spec.modules.map(m => m.label), p.kicker, p.postcardLabel, p.postcardCaption, p.dayHeadings[0]!.title, p.travelers, ...sealed.document.items.map(i => i.sealed), post.author, post.body, sealed.document.comments[0]!.body, sealed.document.reflections[0]!.author, ...sealed.document.checklist.map(c => c.title), sealed.document.notes, line.title, line.amount, line.description, sealed.previous!.spec.title]) expect(c).toMatch(/^v1\.1\.[A-Za-z0-9_-]+$/);
    // What the host works with stays plain.
    expect(sealed.document.items[2]).toMatchObject({ id: "walk", day: t.document.items[2]!.day, startsAt: t.document.items[2]!.startsAt, timeTentative: true, revision: 1 });
    expect(sealed.previous!.revisedIds).toEqual({ suggestions: ["s1"], comments: [] });
    expect(sealed.spec.timezone).toBe("Asia/Tokyo"); expect(sealed.spec.presentation!.dayHeadings[0]!.day).toBe(t.spec.trip.startsOn);
    const opened = await openTrip(key, "trip-a", sealed);
    expect(opened).toEqual({ spec: t.spec, document: t.document, unreadable: [] });
  });
  test("入れ替え: ciphertext moved to another record, field or trip does not open", async () => {
    const key = await newTripKey(), t = fullTrip(), sealed = await sealTrip(key, "trip-a", 1, t);
    const other = await sealTrip(key, "trip-b", 1, t);
    const moved = structuredClone(sealed);
    moved.document.items[1]!.sealed = sealed.document.items[0]!.sealed;          // another item
    moved.document.comments[0]!.body = sealed.document.suggestions[0]!.body;     // another field of another record
    moved.document.checklist[0]!.title = other.document.checklist[0]!.title;    // the same record of another trip
    moved.document.suggestions[0]!.author = sealed.document.suggestions[0]!.body; // another field of the same record
    moved.document.budget[0]!.title = sealed.document.budget[0]!.description;    // the same, in a budget line
    const opened = (await openTrip(key, "trip-a", moved))!;
    expect(opened.unreadable.sort()).toEqual(["budget/b1", "checklist/c1", "comment/m1", "item/dinner", "suggestion/s1"]);
    // An item's ciphertext put into the same item of another trip does not open there either.
    const elsewhere = structuredClone(other); elsewhere.document.items[0]!.sealed = sealed.document.items[0]!.sealed;
    expect((await openTrip(key, "trip-b", elsewhere))!.unreadable).toEqual(["item/arrival"]);
    expect(opened.document.items.map(i => i.id)).toEqual(["arrival", "walk"]);
    expect(opened.document.suggestions).toEqual([]); expect(opened.document.budget).toEqual([]);
    // The Spec of another trip, or another key, does not open at all.
    expect(await openTrip(key, "trip-a", { spec: { ...sealed.spec, title: other.spec.title }, document: sealed.document })).toBeNull();
    expect(await openTrip(await newTripKey(), "trip-a", sealed)).toBeNull();
    // Without a generation it is not a trip's ciphertext.
    await expect(openField(key, "trip-a", "notes", "notes", "body", sealed.document.notes.replace(/^v1\.1\./, "v1."))).rejects.toThrow();
  });
  test("危ない URL: a link that is not public https is dropped after opening; words past the limits are left out", async () => {
    const key = await newTripKey(), t = fullTrip();
    t.document.items[0]!.place!.publicUrl = "javascript:alert(1)";
    t.document.items[1]!.place = { label: "店", publicUrl: "http://example.com/" };
    t.document.comments[0]!.body = "長".repeat(4001);
    const opened = (await openTrip(key, "trip-a", await sealTrip(key, "trip-a", 1, t)))!;
    expect(opened.document.items[0]!.place).toEqual({ label: "駅前の広場", address: "港町1丁目" });
    expect(opened.document.items[1]!.place).toEqual({ label: "店" });
    expect(opened.unreadable).toEqual(["comment/m1"]); expect(opened.document.comments).toEqual([]);
  });
  test("操作: sealOperation checks the plain words, then seals them into the sealed form", async () => {
    const key = await newTripKey(), t = fullTrip(), doc: Document = t.document;
    const ops = [
      { type: "suggest", author: "A", body: "朝市" }, { type: "comment", author: "A", body: "相談" }, { type: "reflect", author: "A", body: "思い出" },
      { type: "rewrite", list: "suggestions", id: "s1", body: "夜市" }, { type: "check", id: "c1", done: true }, { type: "include", id: "r1", included: false },
      { type: "item", item: { id: "new1", kind: "meal", status: "proposed", title: "昼食", day: doc.items[0]!.day, revision: 1 }, after: "arrival" },
      { type: "promote", id: "s1", day: doc.items[0]!.day }, { type: "notes", body: "メモ" }, { type: "move", id: "walk", before: null },
      { type: "checklist", checklist: [{ id: "c1", title: "傘" }] }, { type: "budget", budget: [{ id: "b1", title: "宿", amount: 1000, description: "" }] },
      { type: "remove", list: "comments", id: "m1" },
    ];
    for (const op of ops) {
      const out = await sealOperation(key, "trip-a", 1, op, doc);
      expect(sealedOperationSchema.safeParse(out).success).toBe(true);
      for (const w of ["朝市", "夜市", "昼食", "メモ", "傘", "1000", "思い出"]) expect(JSON.stringify(out)).not.toContain(w);
    }
    const post = await sealOperation(key, "trip-a", 1, { type: "suggest", author: "A", body: "朝市" }, doc) as { id: string; body: string };
    expect(post.id).toMatch(/^[0-9a-f]{32}$/);
    expect(await openField(key, "trip-a", "suggestion", post.id, "body", post.body)).toBe("朝市");
    const promoted = await sealOperation(key, "trip-a", 1, { type: "promote", id: "s1", day: doc.items[0]!.day }, doc) as { item: { id: string; sealed: string } };
    expect(JSON.parse(await openField(key, "trip-a", "item", promoted.item.id, "sealed", promoted.item.sealed))).toEqual({ kind: "activity", status: "confirmed", title: doc.suggestions[0]!.body.slice(0, 80), description: doc.suggestions[0]!.body });
    // An id with spaces around it is sealed as the plain shape reads it, and opens there.
    const listed = await sealOperation(key, "trip-a", 1, { type: "checklist", checklist: [{ id: " c9 ", title: " 傘 " }] }, doc) as { checklist: Array<{ id: string; title: string }> };
    expect(listed.checklist[0]!.id).toBe("c9");
    expect(await openField(key, "trip-a", "checklist", "c9", "title", listed.checklist[0]!.title)).toBe("傘");
    // Words the plain trip would refuse are refused before sealing.
    await expect(sealOperation(key, "trip-a", 1, { type: "item", item: { id: "x", kind: "meal", status: "proposed", title: "店", day: doc.items[0]!.day, revision: 1, place: { label: "店", publicUrl: "http://example.com/" } } }, doc)).rejects.toThrow();
    await expect(sealOperation(key, "trip-a", 1, { type: "checklist", checklist: [{ id: "c1", title: "" }] }, doc)).rejects.toThrow();
    await expect(sealOperation(key, "trip-a", 1, { type: "budget", budget: [{ id: "b1", title: "宿", amount: -1, description: "" }] }, doc)).rejects.toThrow();
    await expect(sealOperation(key, "trip-a", 1, { type: "promote", id: "nope", day: doc.items[0]!.day }, doc)).rejects.toThrow();
  });
});
