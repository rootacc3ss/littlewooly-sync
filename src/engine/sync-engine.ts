// The push/pull state machine for SHARED files (CONTENT + SHARED_CONFIG). DEVICE_CONFIG is
// handled separately (device-config-store.ts) and never crosses devices.
//
// Invariants: objects are uploaded BEFORE the manifest references them; pull-merge happens
// before push so concurrent edits are detected as conflicts, not blindly overwritten; a
// remote delete soft-deletes locally (trash); divergent edits never lose data (conflict copy).

import type { VaultFS } from "./vault-fs";
import type { LocalIndex } from "./local-index";
import { ObjectStore } from "../store/object-store";
import { ManifestStore, type ConflictInfo } from "../store/manifest-store";
import { sha256, toHex } from "../crypto/object-cipher";
import { softDelete } from "./trash";
import { conflictCopyName } from "./conflict-resolver";
import type { Manifest, HistoryRecord, ManifestEntry } from "../types";

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  conflictCopies: string[];
  conflicts: ConflictInfo[];
}

const SHARED_TIERS = new Set(["CONTENT", "SHARED_CONFIG"]);

export class SyncEngine {
  constructor(
    private device: string,
    private fs: VaultFS,
    private objects: ObjectStore,
    private manifests: ManifestStore,
    private index: LocalIndex,
    private now: () => number = () => Date.now(),
  ) {}

  private head(entry: ManifestEntry | undefined): HistoryRecord | undefined {
    return entry ? entry.history[entry.head] : undefined;
  }

  /** Pull merged remote state down first, then push local changes up. */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      conflictCopies: [],
      conflicts: [],
    };
    await this.pull(result);
    await this.push(result);
    return result;
  }

  private async pull(result: SyncResult): Promise<void> {
    const merged = await this.manifests.readMerged();
    if (!merged) return;

    for (const [path, entry] of Object.entries(merged.paths)) {
      const head = this.head(entry);
      if (!head) continue;
      const local = await this.index.get(path);

      if (head.deleted) {
        if (await this.fs.exists(path)) {
          await softDelete(this.fs, path);
          result.deletedLocal++;
        }
        await this.index.put({
          path,
          size: 0,
          mtime: head.mtime,
          contentHash: head.contentHash,
          objectKey: head.objectKey,
          isRecipe: head.isRecipe,
          tier: "CONTENT",
          lastSeen: 0,
          deleted: true,
        });
        continue;
      }

      // Remote hasn't changed since our last sync -> nothing to pull; push handles any
      // local edits. (Prevents clobbering a local edit with stale remote content.)
      if (local && head.contentHash === local.contentHash) continue;

      const onDisk = (await this.fs.exists(path)) ? await this.fs.read(path) : null;
      const onDiskHash = onDisk ? toHex(await sha256(onDisk)) : null;

      if (onDiskHash === head.contentHash) {
        // already in sync; refresh index pointer
        await this.markClean(path, head, onDisk!.length);
        continue;
      }

      const unchangedSinceSync = local && onDiskHash === local.contentHash;
      if (onDisk && !unchangedSinceSync && local && local.contentHash !== head.contentHash) {
        // local diverged AND remote changed -> preserve local as a conflict copy.
        const copy = conflictCopyName(path, head.author, this.now());
        await this.fs.write(copy, onDisk);
        result.conflictCopies.push(copy);
      }

      const data = await this.objects.getFile({
        objectKey: head.objectKey,
        isRecipe: head.isRecipe,
      });
      await this.fs.write(path, data);
      await this.markClean(path, head, data.length);
      result.downloaded++;
    }
  }

  private async push(result: SyncResult): Promise<void> {
    const prev = (await this.manifests.readDeviceLatest(this.device)) ?? this.emptyManifest();
    const manifest: Manifest = {
      schema: 1,
      generatedAt: this.now(),
      device: this.device,
      paths: structuredClone(prev.paths),
    };

    const entries = (await this.fs.walk()).filter((e) => SHARED_TIERS.has(e.tier));
    const present = new Set(entries.map((e) => e.path));

    for (const e of entries) {
      if (!(await this.index.isDirty(e.path, e.size, e.mtime))) continue;
      const data = await this.fs.read(e.path);
      const contentHash = toHex(await sha256(data));
      const local = await this.index.get(e.path);

      // Warm-index fast path: same content we last synced, only (size,mtime) drifted.
      // Trust the object exists; refresh the index without a network round-trip.
      if (local && !local.deleted && local.contentHash === contentHash) {
        await this.index.put({ ...local, size: e.size, mtime: e.mtime, tier: e.tier });
        continue;
      }

      // putFile HEADs first and only uploads if absent — so a cold/cleared index (Repair)
      // restores any object missing from the bucket, cheaply when it's already there.
      const stored = await this.objects.putFile(data);

      const existing = this.head(manifest.paths[e.path]);
      if (existing && !existing.deleted && existing.contentHash === stored.contentHash) {
        // Object now ensured present; content unchanged -> no duplicate history version.
        await this.markClean(e.path, existing, e.size);
        continue;
      }

      // parent = what we last synced for this path (the shared base both sides edited from).
      const parentHash = local?.contentHash ?? existing?.contentHash ?? null;
      this.appendVersion(manifest, e.path, {
        objectKey: stored.objectKey,
        isRecipe: stored.isRecipe,
        contentHash: stored.contentHash,
        size: stored.size,
        mtime: e.mtime,
        parentHash,
        deleted: false,
      });
      await this.markClean(e.path, manifest.paths[e.path].history.at(-1)!, e.size);
      result.uploaded++;
    }

    // Local deletions: indexed shared paths no longer present -> tombstone.
    for (const rec of await this.index.all()) {
      if (rec.deleted || !SHARED_TIERS.has(rec.tier)) continue;
      if (present.has(rec.path)) continue;
      const existing = this.head(manifest.paths[rec.path]);
      if (existing?.deleted) continue;
      this.appendVersion(manifest, rec.path, {
        objectKey: existing?.objectKey ?? "",
        isRecipe: false,
        contentHash: existing?.contentHash ?? "",
        size: 0,
        mtime: this.now(),
        parentHash: existing ? existing.contentHash : null,
        deleted: true,
      });
      await this.index.put({ ...rec, deleted: true });
    }

    await this.manifests.writeDeviceManifest(this.device, manifest);
    const { merged, conflicts } = await this.manifests.computeMerged();
    await this.manifests.advanceMerged(merged);
    result.conflicts = conflicts;
  }

  private appendVersion(
    manifest: Manifest,
    path: string,
    rec: Omit<HistoryRecord, "version" | "author" | "ts">,
  ): void {
    const entry = manifest.paths[path] ?? { history: [], head: -1 };
    const version = entry.history.length;
    entry.history.push({ ...rec, version, author: this.device, ts: this.now() });
    entry.head = entry.history.length - 1;
    manifest.paths[path] = entry;
  }

  private async markClean(path: string, head: HistoryRecord, size: number): Promise<void> {
    await this.index.markClean({
      path,
      size,
      mtime: head.mtime,
      contentHash: head.contentHash,
      objectKey: head.objectKey,
      isRecipe: head.isRecipe,
      tier: "CONTENT",
      lastSeen: 0,
    });
  }

  private emptyManifest(): Manifest {
    return { schema: 1, generatedAt: 0, device: this.device, paths: {} };
  }
}
