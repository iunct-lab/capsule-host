import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "./schema";
import { emptyTrip } from "./template";
import { testTrip } from "./test-fixture";
import { check, publishHash } from "./validate";
import { CloudHost } from "./cloud-host";
import { LocalD1 } from "./local-d1";

const origin = "https://capsule.example";

const now = +new Date("2026-09-01T00:00:00Z");
const failed = (input: unknown) => { const r = check(input, now); if (r.ok) throw new Error("expected errors"); return r.errors; };

test("a valid trip is ok, with the summary a person approves", () => {
  const r = check({ schemaVersion: 1, ...testTrip() }, now);
  expect(r).toMatchObject({ ok: true, title: "テスト旅行", purgeAt: "2026-10-26T00:00:00+09:00", items: 3 });
});

test("the CLI's approved hash and the host's publishHash come from the same fingerprint", async () => {
  const trip = testTrip(), fingerprint = publishHash(validate(trip.spec, trip.document, now)), r = check(trip, now);
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  // What `bun run validate` and aws/publish.ts show is what the Host keeps to tell a retry from a different trip.
  expect(r.ok && r.sha256).toBe(fingerprint);
  const db = new LocalD1(), host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: origin }, () => now, async () => "creator-1");
  try {
    const published = await host.fetch(new Request(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...trip, confirm: true, operationId: "0123456789abcdef".repeat(2) }) }));
    expect(published.status).toBe(201);
    const [row] = db.db.query("SELECT payload FROM trip_capsules").all() as Array<{ payload: string }>;
    expect(JSON.parse(row!.payload).publishHash).toBe(fingerprint);
  } finally { db.close(); }
});

test("an end date before the start date is reported with its reason", () => {
  const trip = testTrip(); trip.spec.trip.endsOn = "2026-09-23";
  expect(failed(trip)).toContainEqual({ path: "spec", message: "旅行期間と削除期限の順序が不正です" });
});

test("a structural error names the path of the field", () => {
  const trip = testTrip(); trip.spec.theme.accent = "red";
  expect(failed(trip).map(e => e.path)).toEqual(["spec.theme.accent"]);
});

test("errors in the spec and in the document are reported together", () => {
  const trip = testTrip(); trip.spec.theme.accent = "red"; trip.document.items[0]!.title = "";
  expect(failed(trip).map(e => e.path)).toEqual(["spec.theme.accent", "document.items.0.title"]);
});

test("an item outside the trip is a cross-field error without a path", () => {
  const trip = testTrip(); trip.document.items[0]!.day = "2026-09-27"; delete trip.document.items[0]!.startsAt;
  expect(failed(trip)).toEqual([{ path: "", message: "旅程の日付・時刻が旅行期間と一致しません" }]);
});

test("trip-map: accepted with or without showPhotos, and showTrack false shows points only", () => {
  const trip = testTrip();
  trip.spec.modules.push({ id: "track", kind: "trip-map", label: "足あとの地図", showTrack: true }); trip.spec.navigation.push("track");
  expect(check(trip, now)).toMatchObject({ ok: true });
  trip.spec.modules[trip.spec.modules.length - 1] = { id: "track", kind: "trip-map", label: "足あとの地図", showPhotos: true, showTrack: true };
  expect(check(trip, now)).toMatchObject({ ok: true });
  trip.spec.modules[trip.spec.modules.length - 1] = { id: "track", kind: "trip-map", label: "足あとの地図", showPhotos: false, showTrack: false };
  expect(check(trip, now)).toMatchObject({ ok: true });
});

test("story: a story module is accepted", () => {
  const trip = testTrip();
  trip.spec.modules = trip.spec.modules.filter(m => m.kind !== "story"); trip.spec.navigation = trip.spec.navigation.filter(id => id !== "story");
  trip.spec.modules.push({ id: "record", kind: "story", label: "旅の記録" }); trip.spec.navigation.push("record");
  expect(check(trip, now)).toMatchObject({ ok: true });
});

