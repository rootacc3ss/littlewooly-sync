// Debug helpers: a one-shot human-readable report of plugin + sync + coverage state, for
// "give it a shot" troubleshooting. Secrets are redacted.

import type { Controller, LwsSettings } from "./controller";

function redact(s: string): string {
  if (!s) return "(empty)";
  return s.length <= 4 ? "****" : s.slice(0, 2) + "…" + s.slice(-2);
}

export async function buildDebugReport(
  controller: Controller,
  settings: LwsSettings,
  stamp: number,
): Promise<string> {
  const lines: string[] = [];
  const L = (s = "") => lines.push(s);

  L("# Little Wooly Sync — debug report");
  L(`generated: ${new Date(stamp).toISOString()}`);
  L("");
  L("## Config");
  L(`- configured: ${settings.configured}`);
  L(`- unlocked/ready: ${controller.ready}`);
  L(`- vaultName: ${settings.vaultName}  (prefix: lwsync/${settings.vaultName}/)`);
  L(`- deviceName: ${settings.deviceName}`);
  L(`- endpoint: ${settings.s3.endpoint}`);
  L(`- bucket: ${settings.s3.bucket}`);
  L(`- region: ${settings.s3.region}`);
  L(`- addressing: ${settings.s3.forcePathStyle ? "path-style" : "virtual-hosted"}`);
  L(`- accessKeyId: ${redact(settings.s3.accessKeyId)}`);
  L(
    `- triggers: onStart=${settings.syncOnStart} onSave=${settings.syncOnSave} interval=${settings.syncIntervalSec}s`,
  );
  L("");

  L("## Connectivity");
  try {
    await controller.testConnection();
    L("- S3 testConnection: OK");
  } catch (e) {
    L(`- S3 testConnection: FAILED — ${(e as Error).message}`);
  }
  L("");

  if (controller.ready) {
    L("## Coverage audit (deep)");
    try {
      const r = await controller.audit(true);
      L(`- verdict: ${r.verdict}`);
      L(`- plaintext bytes: ${r.plaintextBytes}`);
      L(`- stored bytes: ${r.storedBytes}`);
      L(`- ratio (stored/plaintext): ${r.ratio.toFixed(3)}`);
      for (const [bucket, paths] of Object.entries(r.findings)) {
        if (paths.length) L(`- ${bucket}: ${paths.length} — ${paths.slice(0, 10).join(", ")}`);
      }
    } catch (e) {
      L(`- audit FAILED — ${(e as Error).message}`);
    }
    L("");
    L("## Device-config backups");
    try {
      L(
        `- devices with backups: ${(await controller.listBackedUpDevices()).join(", ") || "(none)"}`,
      );
    } catch (e) {
      L(`- listing FAILED — ${(e as Error).message}`);
    }
  } else {
    L("(not unlocked — configure/connect to see coverage)");
  }

  return lines.join("\n");
}
