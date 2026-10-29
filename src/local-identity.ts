// Who the loopback `bun run dev` server (src/main.ts) says the request is from: CloudHost's IAM publisher identity on AWS.
// Kept apart from src/main.ts, which starts the server when imported (src/local-identity.test.ts).
export function isLoopback(origin: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
}

// A loopback server may make a trip from its own page and hand out a creator enrollment link (verify:ui makes its creator so),
// and nothing more: /recover and the creator registry's list and revoke stay closed. A request with a creator's cookie gets no
// identity, so the creator is one here as on AWS.
export function localIdentity(origin: string): (req: Request) => Promise<string | null> {
  const local = isLoopback(origin);
  return async req => {
    const path = new URL(req.url).pathname;
    if (!local || req.headers.get("cookie")?.includes("capsule_creator=")) return null;
    return ["/v1/publish", "/v1/recipe", "/v1/check", "/v1/account/key", "/v1/creators/enroll"].includes(path) || /^\/v1\/assist(\/[a-f0-9]{32})?$/.test(path) ? "local" : null;
  };
}
