import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { host, viewerIp } from "./aws-handler";
// The entry of the Lambda Web Function behind CloudFront (aws/README.md「配置手順」). CloudFront's origin access control
// signs every request and Lambda refuses an unsigned one before this runs, so nothing here checks a secret header. A request
// without CloudFront-Viewer-Address (a signed direct call that left it out) has no viewer to name: refused, never given an address.
const BODY_LIMIT = 2 * 1024 * 1024 + 64 * 1024;
type Target = { fetch(request: Request): Promise<Response> };
export async function serveWeb(request: Request, target: Target = host): Promise<Response> {
  const headers = new Headers(request.headers), ip = viewerIp(headers);
  if (!ip) return new Response(JSON.stringify({ error: "配信元を経由してください" }), { status: 403, headers: { "content-type": "application/json" } });
  headers.set("cf-connecting-ip", ip);
  headers.delete("authorization");
  return target.fetch(new Request(request, { headers }));
}
// Node's request and response around serveWeb. The request's own Host is the endpoint's domain, so the URL is built on the public origin.
export async function serveNode(req: IncomingMessage, res: ServerResponse, target: Target = host) {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, one);
    const method = req.method ?? "GET", chunks: Buffer[] = [];
    let size = 0;
    // The Host refuses a body over 2 MiB, but only after it is read: stop reading well before it can fill the environment's memory.
    if (!["GET", "HEAD"].includes(method)) for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > BODY_LIMIT) { res.writeHead(413, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify({ error: "本文が大きすぎます" })); return; }
      chunks.push(chunk as Buffer);
    }
    const response = await serveWeb(new Request(process.env.CAPSULE_ORIGIN + (req.url ?? "/"), { method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }), target);
    const out = Object.fromEntries(response.headers), cookies = response.headers.getSetCookie();
    delete out["set-cookie"];
    res.writeHead(response.status, { ...out, ...(cookies.length ? { "set-cookie": cookies } : {}) });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.log(JSON.stringify({ kind: "error", name: error instanceof Error ? error.name : "unknown" })); // the kind only: an error's text can carry what the request held
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "サーバーでエラーが起きました" }));
  }
}
// Lambda names the address to listen on; a bundle run anywhere else (the tests) does not start a server.
const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
if (endpoint) { const [address, port] = endpoint.split(":"); createServer((req, res) => { void serveNode(req, res); }).listen(Number(port), address); }
