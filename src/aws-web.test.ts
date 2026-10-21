import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { testTrip } from "./test-fixture";

process.env.CAPSULE_TABLE = "test-table"; process.env.CAPSULE_ORIGIN = "https://capsule.example";
process.env.CAPSULE_HMAC_KEY = "test-key-".repeat(8);
const { serveWeb, serveNode } = await import("./aws-web");
const { viewerIp } = await import("./aws-handler");
const { CloudHost } = await import("./cloud-host");
const { LocalD1 } = await import("./local-d1");

test("the viewer address is the one CloudFront names, an IPv4 or IPv6 address without its port, and nothing else", () => {
  expect(viewerIp(new Headers({ "cloudfront-viewer-address": "198.51.100.7:46532" }))).toBe("198.51.100.7");
  expect(viewerIp(new Headers({ "cloudfront-viewer-address": "2001:db8::7:46532" }))).toBe("2001:db8::7");
  expect(viewerIp(new Headers({ "x-forwarded-for": "203.0.113.66" }))).toBe("");
  expect(viewerIp(new Headers({ "cloudfront-viewer-address": "no-port" }))).toBe("");
});
const viaCloudFront = { "cloudfront-viewer-address": "198.51.100.7:46532" };
test("the viewer address comes from CloudFront, never from X-Forwarded-For or a client's cf-connecting-ip", async () => {
  const db = new LocalD1(), host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: "https://capsule.example" }), ips: string[] = [];
  host.log = line => ips.push(line.ip);
  try {
    const id = "a".repeat(32);
    for (const forged of ["203.0.113.66, 198.51.100.7", "203.0.113.66"]) {
      const response = await serveWeb(new Request(`https://capsule.example/v1/c/${id}`, { headers: { ...viaCloudFront, "x-forwarded-for": forged, "cf-connecting-ip": "203.0.113.66" } }), host);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(ips).toEqual(["198.51.100.7", "198.51.100.7"]);
    // Without the header there is no viewer to name: refused before the Host sees it.
    ips.length = 0;
    const refused = await serveWeb(new Request(`https://capsule.example/v1/c/${id}`, { headers: { "x-forwarded-for": "198.51.100.7" } }), host);
    expect(refused.status).toBe(403);
    expect(ips).toEqual([]);
  } finally { db.close(); }
});

test("Authorization is dropped, and a signed-in read gets the Host's own answer", async () => {
  const origin = "https://capsule.example", db = new LocalD1(), host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: origin }, () => +new Date("2026-09-16T00:00:00Z"), async () => "test"), seen: Array<string | null> = [];
  try {
    const published = await host.fetch(new Request(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...testTrip(), confirm: true }) }));
    expect(published.status).toBe(201);
    const created = await published.json() as { id: string; url: string }, url = `${origin}/v1/c/${created.id}`;
    const session = await host.fetch(new Request(url + "/sessions", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret: new URLSearchParams(new URL(created.url).hash.slice(1)).get("k") }) }));
    expect(session.status).toBe(200);
    const cookie = session.headers.get("Set-Cookie")!.split(";")[0]!;
    const direct = await host.fetch(new Request(url, { headers: { cookie, "cf-connecting-ip": "198.51.100.7" } }));
    expect(direct.status).toBe(200);
    const web = await serveWeb(new Request(url, { headers: { ...viaCloudFront, cookie, authorization: "Bearer x" } }), { fetch: async r => { seen.push(r.headers.get("authorization")); return host.fetch(r); } });
    expect(seen).toEqual([null]);
    expect(web.status).toBe(200);
    expect(await web.text()).toBe(await direct.text());
  } finally { db.close(); }
});

test("over HTTP, every Set-Cookie arrives and a body reaches the Host", async () => {
  const server = createServer((req, res) => { void serveNode(req, res, { fetch: async r => new Response(await r.text(), { status: 201, headers: [["set-cookie", "a=1; Path=/"], ["set-cookie", "b=2; Path=/"], ["content-type", "text/plain"]] }) }); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/x`, { method: "POST", headers: viaCloudFront, body: "hello" });
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(await response.text()).toBe("hello");
  } finally { server.close(); }
});

test("a body far over the Host's own limit is refused before it is read in full", async () => {
  let reached = false;
  const server = createServer((req, res) => { void serveNode(req, res, { fetch: async () => { reached = true; return new Response("no"); } }); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/publish`, { method: "POST", headers: { ...viaCloudFront, "content-type": "application/json" }, body: Buffer.alloc(3 * 1024 * 1024, 97) });
    expect(response.status).toBe(413);
    expect(reached).toBe(false);
  } finally { server.close(); }
});

test("a Host that throws gets a 500, and the log names the error's kind, never its text", async () => {
  const lines: string[] = [], log = console.log;
  console.log = (line: string) => lines.push(line);
  const server = createServer((req, res) => { void serveNode(req, res, { fetch: async () => { throw new TypeError("secret-in-the-message trip title"); } }); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/x`, { headers: viaCloudFront });
    expect(response.status).toBe(500);
    expect(lines.map(l => JSON.parse(l))).toEqual([{ kind: "error", name: "TypeError" }]);
  } finally { console.log = log; server.close(); }
});