test("an item's place may carry a latitude and longitude, both or neither", () => {
  const tripWith = (place: object) => { const t = testTrip(); t.document.items[0]!.place = place as never; return t; };
  const withPlace = (place: object) => failed(tripWith(place));
  expect(check(tripWith({ label: "駅", lat: 35.68, lng: 139.77 }), now)).toMatchObject({ ok: true });
  expect(check(tripWith({ label: "駅", lat: -90, lng: -180 }), now)).toMatchObject({ ok: true });
  expect(withPlace({ label: "駅", lat: 90.5, lng: 139.77 }).map(e => e.path)).toEqual(["document.items.0.place.lat"]);
  expect(withPlace({ label: "駅", lat: 35.68, lng: 181 }).map(e => e.path)).toEqual(["document.items.0.place.lng"]);
  expect(withPlace({ label: "駅", lat: 35.68 }).map(e => e.path)).toEqual(["document.items.0.place"]);
  expect(withPlace({ label: "駅", lng: 139.77 }).map(e => e.path)).toEqual(["document.items.0.place"]);
});

test("a malformed URL is a path, not a crash", () => {
  const trip = testTrip(); trip.document.items[0]!.place = { label: "駅", publicUrl: "not a url" };
  expect(failed(trip).map(e => e.path)).toContain("document.items.0.place.publicUrl");
});

test("a rejected value is not repeated in the output", () => {
  const trip = testTrip(); (trip.spec as { locale: string }).locale = "AB12-RESERVATION";
  expect(failed(trip)).toEqual([{ path: "spec.locale", message: "次のいずれかを指定してください: ja | en" }]);
});

test("input that is not { spec, document } is an error, not a throw", () => {
  expect(failed("{ not json")[0]!.path).toBe("");
  expect(failed(null)[0]!.path).toBe("");
  expect(failed({ spec: testTrip().spec }).map(e => e.path)).toEqual(["document"]);
});

test("the command prints JSON and exits 0 for a valid file, 1 for an invalid one, 2 without a file", async () => {
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", `${import.meta.dir}/validate.ts`, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, out: await new Response(p.stdout).text() };
  };
  const dir = `${process.env.TMPDIR ?? "/tmp"}/capsule-validate-${process.pid}`, good = `${dir}/good.json`, bad = `${dir}/bad.json`, text = `${dir}/text.json`;
  // The command checks against the real clock: purgeAt must be within 180 days of today.
  const trip = emptyTrip(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  await Bun.write(good, JSON.stringify({ schemaVersion: 1, ...trip }));
  trip.spec.theme.accent = "red"; await Bun.write(bad, JSON.stringify(trip));
  await Bun.write(text, "{ not json");
  const ok = await run(good); expect(ok.code).toBe(0); expect(JSON.parse(ok.out).ok).toBe(true);
  const ng = await run(bad); expect(ng.code).toBe(1); expect(JSON.parse(ng.out).errors[0].path).toBe("spec.theme.accent");
  const nj = await run(text); expect(nj.code).toBe(1); expect(JSON.parse(nj.out).ok).toBe(false);
  expect((await run()).code).toBe(2);
  await rm(dir, { recursive: true });
});

test("a new trip has a time on every item: one without is reported at its startsAt, unless a trip published before is revised", () => {
  const trip = testTrip(); delete trip.document.items[1]!.startsAt;
  expect(failed(trip)).toEqual([{ path: "document.items.1.startsAt", message: "開始時刻を書いてください（決まっていなければ妥当な時刻と timeTentative: true）" }]);
  expect(check(trip, now, { allowUntimed: ["dinner"] })).toMatchObject({ ok: true, items: 3 });
  expect(check(trip, now, { allowUntimed: ["walk"] })).toMatchObject({ ok: false, errors: [{ path: "document.items.1.startsAt" }] });
  // A time marked as a placeholder is a time.
  expect(check(testTrip(), now)).toMatchObject({ ok: true });
});

test("both publish commands refuse an item without a time before anything is sent or written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capsule-untimed-")), file = join(dir, "trip.json"), trip = testTrip(); delete trip.document.items[1]!.startsAt;
  await writeFile(file, JSON.stringify(trip));
  try {
    for (const command of [["src/publish.ts", "--input", file], ["aws/publish.ts", file, "no-function", "no-profile"]]) {
      const run = Bun.spawnSync(["bun", ...command], { cwd: `${import.meta.dir}/..`, env: { ...process.env, CAPSULE_DATA_DIR: dir } });
      expect(run.exitCode).not.toBe(0); expect(run.stderr.toString()).toContain("開始時刻の無い予定があります: document.items.1.startsAt");
    }
    expect((await readdir(dir)).sort()).toEqual(["trip.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
