import assert from "node:assert/strict";
import { invoke } from "./invoke";
import { emptyTrip } from "../src/template";
import { fakeAuthenticator, sealedRequests, sealedTrip, type CapsuleRequest } from "../src/test-fixture";

// Watches two disposable fictional capsules reach their deadline on the real stack: one left plain (its owner took the seat and
// never sealed it, as a trip published before sealing was handed out stays until its deadline), one sealed by its owner right
// after the seat was taken (as every trip is now) whose invite closes. Both answer 410, and the scheduled sweep erases the
// stored payloads. Takes about 12 minutes of wall clock, so it is NOT part of aws/verify.ts (that one runs on every deploy).
// Never prints capability links or cookies. Run from a country listed in ClaimCountries.
const [origin, functionName, profile, region, table] = process.argv.slice(2) as (string | undefined)[] as [string, string, string, string, string];
if (!origin || !functionName || !profile || !region || !table) throw new Error("Usage: bun aws/verify-expiry.ts https://DISTRIBUTION.cloudfront.net function profile region dynamodb-table");
const TITLE = "AWS期限確認用（自動削除）", PLAIN_TITLE = "AWS期限確認用・平文（自動削除）";
const at = () => new Date().toISOString().slice(11, 19) + "Z";
const log = (line: string) => console.log(`${at()}  ${line}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const day = (back: number) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
// A capsule's requests, as the new screen sends them (ui=2, src/client.ts api()): the host asks a request without it to reload.
const under = (id: string): CapsuleRequest => (path = "", method = "GET", body?, cookie?, revision = 1) => fetch(`${origin}/v1/c/${id}${path}?ui=2`, { method, headers: { Origin: origin, "Content-Type": "application/json", "If-Match": `"${revision}"`, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const redeem = (request: CapsuleRequest, url: string, cookie = "") => request("/sessions", "POST", { secret: new URLSearchParams(new URL(url).hash.slice(1)).get("k") }, cookie);
async function join(request: CapsuleRequest, url: string) {
  assert.equal(new URL(url).origin, origin);
  const r = await redeem(request, url); assert.equal(r.status, 200);
  return r.headers.get("Set-Cookie")!.split(";")[0]!;
}
// The owner's important actions (the seal, the invite, the purge) need a passkey check in the last five minutes (#254), as in
// aws/verify.ts: a software authenticator for this origin registers each owner's first passkey (which counts as the check)
// or checks with it.
const devices = new Map<string, ReturnType<typeof fakeAuthenticator>>();
async function check(request: CapsuleRequest, cookie: string) {
  const { challenge } = await (await request("/passkey/challenge", "POST", {}, cookie)).json(), device = devices.get(cookie), fresh = fakeAuthenticator({ origin });
  const r = device ? await request("/passkey/verify", "POST", { challenge, id: device.id, ...device.assert(challenge) }, cookie) : await request("/passkey", "POST", { challenge, ...fresh.register(challenge) }, cookie);
  assert.equal(r.status, 200); if (!device) devices.set(cookie, fresh);
}
// The trip published with a deadline minutes away, its owner's seat taken.
async function publish(title: string, purgeAt: string) {
  // The trip is already over, so the capsule is in its reflection window and a deadline minutes away is still valid input
  // (schema only demands the purge date fall after endsOn). No "short deadline" flag is added anywhere for this.
  const seed = emptyTrip(day(3), day(2), title);
  seed.spec.lifecycle = { reflectionDays: 30, purgeAt };
  const created = await invoke(functionName, profile, region, { payload: { ...seed, confirm: true } });
  assert.equal(created.statusCode, 201);
  const id = created.body.id as string, request = under(id);
  return { id, request, owner: await join(request, created.body.url) };
}
let plain: Awaited<ReturnType<typeof publish>> | undefined, sealed: Awaited<ReturnType<typeof publish>> | undefined;
// Counting whole-table chunk items avoids needing the HMAC key to derive this capsule's key. dev holds fictional data only.
// A scan page tops out at 1 MB, which 16 chunk items of 128 KiB reach on their own, so paging matters here. The CLI pages
// on its own and sums Count: measured on this stack with --page-size 1 (18 round trips) the answer was the same 18 as an
// unforced scan. The read is strongly consistent, because an eventually consistent scan may still answer from before the
// sweep and report "the payload is gone" while it is still stored — the one thing this script must never get wrong.
const chunks = async () => {
  const proc = Bun.spawn(["aws", "dynamodb", "scan", "--table-name", table, "--profile", profile, "--region", region, "--select", "COUNT", "--consistent-read",
    "--filter-expression", "begins_with(sk, :c)", "--expression-attribute-values", '{":c":{"S":"chunk:"}}', "--no-cli-pager", "--output", "json"], { stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  // The CLI's stderr names the table ARN, so it carries the account id, and this output gets pasted into issues.
  if (code !== 0) throw new Error(`DynamoDBのscanに失敗しました（終了コード ${code}。詳細はこのコマンドを手で実行して確認してください）`);
  return JSON.parse(out).Count as number;
};
// The timings have to hold together: the invite must be issued and redeemed inside PUBLISH_TO_PURGE, because issue() refuses
// a link that outlives the capsule, and a redeem after the deadline answers 410 rather than the 401 being asserted. That
// leaves PUBLISH_TO_PURGE - INVITE_LIFE - 10s ≈ 3m50s of slack for publishing, two full-table scans and the invite call.
// The 10-second margins also assume the operator's clock agrees with AWS to within 10 seconds. SWEEP_WAIT is longer than
// the Cleanup schedule in aws/template.yaml (rate(5 minutes)) so one missed tick is not a failure.
const PUBLISH_TO_PURGE = 6 * 60000, INVITE_LIFE = 2 * 60000, SWEEP_WAIT = 7 * 60000;
try {
  const before = await chunks(); log(`chunks before publish: ${before}`);
  const purgeAt = new Date(Date.now() + PUBLISH_TO_PURGE).toISOString();
  plain = await publish(PLAIN_TITLE, purgeAt); sealed = await publish(TITLE, purgeAt);
  log(`published two, purgeAt ${purgeAt.slice(11, 19)}Z`);
  const stored = await chunks(); log(`chunks after publish: ${stored}`);
  assert.ok(stored > before, "発行してもチャンクが増えていません");
  // The plain one is left as its owner took it: the host opens nothing in it until the owner seals it.
  const unsealed = await plain.request("/document", "PATCH", { type: "check", id: "c1", done: true }, plain.owner);
  assert.deepEqual([unsealed.status, (await unsealed.json()).error], [409, "オーナーがこの旅行を暗号化するまで開けません"]);
  // The other is sealed by its owner right after the seat is taken (src/test-fixture.ts sealedTrip, as the owner's page does).
  await check(sealed.request, sealed.owner);
  const send = sealedRequests(sealed.request, sealed.id, await sealedTrip(sealed.request, sealed.id, sealed.owner));

  // What this proves: an invite stops being redeemable once its own deadline passes, in real time on the stack.
  // It is NOT the claimBy branch: claimDays is at least a day by the API, and issue() clamps claimBy to the link's expiry,
  // so a link this short has claimBy === expires and the expiry check (src/cloud-host.ts) answers first. claimBy on its own
  // is covered by the unit test "invite seats bind one browser each; full, late and revoked seats stay closed", where a
  // long-lived link lapses after the claim window while an already bound browser keeps working.
  const closesAt = new Date(Date.now() + INVITE_LIFE).toISOString();
  const issued = await send("/grants", "POST", { role: "participant", label: "期限確認用", expiresAt: closesAt, confirm: true }, sealed.owner);
  assert.equal(issued.status, 201);
  const invite = await issued.json();
  log(`invite issued, expires ${closesAt.slice(11, 19)}Z`);
  await sleep(INVITE_LIFE + 10000);
  const late = await redeem(sealed.request, invite.url);
  log(`invite expired ${late.status}`);
  assert.equal(late.status, 401);

  const until = +new Date(purgeAt) + 10000 - Date.now();
  if (until > 0) await sleep(until);
  for (const [name, trip] of [["plain", plain], ["sealed", sealed]] as const) {
    const expired = await trip.request("", "GET", undefined, trip.owner);
    log(`${name} expired ${expired.status}`);
    assert.equal(expired.status, 410);
  }

  // The stored payloads are erased by the scheduled sweep, not by the requests that were refused above.
  const deadline = Date.now() + SWEEP_WAIT;
  let now = stored;
  while (Date.now() < deadline && now > before) { await sleep(30000); now = await chunks(); log(`chunks ${now}`); }
  assert.equal(now, before, `sweepが${SWEEP_WAIT / 60000}分以内にチャンクを消しませんでした（${stored} -> ${now}、期待 ${before}）`);
  log(`chunks ${stored} -> ${before}`);
  console.log("Expiry verification passed: invite expired 401; a trip left plain by its owner and a sealed one both expired 410; payload chunks swept.");
} finally {
  // The capsules are expected to be gone by now; purge anyway so a failure part-way does not leave one behind.
  // The title is checked only while a trip is plain (a sealed one's is the screen's to compare), so each is sent its own.
  for (const [trip, title] of [[plain, PLAIN_TITLE], [sealed, TITLE]] as const) {
    if (!trip) continue;
    await check(trip.request, trip.owner).catch(() => undefined);   // past the deadline the check answers 410 too, and the purge says so below
    const gone = await trip.request("/purge", "POST", { title }, trip.owner).catch(() => undefined);
    // 410 only says the deadline has passed; whether the payload is already erased is what the chunk count above measures.
    log(`cleanup purge ${gone ? gone.status : "skipped"} (410 = 期限を過ぎているので purge は不要)`);
  }
}
