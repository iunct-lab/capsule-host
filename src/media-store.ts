import { chmod, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Where a trip's photo bytes are kept, apart from its record: the host holds them as the browser sealed them and reads none.
// `prefix` is the capsule row's key (the digest of its id, never the id itself) and `name` is `<photo id>.(thumb|display)`, so
// removing a trip's photos is removing a prefix. The AWS store is src/aws-media.ts (#446).
export interface MediaStore {
  put(prefix: string, name: string, bytes: Uint8Array): Promise<void>;
  get(prefix: string, name: string): Promise<Uint8Array | null>;
  remove(prefix: string, name: string): Promise<void>;
  removeAll(prefix: string): Promise<void>;
}

const PREFIX = /^[a-f0-9]{64}$/, NAME = /^[a-f0-9]{32}\.(thumb|display)$/;
function checked(prefix: string, name?: string) {
  if (!PREFIX.test(prefix) || (name !== undefined && !NAME.test(name))) throw new Error("invalid media key");
}

export class LocalMediaStore implements MediaStore {
  constructor(public dir: string) {}
  async put(prefix: string, name: string, bytes: Uint8Array) {
    checked(prefix, name);
    const folder = join(this.dir, prefix);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, name), bytes, { mode: 0o600 });
    await chmod(join(folder, name), 0o600);
  }
  async get(prefix: string, name: string) {
    checked(prefix, name);
    try { return new Uint8Array(await readFile(join(this.dir, prefix, name))); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  // The folder goes with its last file, so a trip with no photos has nothing here.
  async remove(prefix: string, name: string) { checked(prefix, name); await rm(join(this.dir, prefix, name), { force: true }); await rmdir(join(this.dir, prefix)).catch(() => {}); }
  async removeAll(prefix: string) { checked(prefix); await rm(join(this.dir, prefix), { recursive: true, force: true }); }
}
