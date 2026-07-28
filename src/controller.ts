// The wiring brain: builds the full stack from settings + passphrase and exposes the
// operations the UI/commands call (connect, sync, audit, repair, device-config backup/
// restore, archive). Secrets live only here/in plugin data; nothing secret is uploaded.

import type { App } from "obsidian";
import type { S3Config, VaultConfig } from "./types";
import { S3Backend } from "./store/s3-client";
import { PrefixedBackend } from "./store/prefixed-backend";
import { ObjectStore } from "./store/object-store";
import { ManifestStore } from "./store/manifest-store";
import { VaultConfigStore, defaultVaultConfig } from "./store/vault-config";
import { DeviceConfigStore } from "./store/device-config-store";
import { ArchiveJob } from "./engine/archive-job";
import {
  deriveMasterKey,
  deriveSubkeys,
  generateKdfParams,
  createVerifier,
  checkVerifier,
  type Subkeys,
  type KdfParams,
  type Verifier,
} from "./crypto/keys";
import { makeClassifyOptions } from "./engine/file-classifier";
import { ObsidianVaultFS } from "./engine/obsidian-vault-fs";
import { LocalIndex } from "./engine/local-index";
import { IdbIndexBackend } from "./engine/idb-index";
import { SyncEngine, type SyncResult } from "./engine/sync-engine";
import { Repair, type RepairResult } from "./engine/repair";
import { runAudit } from "./engine/coverage-service";
import type { AuditReport } from "./engine/coverage-auditor";

export const PLUGIN_ID = "littlewooly-sync";

export interface LwsSettings {
  s3: S3Config;
  vaultName: string;
  deviceName: string;
  /** device-local only; never synced (our plugin dir is excluded from coverage). */
  passphrase: string;
  configured: boolean;
  syncIntervalSec: number;
  syncOnStart: boolean;
  syncOnSave: boolean;
}

export const DEFAULT_SETTINGS: LwsSettings = {
  s3: {
    endpoint: "",
    region: "us-east-1",
    accessKeyId: "",
    secretAccessKey: "",
    bucket: "",
    forcePathStyle: true,
  },
  vaultName: "",
  deviceName: "",
  passphrase: "",
  configured: false,
  syncIntervalSec: 300,
  syncOnStart: true,
  syncOnSave: true,
};

interface Stack {
  prefixed: PrefixedBackend;
  s3: S3Backend;
  subkeys: Subkeys;
  objects: ObjectStore;
  manifests: ManifestStore;
  vaultConfig: VaultConfigStore;
  deviceConfig: DeviceConfigStore;
  archive: ArchiveJob;
  fs: ObsidianVaultFS;
  index: LocalIndex;
  engine: SyncEngine;
  repair: Repair;
  config: VaultConfig;
}

export class Controller {
  private stack: Stack | null = null;

  constructor(
    private app: App,
    private settings: LwsSettings,
  ) {}

  get ready(): boolean {
    return this.stack !== null;
  }

  private prefix(): string {
    return `lwsync/${this.settings.vaultName}`;
  }

  private rawBackend(): S3Backend {
    return new S3Backend(this.settings.s3);
  }

  async testConnection(): Promise<void> {
    await this.rawBackend().testConnection();
  }

  /** Is there already an initialized vault at this bucket+prefix? */
  async remoteExists(): Promise<boolean> {
    const prefixed = new PrefixedBackend(this.rawBackend(), this.prefix());
    return new VaultConfigStore(prefixed).isInitialized();
  }

  /** First-time setup of a brand-new vault. */
  async initNewVault(passphrase: string): Promise<void> {
    const params = generateKdfParams();
    const subkeys = await deriveSubkeys(await deriveMasterKey(passphrase, params));
    const verifier = await createVerifier(subkeys.verifyKey);

    const prefixed = new PrefixedBackend(this.rawBackend(), this.prefix());
    const vc = new VaultConfigStore(prefixed);
    await vc.writeKeyParams({ params, verifier });
    const config = defaultVaultConfig(this.settings.vaultName, this.settings.deviceName);
    await vc.writeConfig(subkeys.manifestKey, config);

    this.settings.passphrase = passphrase;
    this.buildStack(subkeys, config);
  }

