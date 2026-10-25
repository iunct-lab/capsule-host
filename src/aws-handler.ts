import { CloudHost } from "./cloud-host";
import { AwsStore } from "./aws-store";
import { SsmKeyStore } from "./aws-key-store";
import { anthropicGenerate } from "./assist";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
const store = new AwsStore(process.env.CAPSULE_TABLE!);
const lambda = new LambdaClient({});
const origin = process.env.CAPSULE_ORIGIN!;
export const host = new CloudHost({ STORE: store, KEYS: new SsmKeyStore(process.env.CAPSULE_KEY_PREFIX ?? "/capsule-host/unset/creator-key"), CAPSULE_HMAC_KEY: process.env.CAPSULE_HMAC_KEY!, CAPSULE_ORIGIN: origin, CAPSULE_CLAIM_COUNTRIES: process.env.CAPSULE_CLAIM_COUNTRIES ?? "", CAPSULE_DISABLED_ACTIONS: process.env.CAPSULE_DISABLED_ACTIONS ?? "", CAPSULE_SEALED_FROM: process.env.CAPSULE_SEALED_FROM, CAPSULE_ASSIST_MODEL: process.env.CAPSULE_ASSIST_MODEL,
  // A generation outlasts an HTTP request, so it is started as an Event (no retry: template.yaml) on the Event Function: the one running
  // this code, or the one named by CAPSULE_EVENT_FUNCTION when the Web Function (which only serves HTTP) is the caller.
  ASSIST: { generate: anthropicGenerate, dispatch: async id => { await lambda.send(new InvokeCommand({ FunctionName: process.env.CAPSULE_EVENT_FUNCTION ?? process.env.AWS_LAMBDA_FUNCTION_NAME!, InvocationType: "Event", Payload: JSON.stringify({ source: "capsule.assist", id }) })); } } });
// Only the Lambda entry writes a log line; the local server and the tests stay quiet (#608).
host.log = line => console.log(JSON.stringify({ kind: "refused", ...line }));
// CloudFront sets CloudFront-Viewer-Address (<ip>:<port>, an IPv6 address without brackets) from the viewer's own connection and
// overwrites whatever the client sent. X-Forwarded-For is never read: where the trusted entry sits depends on what is in front.
// Empty when the header is absent or malformed.
export function viewerIp(headers: Headers): string {
  const value = headers.get("cloudfront-viewer-address") ?? "", at = value.lastIndexOf(":");
  return at > 0 ? value.slice(0, at) : "";
}
export async function handler(event: any) {
  if (!event.requestContext && event.source === "aws.events") { await host.sweep(Date.now()); return { ok: true }; }
  // The function's own Event (dispatch above); an HTTP body cannot produce it.
  if (!event.requestContext && event.source === "capsule.assist" && /^[a-f0-9]{32}$/.test(event.id)) { await host.runAssist(event.id); return { ok: true }; }
  // This event is only reachable through IAM-authorized Lambda Invoke, never HTTP body input.
  if (!event.requestContext && event.source === "capsule.publisher") {
    const publisher = new CloudHost(host.env, undefined, async () => "aws-publisher");
    // Publisher may only read the build, create a trip, replace a lost owner invite, enroll, list and revoke creators, or list
    // capsules and terminate one (the operator); it never receives a trip session.
    const path = event.path ?? "/v1/publish";
    // What this bundle was built from, so a publisher can refuse to send when it is not the same src (#103).
    if (path === "/v1/version") return { statusCode: 200, body: { src: process.env.CAPSULE_SRC ?? "unknown" } };
    if (path !== "/v1/publish" && path !== "/v1/capsules/list" && !/^\/v1\/c\/[a-f0-9]{32}\/(recover|terminate)$/.test(path) && !/^\/v1\/creators\/(enroll|list|revoke)$/.test(path)) throw new Error("Unsupported publisher path");
    const response = await publisher.fetch(new Request(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(event.payload) }));
    return { statusCode: response.status, body: await response.json() };
  }
  // Everything over HTTP is the Web Function (src/aws-web.ts); this function only takes the events above.
  throw new Error("Unsupported invocation");
}
