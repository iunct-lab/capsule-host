import { AddTagsToResourceCommand, DeleteParameterCommand, GetParameterCommand, GetParametersByPathCommand, ListTagsForResourceCommand, ParameterNotFound, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { KeyStore } from "./key-store";

// The sealed value (see key-store.ts) goes into a SecureString under the stack's prefix; the IAM policy is scoped to that prefix.
// Last use is the later of LastModifiedDate (put) and the `used` tag (touch); tags are free on standard parameters.
const missing = (e: unknown) => e instanceof ParameterNotFound || ["ParameterNotFound", "InvalidResourceId"].includes((e as Error).name);
export class SsmKeyStore implements KeyStore {
  constructor(private prefix: string, private client: Pick<SSMClient, "send"> = new SSMClient({})) {}
  private name(subject: string) { return `${this.prefix}/${subject}`; }
  async put(subject: string, sealed: string) {
    await this.client.send(new PutParameterCommand({ Name: this.name(subject), Type: "SecureString", Value: sealed, Overwrite: true }));
  }
  async get(subject: string) {
    try { return (await this.client.send(new GetParameterCommand({ Name: this.name(subject), WithDecryption: true }))).Parameter?.Value ?? null; }
    catch (e) { if (e instanceof ParameterNotFound || (e as Error).name === "ParameterNotFound") return null; throw e; }
  }
  async remove(subject: string) {
    try { await this.client.send(new DeleteParameterCommand({ Name: this.name(subject) })); }
    catch (e) { if (!(e instanceof ParameterNotFound || (e as Error).name === "ParameterNotFound")) throw e; }
  }
  async touch(subject: string, at: number) {
    try { await this.client.send(new AddTagsToResourceCommand({ ResourceType: "Parameter", ResourceId: this.name(subject), Tags: [{ Key: "used", Value: String(at) }] })); }
    catch (e) { if (!missing(e)) throw e; }
  }
  async sweep(cutoff: number) {
    let NextToken: string | undefined;
    do {
      const page = await this.client.send(new GetParametersByPathCommand({ Path: this.prefix, Recursive: false, WithDecryption: false, ...(NextToken ? { NextToken } : {}) }));
      for (const { Name, LastModifiedDate } of page.Parameters ?? []) {
        if (!Name) continue;
        let tags;  // a key removed since the page was read is already gone
        try { tags = (await this.client.send(new ListTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: Name }))).TagList; }
        catch (e) { if (missing(e)) continue; throw e; }
        const used = Math.max(LastModifiedDate?.getTime() ?? 0, Number(tags?.find(t => t.Key === "used")?.Value) || 0);
        if (used <= cutoff) {
          try { await this.client.send(new DeleteParameterCommand({ Name })); }
          catch (e) { if (!missing(e)) throw e; }
        }
      }
      NextToken = page.NextToken;
    } while (NextToken);
  }
}
