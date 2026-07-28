// Runtime VaultFS: enumerates via the Node walker (full fs access on desktop, so hidden
// files are covered), and reads/writes/trashes through Obsidian's data adapter so the app
// stays consistent. Soft-delete uses the adapter's local trash (.trash).

import { type App, FileSystemAdapter } from "obsidian";
import type { VaultFS } from "./vault-fs";
import { walkVault, type WalkEntry } from "./vault-walker";
import type { ClassifyOptions } from "./file-classifier";

export class ObsidianVaultFS implements VaultFS {
  private adapter: FileSystemAdapter;
  private basePath: string;

  constructor(
    app: App,
    private opts: ClassifyOptions,
  ) {
    this.adapter = app.vault.adapter as FileSystemAdapter;
    this.basePath = this.adapter.getBasePath();
  }

  async walk(): Promise<WalkEntry[]> {
    return (await walkVault(this.basePath, this.opts)).entries;
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.ensureDir(path);
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await this.adapter.writeBinary(path, ab);
  }

  async trash(path: string): Promise<void> {
    // local trash (.trash in the vault) — soft delete, recoverable by the user.
    await this.adapter.trashLocal(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  private async ensureDir(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash < 0) return;
    const dir = filePath.slice(0, slash);
    const segments = dir.split("/");
    let cur = "";
    for (const seg of segments) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (!(await this.adapter.exists(cur))) await this.adapter.mkdir(cur);
    }
  }
}
