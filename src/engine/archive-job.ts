// The redundant "catch-all" archive: a single encrypted tar of the full config tree
// (.obsidian/**), compressed with brotli (zero-dep, Node built-in), uploaded to archives/.
// Deliberately redundant with per-file sync — a one-shot "restore everything" safety net.
// GFS retention prunes old archives.

import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import * as tar from "tar-stream";
import type { ObjectBackend } from "../store/backend";
import { seal, open } from "../crypto/box";
import type { Subkeys } from "../crypto/keys";
import type { VaultFS } from "./vault-fs";

const SHARED_OR_DEVICE = new Set(["SHARED_CONFIG", "DEVICE_CONFIG"]);

function packTar(files: { path: string; data: Uint8Array }[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Uint8Array[] = [];
    pack.on("data", (c: Uint8Array) => chunks.push(c));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
    (async () => {
      for (const f of files) pack.entry({ name: f.path }, Buffer.from(f.data));
      pack.finalize();
    })().catch(reject);
  });
}

export class ArchiveJob {
  constructor(
    private backend: ObjectBackend,
    private subkeys: Subkeys,
  ) {}

  /** Build + encrypt + upload an archive. `stamp` is the caller's timestamp (UTC ms). */
  async create(fs: VaultFS, stamp: number): Promise<string> {
    const files: { path: string; data: Uint8Array }[] = [];
    for (const e of await fs.walk()) {
      if (!SHARED_OR_DEVICE.has(e.tier)) continue;
      files.push({ path: e.path, data: await fs.read(e.path) });
    }
    const tarball = await packTar(files);
    const compressed = brotliCompressSync(tarball);
    const blob = await seal(this.subkeys.manifestKey, new Uint8Array(compressed));
    const key = `archives/${stamp}.tar.br.enc`;
    await this.backend.put(key, blob);
    return key;
  }

  async list(): Promise<string[]> {
    return (await this.backend.list("archives/")).map((o) => o.key).sort();
  }

  /** Decrypt + decompress an archive into [{path,data}] for restore. */
  async extract(key: string): Promise<{ path: string; data: Uint8Array }[]> {
    const blob = await this.backend.get(key);
    if (!blob) return [];
    const tarball = brotliDecompressSync(await open(this.subkeys.manifestKey, blob));
    return await new Promise((resolve, reject) => {
      const out: { path: string; data: Uint8Array }[] = [];
      const extract = tar.extract();
      extract.on("entry", (header, stream, next) => {
        const parts: Uint8Array[] = [];
        stream.on("data", (c: Uint8Array) => parts.push(c));
        stream.on("end", () => {
          out.push({ path: header.name, data: new Uint8Array(Buffer.concat(parts)) });
          next();
        });
        stream.resume();
      });
      extract.on("finish", () => resolve(out));
      extract.on("error", reject);
      extract.end(Buffer.from(tarball));
    });
  }

  /** GFS-ish retention: keep the newest `keep` archives, delete the rest. */
  async prune(keep: number): Promise<number> {
    const all = await this.list();
    const toDelete = all.slice(0, Math.max(0, all.length - keep));
    for (const k of toDelete) await this.backend.delete(k);
    return toDelete.length;
  }
}
