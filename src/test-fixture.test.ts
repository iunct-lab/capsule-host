import { afterAll, expect, test } from "bun:test";
import { challengeOf, refusals } from "./test-fixture";

// A stand-in for the Host: answers each path with the status and body the test asks for.
const answers: Record<string, [number, unknown]> = {
  "/v1/c/0123456789abcdef0123456789abcdef/passkey/challenge": [429, { error: "操作が多すぎます。1分後に再試行してください" }],
  "/v1/c/0123456789abcdef0123456789abcdef": [410, { error: "この旅行は期限を過ぎました" }],
  "/v1/creators/session": [401, { error: "x".repeat(200) }],
  "/v1/c/0123456789abcdef0123456789abcdef/document": [409, "not an object"],
  "/v1/ok": [200, { challenge: "c-1" }],
};
const host = Bun.serve({ port: 0, fetch: req => { const [status, body] = answers[new URL(req.url).pathname] ?? [404, { error: "見つかりません" }]; return Response.json(body, { status }); } });
afterAll(() => host.stop(true));
const at = (path: string) => `http://localhost:${host.port}${path}`, id = "0123456789abcdef0123456789abcdef";

test("refusals keeps the refused requests' action, method, status and error, never the cookie, the link secret, the trip id or the query", async () => {
  const seen = refusals(3);
  expect((await seen.fetch(at("/v1/ok"))).status).toBe(200);
  expect(seen.report()).toBe("Host が断った要求: なし");
  const r = await seen.fetch(at(`/v1/c/${id}/passkey/challenge?ui=2`), { method: "POST", headers: { Cookie: "s=cookie-value" }, body: JSON.stringify({ url: "https://trip.example/c/x#k=secret-value" }) });
  expect(r.status).toBe(429);
  expect((await r.json()).error).toBe("操作が多すぎます。1分後に再試行してください");   // the caller still reads the body
  const report = seen.report();
  expect(report).toBe("Host が断った要求（直近 1 件、古い順）:\nrefused: POST passkey/challenge 429 操作が多すぎます。1分後に再試行してください");
  for (const secret of ["cookie-value", "Cookie", "#k=", "secret-value", id, "ui=2"]) expect(report).not.toContain(secret);
});

test("refusals shortens the error, leaves out one that is not a string and drops the oldest past the limit", async () => {
  const seen = refusals(3);
  await seen.fetch(at(`/v1/c/${id}/passkey/challenge?ui=2`), { method: "POST" });
  await seen.fetch(at(`/v1/c/${id}?ui=2`));
  await seen.fetch(at("/v1/creators/session"), { method: "POST" });
  await seen.fetch(at(`/v1/c/${id}/document`), { method: "PATCH" });
  expect(seen.report().split("\n")).toEqual([
    "Host が断った要求（直近 3 件、古い順）:",
    "refused: GET  410 この旅行は期限を過ぎました",
    `refused: POST creators/session 401 ${"x".repeat(120)}`,
    "refused: PATCH document 409 ",
  ]);
});

test("challengeOf returns the challenge on 200 and throws the action, status and error otherwise", async () => {
  expect(await challengeOf(fetch(at("/v1/ok")))).toBe("c-1");
  await expect(challengeOf(fetch(at(`/v1/c/${id}/passkey/challenge`)))).rejects.toThrow("passkey/challenge 429 操作が多すぎます。1分後に再試行してください");
});
