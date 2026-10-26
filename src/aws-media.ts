import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { MediaStore } from "./media-store";

// A trip's photo bytes in a private bucket (aws/template.yaml, `Media`), as the browser sealed them: the bucket holds ciphertext only,
// so its own encryption is the default and no part of the protection from the operator. The key is `<prefix>/<name>`, the prefix being
// the capsule row's key, so removing a trip's photos is removing its prefix. The bucket's 181-day rule is the last resort; this is the way.
export class S3MediaStore implements MediaStore {
  constructor(public bucket: string, public s3 = new S3Client({})) {}
  private key = (prefix: string, name: string) => `${prefix}/${name}`;
  async put(prefix: string, name: string, bytes: Uint8Array) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(prefix, name), Body: bytes, ContentType: "application/octet-stream" }));
  }
  async get(prefix: string, name: string) {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(prefix, name) }));
      return await out.Body!.transformToByteArray();
    } catch (e) { if (e instanceof Error && e.name === "NoSuchKey") return null; throw e; }
  }
  async remove(prefix: string, name: string) { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(prefix, name) })); }
  async removeAll(prefix: string) {
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${prefix}/`, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map(o => ({ Key: o.Key! }));
      for (let i = 0; i < keys.length; i += 1000) {
        const out = await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000), Quiet: true } }));
        // A delete that is reported failed is not a deleted object: the trip's row must not be emptied over it.
        if (out.Errors?.length) throw new Error(`S3 のオブジェクトを消せませんでした（${out.Errors.length} 件）`);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}
