// Authoritative enumeration of EVERY item in the vault via Node fs (desktop). Records
// each path with its tier, or with an exclusion reason — nothing is dropped silently.
// Symlinks/sockets/devices are excluded by default (recorded with a reason).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { classify, type ClassifyOptions } from "./file-classifier";
import type { FileTier } from "../types";

export interface WalkEntry {
  path: string; // vault-relative, forward-slash
  tier: FileTier;
  size: number;
  mtime: number;
}

export interface RosterItem {
  path: string;
  reason: string;
}

export interface WalkResult {
  entries: WalkEntry[];
  roster: RosterItem[];
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

export async function walkVault(root: string, opts: ClassifyOptions): Promise<WalkResult> {
  const entries: WalkEntry[] = [];
  const roster: RosterItem[] = [];

  async function walk(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: treat as unknown, never as "absent"
    }
    for (const d of dirents) {
      const abs = path.join(dir, d.name);
      const rel = toPosix(path.relative(root, abs));

      if (d.isSymbolicLink()) {
        roster.push({ path: rel, reason: "symlink (excluded by default)" });
        continue;
      }
      if (d.isDirectory()) {
        const c = classify(rel, opts);
        if (c.tier === "EXCLUDE") {
          roster.push({ path: rel + "/", reason: c.reason });
          continue;
        }
        await walk(abs);
        continue;
      }
      if (!d.isFile()) {
        roster.push({ path: rel, reason: "not a regular file" });
        continue;
      }

      const c = classify(rel, opts);
      if (c.tier === "EXCLUDE") {
        roster.push({ path: rel, reason: c.reason });
        continue;
      }
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        roster.push({ path: rel, reason: "stat failed (unknown, not skipped)" });
        continue;
      }
      entries.push({ path: rel, tier: c.tier, size: st.size, mtime: Math.floor(st.mtimeMs) });
    }
  }

  await walk(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, roster };
}
