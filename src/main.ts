import { Notice, Plugin } from "obsidian";
import { Controller, DEFAULT_SETTINGS, type LwsSettings } from "./controller";
import { LwsSettingTab } from "./ui/settings-tab";
import { SetupWizard } from "./ui/setup-wizard";
import { StatusBar } from "./ui/status-bar";
import { buildDebugReport } from "./debug";

export default class LittleWoolySyncPlugin extends Plugin {
  settings!: LwsSettings;
  controller!: Controller;
  private status!: StatusBar;
  private saveTimer: number | null = null;
  private syncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.controller = new Controller(this.app, this.settings);
    this.status = new StatusBar(this.addStatusBarItem());

    this.addSettingTab(new LwsSettingTab(this.app, this));
    this.addRibbonIcon("sheep", "Little Wooly Sync", () => {
      if (this.settings.configured) this.runSync();
      else this.openSetupWizard();
    });

    this.addCommand({
      id: "lws-setup",
      name: "Set up / connect",
      callback: () => this.openSetupWizard(),
    });
    this.addCommand({ id: "lws-sync", name: "Sync now", callback: () => this.runSync() });
    this.addCommand({ id: "lws-audit", name: "Coverage audit", callback: () => this.runAudit() });
    this.addCommand({ id: "lws-repair", name: "Repair", callback: () => this.runRepair() });
    this.addCommand({
      id: "lws-debug",
      name: "Write debug report",
      callback: () => this.writeDebugReport(),
    });

    this.app.workspace.onLayoutReady(async () => {
      if (!this.settings.configured) {
        new Notice("Little Wooly Sync: open settings to set up your encrypted backup.");
        return;
      }
      try {
        const ok = await this.controller.unlock();
        if (!ok) {
          this.status.set("error", "wrong passphrase — re-run setup");
          return;
        }
        if (this.settings.syncOnStart) await this.runSync();
        else this.status.set("idle", "ready");
      } catch (e) {
        this.status.set("error", (e as Error).message);
      }
    });

    if (this.settings.syncIntervalSec > 0) {
      this.registerInterval(
        window.setInterval(() => this.runSync(), this.settings.syncIntervalSec * 1000),
      );
    }
    if (this.settings.syncOnSave) {
      const sched = () => this.scheduleSync();
      this.registerEvent(this.app.vault.on("modify", sched));
      this.registerEvent(this.app.vault.on("create", sched));
      this.registerEvent(this.app.vault.on("delete", sched));
      this.registerEvent(this.app.vault.on("rename", sched));
    }
  }

  onunload(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
  }

  openSetupWizard(): void {
    new SetupWizard(this.app, this.controller, this.settings, async () => {
      await this.saveSettings();
      await this.runSync();
    }).open();
  }

  private scheduleSync(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.runSync(), 4000); // debounce editor saves
  }

  async runSync(): Promise<void> {
    if (!this.controller.ready || this.syncing) return;
    this.syncing = true;
    this.status.set("syncing", "syncing…");
    try {
      const r = await this.controller.sync();
      const note =
        `↑${r.uploaded} ↓${r.downloaded} 🗑${r.deletedLocal}` +
        (r.conflictCopies.length ? ` ⚠${r.conflictCopies.length} conflict copies` : "");
      this.status.set(r.conflictCopies.length ? "warn" : "ok", note);
      if (r.conflictCopies.length)
        new Notice(`Sync kept ${r.conflictCopies.length} conflict copies.`);
    } catch (e) {
      this.status.set("error", (e as Error).message);
      new Notice(`Little Wooly Sync error: ${(e as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }

  async runAudit(): Promise<void> {
    if (!this.controller.ready) return void new Notice("Not connected yet.");
    this.status.set("syncing", "auditing…");
    try {
      const r = await this.controller.audit(true);
      this.status.set(r.criticalCount ? "error" : "ok", r.verdict);
      new Notice(
        `${r.verdict}\nplaintext ${(r.plaintextBytes / 1e6).toFixed(1)}MB → stored ${(r.storedBytes / 1e6).toFixed(1)}MB (ratio ${r.ratio.toFixed(2)})`,
        10000,
      );
    } catch (e) {
      this.status.set("error", (e as Error).message);
    }
  }

  async runRepair(): Promise<void> {
    if (!this.controller.ready) return void new Notice("Not connected yet.");
    this.status.set("syncing", "repairing…");
    try {
      const { before, after, reuploaded } = await this.controller.repair();
      this.status.set(after.criticalCount ? "warn" : "ok", after.verdict);
      new Notice(
        `Repair: ${before.criticalCount}→${after.criticalCount} critical, re-ensured ${reuploaded} files.\n${after.verdict}`,
        10000,
      );
    } catch (e) {
      this.status.set("error", (e as Error).message);
    }
  }

  async writeDebugReport(): Promise<void> {
    const report = await buildDebugReport(this.controller, this.settings, Date.now());
    await this.app.vault.adapter.write("littlewooly-sync-debug.md", report);
    new Notice("Wrote littlewooly-sync-debug.md");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