  /** Connect to an existing vault: verify passphrase against the remote verifier. */
  async connectExisting(passphrase: string): Promise<boolean> {
    const prefixed = new PrefixedBackend(this.rawBackend(), this.prefix());
    const vc = new VaultConfigStore(prefixed);
    const kp = await vc.readKeyParams();
    if (!kp) throw new Error("No Little Wooly vault found at this bucket/prefix.");

    const subkeys = await deriveSubkeys(await deriveMasterKey(passphrase, kp.params as KdfParams));
    if (!(await checkVerifier(subkeys.verifyKey, kp.verifier as Verifier))) return false;

    const config =
      (await vc.readConfig(subkeys.manifestKey)) ??
      defaultVaultConfig(this.settings.vaultName, this.settings.deviceName);
    await vc.writeConfig(subkeys.manifestKey, {
      ...config,
      devices: config.devices.includes(this.settings.deviceName)
        ? config.devices
        : [...config.devices, this.settings.deviceName],
    });
    this.settings.passphrase = passphrase;
    this.buildStack(subkeys, config);
    return true;
  }

  /** Rebuild the stack from stored settings + passphrase (called on load when configured). */
  async unlock(): Promise<boolean> {
    return this.connectExisting(this.settings.passphrase);
  }

  private buildStack(subkeys: Subkeys, config: VaultConfig): void {
    const prefixed = new PrefixedBackend(this.rawBackend(), this.prefix());
    const opts = makeClassifyOptions(config, PLUGIN_ID);
    const fs = new ObsidianVaultFS(this.app, opts);
    const objects = new ObjectStore(prefixed, subkeys);
    const manifests = new ManifestStore(prefixed, subkeys.manifestKey);
    const index = new LocalIndex(new IdbIndexBackend(`lws-${this.settings.vaultName}`));
    const engine = new SyncEngine(this.settings.deviceName, fs, objects, manifests, index);
    this.stack = {
      prefixed,
      s3: this.rawBackend(),
      subkeys,
      objects,
      manifests,
      vaultConfig: new VaultConfigStore(prefixed),
      deviceConfig: new DeviceConfigStore(prefixed, subkeys),
      archive: new ArchiveJob(prefixed, subkeys),
      fs,
      index,
      engine,
      repair: new Repair(engine, objects, index, fs, manifests, prefixed),
      config,
    };
  }

  private require(): Stack {
    if (!this.stack) throw new Error("Little Wooly Sync is not unlocked/configured.");
    return this.stack;
  }

  async sync(): Promise<SyncResult> {
    const s = this.require();
    const result = await s.engine.sync();
    await s.deviceConfig.backup(s.fs, this.settings.deviceName); // device config backed up each sync
    return result;
  }

  audit(deep = true): Promise<AuditReport> {
    const s = this.require();
    return runAudit(s.fs, s.manifests, s.prefixed, { deep });
  }

  repair(): Promise<RepairResult> {
    return this.require().repair.repair();
  }

  backupDeviceConfig(): Promise<number> {
    const s = this.require();
    return s.deviceConfig.backup(s.fs, this.settings.deviceName);
  }

  listBackedUpDevices(): Promise<string[]> {
    return this.require().deviceConfig.listBackedUpDevices();
  }

  restoreDeviceConfig(fromDevice: string): Promise<number> {
    const s = this.require();
    return s.deviceConfig.restore(s.fs, fromDevice);
  }

  async createArchive(stamp: number, keep = 23): Promise<string> {
    const s = this.require();
    const key = await s.archive.create(s.fs, stamp);
    await s.archive.prune(keep);
    return key;
  }
}
