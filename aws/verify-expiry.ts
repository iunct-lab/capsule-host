import assert from "node:assert/strict";
import { invoke } from "./invoke";
import { emptyTrip } from "../src/template";
import { fakeAuthenticator } from "../src/test-fixture";

// Watches one disposable fictional capsule reach its deadline on the real stack: the invite closes, the capsule answers 410,
// and the scheduled sweep erases the stored payload. Takes about 12 minutes of wall clock, so it is NOT part of aws/verify.ts
// (that one runs on every deploy). Never prints capability links or cookies. Run from a country listed in ClaimCountries.
const [origin, functionName, profile, region, table] = process.argv.slice(2);
if (!origin || !functionName || !profile || !region || !table) throw new Error("Usage: bun aws/verify-expiry.ts https://DISTRIBUTION.cloudfront.net function profile region dynamodb-table");
const TITLE = "AWS期限確認用（自動削除）";
let capsuleId = "", owner = "";
const at = () => new Date().toISOString().slice(11, 19) + "Z";
const log = (line: string) => console.log(`${at()}  ${line}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const day = (back: number) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
const request = (path: string, method = "GET", body?: unknown, cookie = owner, revision = 1) => fetch(origin + path, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(path.startsWith("/v1/") ? { "If-Match": `"${revision}"` } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const api = (action: string) => `/v1/c/${capsuleId}${action}`;
const redeem = (url: string, cookie = "") => request(api("/sessions"), "POST", { secret: new URLSearchParams(new URL(url).hash.slice(1)).get("k") }, cookie);
async function join(url: string) {
  assert.equal(new URL(url).origin, origin);
  const r = await redeem(url); assert.equal(r.status, 200);
  return r.headers.get("Set-Cookie")!.split(";")[0]!;
}
// The owner's important actions (the invite, the purge) need a passkey check in the last five minutes (#254), as in
// aws/verify.ts: a software authenticator for this origin registers the owner's first passkey (which counts as the check)
// or checks with it.
let device: ReturnType<typeof fakeAuthenticator> | undefined;
async function stepUp() {
  const { challenge } = await (await request(api("/passkey/challenge"), "POST", {})).json(), fresh = fakeAuthenticator({ origin });
  const r = device ? await request(api("/passkey/verify"), "POST", { challenge, id: device.id, ...device.assert(challenge) }) : await request(api("/passkey"), "POST", { challenge, ...fresh.register(challenge) });
  assert.equal(r.status, 200); device ??= fresh;
}
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
  // The trip is already over, so the capsule is in its reflection window and a deadline minutes away is still valid input
  // (schema only demands the purge date fall after endsOn). No "short deadline" flag is added anywhere for this.
  const seed = emptyTrip(day(3), day(2), TITLE);
  const purgeAt = new Date(Date.now() + PUBLISH_TO_PURGE).toISOString();
  seed.spec.lifecycle = { reflectionDays: 30, purgeAt };
  const created = await invoke(functionName, profile, region, { payload: { ...seed, confirm: true } });
  assert.equal(created.statusCode, 201);
  capsuleId = created.body.id; owner = await join(created.body.url);
  log(`published, purgeAt ${purgeAt.slice(11, 19)}Z`);
  const stored = await chunks(); log(`chunks after publish: ${stored}`);
  assert.ok(stored > before, "発行してもチャンクが増えていません");

  // What this proves: an invite stops being redeemable once its own deadline passes, in real time on the stack.
  // It is NOT the claimBy branch: claimDays is at least a day by the API, and issue() clamps claimBy to the link's expiry,
  // so a link this short has claimBy === expires and the expiry check (src/cloud-host.ts) answers first. claimBy on its own
  // is covered by the unit test "invite seats bind one browser each; full, late and revoked seats stay closed", where a
  // long-lived link lapses after the claim window while an already bound browser keeps working.
  await stepUp();
  const closesAt = new Date(Date.now() + INVITE_LIFE).toISOString();
  const issued = await request(api("/grants"), "POST", { role: "participant", label: "期限確認用", expiresAt: closesAt, confirm: true });
  assert.equal(issued.status, 201);
  const invite = await issued.json();
  log(`invite issued, expires ${closesAt.slice(11, 19)}Z`);
  await sleep(INVITE_LIFE + 10000);
  const late = await redeem(invite.url);
  log(`invite expired ${late.status}`);
  assert.equal(late.status, 401);

  const until = +new Date(purgeAt) + 10000 - Date.now();
  if (until > 0) await sleep(until);
  const expired = await request(api(""));
  log(`expired ${expired.status}`);
  assert.equal(expired.status, 410);

  // The stored payload is erased by the scheduled sweep, not by the request that was refused above.
  const deadline = Date.now() + SWEEP_WAIT;
  let now = stored;
  while (Date.now() < deadline && now > before) { await sleep(30000); now = await chunks(); log(`chunks ${now}`); }
  assert.equal(now, before, `sweepが${SWEEP_WAIT / 60000}分以内にチャンクを消しませんでした（${stored} -> ${now}、期待 ${before}）`);
  log(`chunks ${stored} -> ${before}`);
  console.log("Expiry verification passed: invite expired 401, capsule expired 410, payload chunks swept.");
} finally {
  // The capsule is expected to be gone by now; purge anyway so a failure part-way does not leave one behind.
  if (capsuleId && owner) {
    await stepUp().catch(() => undefined);   // past the deadline the check answers 410 too, and the purge says so below
    const gone = await request(api("/purge"), "POST", { title: TITLE }).catch(() => undefined);
    // 410 only says the deadline has passed; whether the payload is already erased is what the chunk count above measures.
    log(`cleanup purge ${gone ? gone.status : "skipped"} (410 = 期限を過ぎているので purge は不要)`);
  }
}
