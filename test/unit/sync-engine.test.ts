import { describe, test, expect, beforeEach } from "vitest";
import { SyncEngine } from "../../src/engine/sync-engine";
import { ObjectStore } from "../../src/store/object-store";
import { ManifestStore } from "../../src/store/manifest-store";
import { LocalIndex, InMemoryIndexBackend } from "../../src/engine/local-index";
import { MemoryBackend } from "../helpers/memory-backend";
import { MemoryVaultFS } from "../helpers/memory-vault-fs";
import { makeClassifyOptions } from "../../src/engine/file-classifier";
import { defaultVaultConfig } from "../../src/store/vault-config";
import {
  deriveSubkeys,
  deriveMasterKey,
  generateKdfParams,
  type Subkeys,
} from "../../src/crypto/keys";

// One shared "bucket" (MemoryBackend); two devices each with their own vault + index.
let bucket: MemoryBackend;
let subkeys: Subkeys;
let clock: number;
const now = () => ++clock;

function device(name: string) {
  const opts = makeClassifyOptions(defaultVaultConfig("v", name), "littlewooly-sync");
  const fs = new MemoryVaultFS(opts);
  const objects = new ObjectStore(bucket, subkeys);
  const manifests = new ManifestStore(bucket, subkeys.manifestKey);
  const index = new LocalIndex(new InMemoryIndexBackend());
  const engine = new SyncEngine(name, fs, objects, manifests, index, now);
  return { fs, engine };
}

beforeEach(async () => {
  bucket = new MemoryBackend();
  clock = 1000;
  const p = generateKdfParams();
  p.memoryKiB = 8192;
  p.iterations = 1;
  subkeys = await deriveSubkeys(await deriveMasterKey("pw", p));
});

describe("SyncEngine shared sync", () => {
  test("a file created on one device appears on another", async () => {
    const a = device("desktop");
    const b = device("mobile");
    a.fs.set("Notes/hi.md", "hello", 100);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.fs.exists("Notes/hi.md")).toBe(true);
    expect(new TextDecoder().decode(await b.fs.read("Notes/hi.md"))).toBe("hello");
  });

  test("a deletion soft-deletes (trashes) on the other device", async () => {
    const a = device("desktop");
    const b = device("mobile");
    a.fs.set("gone.md", "bye", 100);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.fs.exists("gone.md")).toBe(true);

    await a.fs.trash("gone.md"); // user deletes on A
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.fs.exists("gone.md")).toBe(false);
    expect(b.fs.trashed.has("gone.md")).toBe(true); // went to trash, not hard-deleted
  });

  test("concurrent edits keep both versions via a conflict copy", async () => {
    const a = device("desktop");
    const b = device("mobile");
    a.fs.set("note.md", "base", 100);
    await a.engine.sync();
    await b.engine.sync(); // both now have base

    a.fs.set("note.md", "edit-from-A", 200);
    b.fs.set("note.md", "edit-from-B", 201);
    await a.engine.sync(); // A pushes its edit
    const bResult = await b.engine.sync(); // B pulls -> divergence -> conflict copy

    expect(bResult.conflictCopies.length).toBe(1);
    // B keeps a copy of its own edit and adopts the winning head; nothing lost.
    const all = [...b.fs.files.keys()];
    const copy = all.find((p) => p.includes("conflict copy"));
    expect(copy).toBeTruthy();
    expect(new TextDecoder().decode(await b.fs.read(copy!))).toBe("edit-from-B");
  });

  test("DEVICE_CONFIG never crosses devices (the .obsidian thrash fix)", async () => {
    const a = device("desktop");
    const b = device("mobile");
    a.fs.set("Notes/shared.md", "x", 100);
    a.fs.set(".obsidian/workspace.json", '{"desktop":true}', 100); // DEVICE_CONFIG
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.fs.exists("Notes/shared.md")).toBe(true); // shared content arrives
    expect(await b.fs.exists(".obsidian/workspace.json")).toBe(false); // device config does NOT
  });
});
