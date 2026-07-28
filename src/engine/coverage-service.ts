// Gathers the three sources of truth (live vault, merged manifest, bucket listing) into
// AuditInputs and runs the pure auditor. Used by the Coverage Audit command and by Repair.

import type { ObjectBackend } from "../store/backend";
import type { ManifestStore } from "../store/manifest-store";
import type { VaultFS } from "./vault-fs";
import { sha256, toHex } from "../crypto/object-cipher";
import {
  auditCoverage,
  type AuditInputs,
  type AuditReport,
  type HeadEntry,
} from "./coverage-auditor";

const SHARED_TIERS = new Set(["CONTENT", "SHARED_CONFIG"]);

function objectKeyFromPath(key: string): string {
  // objects/<fanout>/<objectKey>
  return key.slice(key.lastIndexOf("/") + 1);
}

export async function gatherAuditInputs(
  fs: VaultFS,
  manifests: ManifestStore,
  backend: ObjectBackend,
  opts: { deep: boolean },
): Promise<AuditInputs> {
  const entries = (await fs.walk()).filter((e) => SHARED_TIERS.has(e.tier));
  const live = [];
  for (const e of entries) {
    const hash = opts.deep ? toHex(await sha256(await fs.read(e.path))) : undefined;
    live.push({ path: e.path, size: e.size, hash });
  }

  const merged = await manifests.readMerged();
  const heads: Record<string, HeadEntry> = {};
  if (merged) {
    for (const [path, entry] of Object.entries(merged.paths)) {
      const h = entry.history[entry.head];
      if (!h) continue;
      heads[path] = {
        contentHash: h.contentHash,
        objectKey: h.objectKey,
        deleted: h.deleted,
        size: h.size,
      };
    }
  }

  const objects = await backend.list("objects/");
  const bucketObjectKeys = new Set(objects.map((o) => objectKeyFromPath(o.key)));
  const storedBytes = objects.reduce((sum, o) => sum + o.size, 0);

  return { live, heads, bucketObjectKeys, storedBytes };
}

export async function runAudit(
  fs: VaultFS,
  manifests: ManifestStore,
  backend: ObjectBackend,
  opts: { deep: boolean } = { deep: true },
): Promise<AuditReport> {
  return auditCoverage(await gatherAuditInputs(fs, manifests, backend, opts));
}
