// The filesystem surface the sync engine needs. The runtime impl is backed by Obsidian's
// vault adapter + the Node walker; tests use an in-memory implementation.

import type { WalkEntry } from "./vault-walker";

export interface VaultFS {
  /** Enumerate + classify every vault item (CONTENT/SHARED_CONFIG/DEVICE_CONFIG). */
  walk(): Promise<WalkEntry[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  /** Soft-delete: move to Obsidian trash (never a hard delete). */
  trash(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
