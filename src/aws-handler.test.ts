import { test, expect } from "bun:test";

process.env.CAPSULE_TABLE = "test-table"; process.env.CAPSULE_ORIGIN = "https://capsule.example";
process.env.CAPSULE_HMAC_KEY = "test-key-".repeat(8);
const { handler } = await import("./aws-handler");

test("the function's own assist event reaches runAssist; a malformed one or an HTTP event does not", async () => {
  const { CloudHost } = await import("./cloud-host");
  const seen: string[] = [], real = CloudHost.prototype.runAssist;
  CloudHost.prototype.runAssist = async function (id: string) { seen.push(id); };
  try {
    expect(await handler({ source: "capsule.assist", id: "a".repeat(32) })).toEqual({ ok: true });
    expect(seen).toEqual(["a".repeat(32)]);
    await expect(handler({ source: "capsule.assist", id: "../x" })).rejects.toThrow("Unsupported invocation");
    expect(seen).toHaveLength(1);
    // This function takes no HTTP at all: an API Gateway event, with the same words in its body, is not one of its events.
    await expect(handler({ version: "2.0", requestContext: { http: { method: "POST", sourceIp: "192.0.2.1" } }, rawPath: "/v1/assist", headers: {}, body: JSON.stringify({ source: "capsule.assist", id: "b".repeat(32) }) })).rejects.toThrow("Unsupported invocation");
    expect(seen).toHaveLength(1);
  } finally { CloudHost.prototype.runAssist = real; }
});

test("a generation is started on the Event Function when the caller is the Web Function", async () => {
  const { LambdaClient } = await import("@aws-sdk/client-lambda"), { host } = await import("./aws-handler");
  const sent: Array<{ FunctionName: string; InvocationType: string; Payload: string }> = [], real = LambdaClient.prototype.send;
  LambdaClient.prototype.send = (async (command: { input: { FunctionName: string; InvocationType: string; Payload: string } }) => { sent.push(command.input); return {}; }) as typeof real;
  process.env.AWS_LAMBDA_FUNCTION_NAME = "host-web";
  try {
    await host.env.ASSIST!.dispatch!("c".repeat(32));
    process.env.CAPSULE_EVENT_FUNCTION = "host-event";
    await host.env.ASSIST!.dispatch!("d".repeat(32));
  } finally { LambdaClient.prototype.send = real; delete process.env.CAPSULE_EVENT_FUNCTION; delete process.env.AWS_LAMBDA_FUNCTION_NAME; }
  expect(sent.map(s => [s.FunctionName, s.InvocationType, JSON.parse(s.Payload).source])).toEqual([["host-web", "Event", "capsule.assist"], ["host-event", "Event", "capsule.assist"]]);
});
