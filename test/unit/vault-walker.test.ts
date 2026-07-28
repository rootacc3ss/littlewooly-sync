import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { walkVault } from "../../src/engine/vault-walker";
import { makeClassifyOptions } from "../../src/engine/file-classifier";
import { defaultVaultConfig } from "../../src/store/vault-config";

let root: string;
const opts = makeClassifyOptions(defaultVaultConfig("v", "desktop"), "littlewooly-sync");

async function write(rel: string, content = "x") {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "lws-walk-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("walkVault", () => {
  test("covers content, shared config, and device config; excludes noise with reasons", async () => {
    await write("Notes/a.md");
    await write("attach/pic.png");
    await write(".obsidian/community-plugins.json");
    await write(".obsidian/workspace.json");
    await write(".git/config");
    await write("node_modules/dep/index.js");
    await write(".obsidian/plugins/littlewooly-sync/data.json");

    const { entries, roster } = await walkVault(root, opts);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.tier]));

    expect(byPath["Notes/a.md"]).toBe("CONTENT");
    expect(byPath["attach/pic.png"]).toBe("CONTENT");
    expect(byPath[".obsidian/community-plugins.json"]).toBe("SHARED_CONFIG");
    expect(byPath[".obsidian/workspace.json"]).toBe("DEVICE_CONFIG");

    // excluded items appear in the roster (never silently dropped) and not in entries.
    expect(byPath[".git/config"]).toBeUndefined();
    const rosterPaths = roster.map((r) => r.path);
    expect(rosterPaths).toContain(".git/");
    expect(rosterPaths).toContain("node_modules/");
    expect(roster.every((r) => r.reason.length > 0)).toBe(true);
  });

  test("records real sizes and is deterministically ordered", async () => {
    await write("b.md", "hello");
    await write("a.md", "hi");
    const { entries } = await walkVault(root, opts);
    expect(entries.map((e) => e.path)).toEqual(["a.md", "b.md"]);
    expect(entries.find((e) => e.path === "b.md")!.size).toBe(5);
  });
});
