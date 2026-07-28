import type { VaultFS } from "../../src/engine/vault-fs";
import type { WalkEntry } from "../../src/engine/vault-walker";
import { classify, type ClassifyOptions } from "../../src/engine/file-classifier";

interface Stored {
  data: Uint8Array;
  mtime: number;
}

/** In-memory VaultFS for engine tests. Classifies via the real classifier. */
export class MemoryVaultFS implements VaultFS {
  files = new Map<string, Stored>();
  trashed = new Map<string, Stored>();
  private clock = 1;

  constructor(private opts: ClassifyOptions) {}

  /** Test helper: create/replace a file with an explicit mtime. */
  set(path: string, content: string | Uint8Array, mtime?: number): void {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(path, { data, mtime: mtime ?? ++this.clock });
  }

  async walk(): Promise<WalkEntry[]> {
    const out: WalkEntry[] = [];
    for (const [path, s] of this.files) {
      const c = classify(path, this.opts);
      if (c.tier === "EXCLUDE") continue;
      out.push({ path, tier: c.tier, size: s.data.length, mtime: s.mtime });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  async read(path: string): Promise<Uint8Array> {
    const s = this.files.get(path);
    if (!s) throw new Error(`no such file: ${path}`);
    return s.data;
  }
  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, { data, mtime: ++this.clock });
  }
  async trash(path: string): Promise<void> {
    const s = this.files.get(path);
    if (s) {
      this.trashed.set(path, s);
      this.files.delete(path);
    }
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
