import { describe, expect, test } from "bun:test";
import { open, seal } from "./private-entries";
import { testTrip } from "./test-fixture";
import { sealedOperationSchema, type Document } from "./schema";
import { openPhotoImage, openPhotoLocation, sealPhoto, confirmationCodes, openField, openName, openPoint, openTrip, sealField, sealName, sealPoint, resealTrip, sealOperation, sealTrip, sealMove, matchesCommitment, newAttempt, newHandoffKeys, newSeatKeys, newTripKey, signEdge, verifyEdge, seatPublic, unwrapSeatSecret, unwrapTripKey, wrapSeatSecret, wrapTripKey, acceptRekey, reachableSeats, resealAll, signRekey, signSuccession, type KeyedSeat, type SeatKeys } from "./trip-keys";

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

describe("確認コードの受け渡し（spec「5.1 旅行の鍵と受け渡し」）", () => {
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
  test("reseal keeps unchanged records", async () => {
    const key = await newTripKey(), t = fullTrip(), sealed = await sealTrip(key, "trip-a", 1, t);
    sealed.document.suggestions[0]!.seat = "seat-a";
    // The answer writes the item's fields in another order and changes one item's title only.
    const next = structuredClone(t); next.document.items = next.document.items.map(i => i.id === "walk" ? { ...i, title: "別の散歩" } : Object.fromEntries(Object.entries(i).reverse()) as typeof i);
    const again = await resealTrip(key, "trip-a", 1, [sealed], next);
    const fields = (x: typeof sealed) => JSON.stringify(x, (k, v) => k === "items" ? v.map((i: { id: string; sealed: string }) => i.id === "walk" ? "" : i.sealed) : v);
    expect(fields(again)).toBe(fields(sealed));
    expect(again.document.items.find(i => i.id === "walk")!.sealed).not.toBe(sealed.document.items.find(i => i.id === "walk")!.sealed);
    expect((await openTrip(key, "trip-a", again))!.document.items.find(i => i.id === "walk")!.title).toBe("別の散歩");
    // A record found in a later `from` keeps that one's ciphertext; a new post has no seat, the host gives it one.
    const step = await sealTrip(key, "trip-a", 1, { spec: { ...t.spec, title: "前の題" }, document: t.document });
    next.document.suggestions.push({ id: "s2", author: "新しい人", body: "新しい候補", createdAt: "2026-09-21T00:00:00.000Z", promoted: false });
    const back = await resealTrip(key, "trip-a", 1, [sealed, step], { ...next, spec: { ...t.spec, title: "前の題" } });
    expect(back.spec.title).toBe(step.spec.title); expect(back.spec.summary).toBe(sealed.spec.summary);
    expect(back.document.suggestions.map(x => x.seat)).toEqual(["seat-a", undefined]);
    // Ids are unique within a list only: a comment with a suggestion's id keeps its own seat, not the suggestion's.
    const twin = structuredClone(t); twin.document.comments[0]!.id = "s1";
    const both = await sealTrip(key, "trip-a", 1, twin); both.document.suggestions[0]!.seat = "seat-a"; both.document.comments[0]!.seat = "seat-b";
    const kept = await resealTrip(key, "trip-a", 1, [both], twin);
    expect([kept.document.suggestions[0]!.seat, kept.document.comments[0]!.seat]).toEqual(["seat-a", "seat-b"]);
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

describe("sealed footprints and names", () => {
  const at = { lat: 35.6812, lng: 139.7671, accuracy: 12 };
  test("足あとの往復: sealPoint → openPoint gives the point back, and the ciphertext holds no coordinate", async () => {
    const key = await newTripKey(), sealed = await sealPoint(key, "trip-a", 1, "fp1", at);
    expect(sealed).toMatch(/^v1\.1\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("35.6812");
    expect(await openPoint(key, "trip-a", "fp1", sealed)).toEqual(at);
  });
  test("足あとの範囲: a point out of range is not sealed, and one sealed directly does not open", async () => {
    const key = await newTripKey();
    for (const bad of [{ ...at, lat: 91 }, { ...at, lng: -181 }, { ...at, accuracy: 1001 }]) {
      await expect(sealPoint(key, "trip-a", 1, "fp1", bad)).rejects.toThrow();
      expect(await openPoint(key, "trip-a", "fp1", await sealField(key, "trip-a", 1, "footprint", "fp1", "point", JSON.stringify(bad)))).toBeNull();
    }
    expect(await openPoint(key, "trip-a", "fp1", await sealField(key, "trip-a", 1, "footprint", "fp1", "point", "not json"))).toBeNull();
  });
  test("足あとの入れ替え: a point moved to another footprint, trip or field does not open", async () => {
    const key = await newTripKey(), sealed = await sealPoint(key, "trip-a", 1, "fp1", at);
    expect(await openPoint(key, "trip-a", "fp2", sealed)).toBeNull();
    expect(await openPoint(key, "trip-b", "fp1", sealed)).toBeNull();
    expect(await openName(key, "trip-a", "footprint", "fp1", sealed)).toBeNull();
    expect(await openPoint(key, "trip-a", "fp1", await sealName(key, "trip-a", 1, "footprint", "fp1", "花子"))).toBeNull();
    expect(await openPoint(await newTripKey(), "trip-a", "fp1", sealed)).toBeNull();
  });
  test("名前: sealName → openName, bound to its seat or invite; the host's plain names pass through", async () => {
    const key = await newTripKey(), sealed = await sealName(key, "trip-a", 1, "member", "seat1", "  花子  ");
    expect(sealed).not.toContain("花子");
    expect(await openName(key, "trip-a", "member", "seat1", sealed)).toBe("花子");
    expect(await openName(key, "trip-a", "grant", "seat1", sealed)).toBeNull();
    expect(await openName(key, "trip-a", "member", "seat2", sealed)).toBeNull();
    expect(await openName(key, "trip-a", "footprint", "fp1", await sealName(key, "trip-a", 1, "footprint", "fp1", "太郎"))).toBe("太郎");
    for (const plain of ["メンバー3", "自分用", "招待リンク", "オーナー"]) expect(await openName(key, "trip-a", "member", "seat1", plain)).toBe(plain);
    await expect(sealName(key, "trip-a", 1, "grant", "g1", "あ".repeat(81))).rejects.toThrow("名前は1〜80字です");
    await expect(sealName(key, "trip-a", 1, "grant", "g1", "   ")).rejects.toThrow("名前は1〜80字です");
    expect(await openName(key, "trip-a", "grant", "g1", await sealField(key, "trip-a", 1, "grant", "g1", "label", "あ".repeat(81)))).toBeNull();
  });
});

describe("move", () => {
  const plain = () => {
    const t = fullTrip();
    return {
      spec: t.spec, document: t.document,
      previous: { spec: { ...t.spec, title: "前の題の言葉" }, document: { items: t.document.items, notes: "前のメモの言葉", checklist: t.document.checklist, budget: t.document.budget }, revisedIds: { suggestions: ["s1"], comments: [] } },
      footprints: [{ id: "fp1", lat: 35.6812, lng: 139.7671, accuracy: 12, by: "足あとの人" }, { id: "fp2", lat: -33.8568, lng: 151.2153, accuracy: 30, by: "オーナー" }],
      grants: [
        { id: "g-own", label: "自分用", members: [{ id: "seat-o", label: "オーナー" }] },
        { id: "g-a", label: "家族への招待", members: [{ id: "seat-a", label: "名前を変えた人" }, { id: "seat-b", label: "メンバー2" }] },
        { id: "g-b", label: "招待リンク", members: [] },
      ],
    };
  };
  test("往復: sealMove → openTrip, openPoint and openName give the trip back", async () => {
    const key = await newTripKey(), input = plain(), body = await sealMove(key, "trip-a", 1, input);
    expect(body).toMatchObject({ generation: 1, confirm: true });
    expect(await openTrip(key, "trip-a", body)).toEqual({ spec: input.spec, document: input.document, unreadable: [] });
    const prev = (await openTrip(key, "trip-a", { spec: body.previous!.spec, document: { ...body.document, ...body.previous!.document } }))!;
    expect(prev.spec.title).toBe("前の題の言葉"); expect(prev.document.notes).toBe("前のメモの言葉");
    expect(body.previous!.revisedIds).toEqual({ suggestions: ["s1"], comments: [] });
    expect(body.footprints.map(p => p.id)).toEqual(["fp1", "fp2"]);
    for (const [i, p] of body.footprints.entries()) {
      const { id, by, ...point } = input.footprints[i]!;
      expect(await openPoint(key, "trip-a", id, p.point)).toEqual(point);
      expect(await openName(key, "trip-a", "footprint", id, p.by)).toBe(by);
    }
    expect(Object.keys(body.members).sort()).toEqual(["seat-a", "seat-b", "seat-o"]);
    for (const m of input.grants.flatMap(g => g.members)) expect(await openName(key, "trip-a", "member", m.id, body.members[m.id]!)).toBe(m.label);
    expect(await openName(key, "trip-a", "grant", "g-a", body.grants["g-a"]!)).toBe("家族への招待");
  });
  test("平文が無い: none of the trip's words, points or names are in the body, but the host's invite names", async () => {
    const body = await sealMove(await newTripKey(), "trip-a", 1, plain()), stored = JSON.stringify(body);
    for (const w of [...words, "前の題の言葉", "前のメモの言葉", "35.6812", "139.7671", "足あとの人", "名前を変えた人", "家族への招待", "オーナー", "メンバー2"]) expect(stored).not.toContain(w);
    expect(body.grants).toMatchObject({ "g-own": "自分用", "g-b": "招待リンク" });
  });
  test("previous を捨てる: with dropPrevious or no previous, the body has no previous", async () => {
    const key = await newTripKey();
    expect("previous" in await sealMove(key, "trip-a", 1, plain(), { dropPrevious: true })).toBe(false);
    expect("previous" in await sealMove(key, "trip-a", 1, { ...plain(), previous: null })).toBe(false);
  });
  test("範囲の外: a footprint out of range is not sealed", async () => {
    const input = plain(); input.footprints[0]!.lat = 91;
    await expect(sealMove(await newTripKey(), "trip-a", 1, input)).rejects.toThrow("Too big: expected number to be <=90");
  });
});

describe("rekey", () => {
  const cap = "trip-a";
  const generations = (v: unknown) => [...JSON.stringify(v).matchAll(/v1\.(\d+)\./g)].map(m => m[1]);
  // A seat with its own keys, edges to sign later, and its public form as GET "" lists it.
  type Seat = { id: string; role: KeyedSeat["role"]; keys: SeatKeys; pub: { x25519: string; ed25519: string }; edges: KeyedSeat["edges"]; since?: KeyedSeat["since"] };
  const seat = async (id: string, role: KeyedSeat["role"] = "participant"): Promise<Seat> => { const keys = await newSeatKeys(); return { id, role, keys, pub: await seatPublic(keys), edges: [] }; };
  const edge = async (from: Seat, to: Seat) => { from.edges.push({ seat: to.id, signature: await signEdge(from.keys.ed25519.privateKey, { seat: to.id, ...to.pub }, cap) }); };
  const root = (s: Seat) => ({ id: s.id, ed25519: s.pub.ed25519 });
  const listed = (...seats: Seat[]): KeyedSeat[] => seats.map(s => ({ id: s.id, role: s.role, ...s.pub, edges: s.edges.map(e => ({ ...e })), ...(s.since ? { since: { ...s.since } } : {}) }));
  // The pair made again, as after a passkey registered later: `since` signed with the old key, and its own edges signed anew.
  const remake = async (s: Seat, others: Seat[]) => {
    const keys = await newSeatKeys(), pub = await seatPublic(keys);
    s.since = await signSuccession(s.keys.ed25519.privateKey, s.pub, { capsuleId: cap, seat: s.id, ...pub });
    s.keys = keys; s.pub = pub; s.edges = [];
    for (const o of others) await edge(s, o);
  };

  test("世代: resealAll seals everything under the next generation, and the old key opens none of it", async () => {
    const oldKey = await newTripKey(), newKey = await newTripKey(), t = fullTrip();
    const sealed = await sealTrip(oldKey, cap, 1, t);
    sealed.document.suggestions[0]!.seat = "seat-a";
    const footprints = [{ id: "fp1", point: await sealPoint(oldKey, cap, 1, "fp1", { lat: 35.6812, lng: 139.7671, accuracy: 12 }), by: await sealName(oldKey, cap, 1, "footprint", "fp1", "足あとの人") }];
    const members = [{ id: "seat-o", label: await sealName(oldKey, cap, 1, "member", "seat-o", "オーナーの名前") }, { id: "seat-b", label: "メンバー2" }];
    const grants = [{ id: "g-own", label: "自分用" }, { id: "g-a", label: await sealName(oldKey, cap, 1, "grant", "g-a", "家族への招待") }];
    const out = await resealAll(oldKey, newKey, cap, 2, { ...sealed, footprints, members, grants });
    expect(generations(out).length).toBeGreaterThan(20);
    expect(new Set(generations(out))).toEqual(new Set(["2"]));
    expect("previous" in out).toBe(false);
    expect(await openTrip(newKey, cap, out)).toEqual({ spec: t.spec, document: t.document, unreadable: [] });
    expect(out.document.suggestions[0]!.seat).toBe("seat-a");
    expect(await openPoint(newKey, cap, "fp1", out.footprints[0]!.point)).toEqual({ lat: 35.6812, lng: 139.7671, accuracy: 12 });
    expect(await openName(newKey, cap, "footprint", "fp1", out.footprints[0]!.by)).toBe("足あとの人");
    expect(await openName(newKey, cap, "member", "seat-o", out.members[0]!.label)).toBe("オーナーの名前");
    expect(out.members[1]).toEqual({ id: "seat-b", label: "メンバー2" });
    expect(out.grants[0]).toEqual({ id: "g-own", label: "自分用" });
    expect(await openName(newKey, cap, "grant", "g-a", out.grants[1]!.label)).toBe("家族への招待");
    // The old generation's key, as a revoked member's browser keeps it, opens nothing new.
    await expect(openField(oldKey, cap, "notes", "notes", "body", out.document.notes)).rejects.toThrow();
    await expect(openField(oldKey, cap, "item", out.document.items[0]!.id, "sealed", out.document.items[0]!.sealed)).rejects.toThrow();
    expect(await openTrip(oldKey, cap, out)).toBeNull();
    expect(await openPoint(oldKey, cap, "fp1", out.footprints[0]!.point)).toBeNull();
    // What does not open with the old key stops the replacement rather than vanish.
    const broken = structuredClone(sealed); broken.document.notes = await sealField(newKey, cap, 1, "notes", "notes", "body", "別の鍵");
    await expect(resealAll(oldKey, newKey, cap, 2, { ...broken, footprints, members, grants })).rejects.toThrow("開けない記録があります（1 件）");
    await expect(resealAll(oldKey, newKey, cap, 2, { ...sealed, footprints: [{ ...footprints[0]!, point: await sealPoint(newKey, cap, 1, "fp1", { lat: 1, lng: 1, accuracy: 1 }) }], members, grants })).rejects.toThrow("開けない記録があります（1 件）");
    await expect(resealAll(await newTripKey(), newKey, cap, 2, { ...sealed, footprints, members, grants })).rejects.toThrow("旅程を開けません");
  });

  test("たどる: edges lead from the root while their signatures hold, through `since` for one generation of pairs", async () => {
    const owner = await seat("o", "owner"), a = await seat("a"), c = await seat("c");
    await edge(owner, a); await edge(a, c);
    expect([...await reachableSeats(root(owner), listed(owner, a, c), cap)].sort()).toEqual(["a", "c", "o"]);
    // A revoked seat is not passed through, and an unknown root reaches nothing.
    expect([...await reachableSeats(root(owner), listed(owner, c), cap)]).toEqual(["o"]);
    expect(await reachableSeats({ id: "x", ed25519: owner.pub.ed25519 }, listed(owner, a, c), cap)).toEqual(new Set());
    // One character of a signature changed breaks the edge.
    const tampered = listed(owner, a, c); const sig = tampered[0]!.edges[0]!.signature;
    tampered[0]!.edges[0]!.signature = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect([...await reachableSeats(root(owner), tampered, cap)]).toEqual(["o"]);
    // A's pair made again: owner's edge was signed over A's old keys, and `since` carries it on; A's own edges are signed anew.
    await remake(a, [c]);
    expect([...await reachableSeats(root(owner), listed(owner, a, c), cap)].sort()).toEqual(["a", "c", "o"]);
    // A `since` not signed by the old key does not.
    const forged = listed(owner, a, c); forged[1]!.since!.signature = (await signSuccession((await newSeatKeys()).ed25519.privateKey, a.since!, { capsuleId: cap, seat: "a", ...a.pub })).signature;
    expect([...await reachableSeats(root(owner), forged, cap)]).toEqual(["o"]);
    // Made again twice: `since` names only the pair before, so owner's edge over the first pair no longer leads to A.
    await remake(a, [c]);
    expect([...await reachableSeats(root(owner), listed(owner, a, c), cap)]).toEqual(["o"]);
  });

  test("owner 以外の世代: a member's browser takes a new generation only when an owner seat it reaches signed that wrap", async () => {
    const owner = await seat("o", "owner"), a = await seat("a"), b = await seat("b"), stranger = await seat("s", "owner");
    await edge(owner, a); await edge(a, owner); await edge(a, b); await edge(b, a);
    const seats = listed(owner, a, b, stranger), trip = await newTripKey();
    const wrapTo = async (to: Seat, signer: Seat, generation = 2) => {
      const w = await wrapTripKey(trip, to.pub.x25519, cap, generation);
      return { generation, ...w, x25519: to.pub.x25519, rekey: { seat: signer.id, signature: await signRekey(signer.keys.ed25519.privateKey, { capsuleId: cap, generation, seat: to.id, x25519: to.pub.x25519, ...w }) } };
    };
    const accept = (self: Seat, seatKey: Awaited<ReturnType<typeof wrapTo>> | Omit<Awaited<ReturnType<typeof wrapTo>>, "rekey">, known = 1, list = seats) => acceptRekey({ self: root(self), known, capsuleId: cap, seats: list, seatKey });
    expect(await accept(b, await wrapTo(b, owner))).toBe(true);
    expect(await accept(owner, await wrapTo(owner, owner))).toBe(true);
    // Signed by a participant, by an owner seat B does not reach (the operator's own, as after /recover), or by nobody.
    expect(await accept(b, await wrapTo(b, a))).toBe(false);
    expect(await accept(b, await wrapTo(b, stranger))).toBe(false);
    const { rekey: _, ...unsigned } = await wrapTo(b, owner);
    expect(await accept(b, unsigned)).toBe(false);
    // The wrap changed after the owner signed it.
    const swapped = await wrapTo(b, owner); swapped.wrapped = (await wrapTripKey(await newTripKey(), b.pub.x25519, cap, 2)).wrapped;
    expect(await accept(b, swapped)).toBe(false);
    // The owner reached only through A: once A is gone, B does not take it.
    expect(await accept(b, await wrapTo(b, owner), 1, listed(owner, b, stranger))).toBe(false);
    // The host lists B's seat with another key and edges it signed itself, to an owner seat of its own: B starts from the key it holds.
    const forger = await seat("b"), fakeOwner = await seat("f", "owner"); await edge(forger, fakeOwner);
    const forgedList = [...listed(owner, a, fakeOwner), ...listed(forger)];
    expect([...await reachableSeats(root(b), forgedList, cap)]).toEqual(["b"]);
    expect(await accept(b, await wrapTo(b, fakeOwner), 1, forgedList)).toBe(false);
    // A generation already taken here is taken without a signature.
    expect(await accept(b, unsigned, 2)).toBe(true);
    expect(await accept(b, { ...unsigned, generation: 1 }, 1)).toBe(true);
  });
});

describe("photos", () => {
  const bytes = (n: number, v: number) => new Uint8Array(n).fill(v);
  test("sealed images open back under the photo's own key; the host sees only a length of the bytes plus 28", async () => {
    const trip = await newTripKey(), sealed = await sealPhoto(trip, "trip-a", 1, "p1", { display: bytes(5000, 1), thumb: bytes(900, 2), location: { lat: 35.6812, lng: 139.7671 } });
    expect(sealed.display.length).toBe(5028); expect(sealed.thumb.length).toBe(928);
    expect(sealed.key).toMatch(/^v1\.1\.[A-Za-z0-9_-]+$/); expect(sealed.key.length).toBeLessThanOrEqual(200); expect(sealed.location!.length).toBeLessThanOrEqual(300);
    expect(await openPhotoImage(trip, "trip-a", "p1", sealed.key, "display", sealed.display)).toEqual(bytes(5000, 1));
    expect(await openPhotoImage(trip, "trip-a", "p1", sealed.key, "thumb", sealed.thumb)).toEqual(bytes(900, 2));
    expect(await openPhotoLocation(trip, "trip-a", "p1", sealed.location!)).toEqual({ lat: 35.6812, lng: 139.7671 });
    expect(Buffer.from(sealed.display).includes(Buffer.from(bytes(64, 1)))).toBe(false);
  });
  test("another trip key, trip, photo or size opens none of it; two photos of the same bytes seal differently", async () => {
    const trip = await newTripKey(), sealed = await sealPhoto(trip, "trip-a", 1, "p1", { display: bytes(100, 1), thumb: bytes(100, 1) });
    await expect(openPhotoImage(await newTripKey(), "trip-a", "p1", sealed.key, "display", sealed.display)).rejects.toThrow();
    await expect(openPhotoImage(trip, "trip-b", "p1", sealed.key, "display", sealed.display)).rejects.toThrow();
    await expect(openPhotoImage(trip, "trip-a", "p2", sealed.key, "display", sealed.display)).rejects.toThrow();
    await expect(openPhotoImage(trip, "trip-a", "p1", sealed.key, "thumb", sealed.display)).rejects.toThrow();
    await expect(openPhotoImage(trip, "trip-a", "p1", sealed.key, "display", sealed.display.slice(0, 20))).rejects.toThrow();
    const other = await sealPhoto(trip, "trip-a", 1, "p3", { display: bytes(100, 1), thumb: bytes(100, 1) });
    expect(other.display).not.toEqual(sealed.display); expect(sealed).not.toHaveProperty("location");
    // The image is not under the trip's key: a new key seals `key` again and the image still opens.
    const next = await newTripKey(), again = await sealField(next, "trip-a", 2, "photo", "p1", "key", await openField(trip, "trip-a", "photo", "p1", "key", sealed.key));
    expect(await openPhotoImage(next, "trip-a", "p1", again, "display", sealed.display)).toEqual(bytes(100, 1));
  });
  test("a location out of range is refused to seal and left off when opened", async () => {
    const trip = await newTripKey();
    await expect(sealPhoto(trip, "trip-a", 1, "p1", { display: bytes(40, 1), thumb: bytes(40, 1), location: { lat: 91, lng: 0 } })).rejects.toThrow();
    const bad = await sealField(trip, "trip-a", 1, "photo", "p1", "location", '{"lat":200,"lng":0}');
    expect(await openPhotoLocation(trip, "trip-a", "p1", bad)).toBeNull(); expect(await openPhotoLocation(trip, "trip-a", "p2", await sealField(trip, "trip-a", 1, "photo", "p1", "location", '{"lat":1,"lng":2}'))).toBeNull();
  });
});
