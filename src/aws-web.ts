import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { host, viewerIp } from "./aws-handler";
import { secure } from "./cloud-host";
// The entry of the Lambda Web Function behind CloudFront (aws/README.md「配置手順」). CloudFront's origin access control
// signs every request and Lambda refuses an unsigned one before this runs, so nothing here checks a secret header. A request
// without CloudFront-Viewer-Address (a signed direct call that left it out) has no viewer to name: refused, never given an address.
const BODY_LIMIT = 2 * 1024 * 1024 + 64 * 1024;
type Target = { fetch(request: Request): Promise<Response> };
// An answer refused before the Host still carries what every Host answer carries (no-store and the protective headers).
const early = (status: number, error: string, headers: Record<string, string> = {}) =>
  secure(new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", ...headers } }), process.env.CAPSULE_ORIGIN ?? "");
export async function serveWeb(request: Request, target: Target = host): Promise<Response> {
  const headers = new Headers(request.headers), ip = viewerIp(headers);
  if (!ip) return early(403, "配信元を経由してください");
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
      if (size > BODY_LIMIT) return await write(res, early(413, "本文が大きすぎます", { connection: "close" }));
      chunks.push(chunk as Buffer);
    }
    await write(res, await serveWeb(new Request(process.env.CAPSULE_ORIGIN + (req.url ?? "/"), { method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }), target));
  } catch (error) {
    console.log(JSON.stringify({ kind: "error", name: error instanceof Error ? error.name : "unknown" })); // the kind only: an error's text can carry what the request held
    if (!res.headersSent) await write(res, early(500, "サーバーでエラーが起きました"));
    else res.end(JSON.stringify({ error: "サーバーでエラーが起きました" }));
  }
}
async function write(res: ServerResponse, response: Response) {
  const out = Object.fromEntries(response.headers), cookies = response.headers.getSetCookie();
  delete out["set-cookie"];
  res.writeHead(response.status, { ...out, ...(cookies.length ? { "set-cookie": cookies } : {}) });
  res.end(Buffer.from(await response.arrayBuffer()));
}
// Lambda names the address to listen on; a bundle run anywhere else (the tests) does not start a server.
const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
if (endpoint) { const [address, port] = endpoint.split(":"); createServer((req, res) => { void serveNode(req, res); }).listen(Number(port), address); }
