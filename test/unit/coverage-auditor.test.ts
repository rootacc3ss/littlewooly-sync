import { describe, test, expect } from "vitest";
import { auditCoverage, type AuditInputs } from "../../src/engine/coverage-auditor";

function inputs(over: Partial<AuditInputs> = {}): AuditInputs {
  return {
    live: [{ path: "a.md", size: 100, hash: "ha" }],
    heads: { "a.md": { contentHash: "ha", objectKey: "ka", deleted: false, size: 100 } },
    bucketObjectKeys: new Set(["ka"]),
    storedBytes: 70,
    ...over,
  };
}

describe("auditCoverage", () => {
  test("clean vault -> FULL COVERAGE, zero critical", () => {
    const r = auditCoverage(inputs());
    expect(r.criticalCount).toBe(0);
    expect(r.verdict).toMatch(/FULL COVERAGE/);
    expect(r.findings.MISSING_FROM_BACKUP).toEqual([]);
  });

  test("a live file with no manifest head is MISSING_FROM_BACKUP (critical)", () => {
    const r = auditCoverage(
      inputs({
        live: [
          { path: "a.md", size: 1, hash: "ha" },
          { path: "new.md", size: 1, hash: "hn" },
        ],
      }),
    );
    expect(r.findings.MISSING_FROM_BACKUP).toContain("new.md");
    expect(r.criticalCount).toBeGreaterThan(0);
  });

  test("a head pointing at a missing object is MISSING_OBJECT (critical)", () => {
    const r = auditCoverage(inputs({ bucketObjectKeys: new Set<string>() }));
    expect(r.findings.MISSING_OBJECT).toContain("a.md");
    expect(r.criticalCount).toBeGreaterThan(0);
  });

  test("a backed-up file absent locally is MISSING_LOCALLY (not critical)", () => {
    const r = auditCoverage(inputs({ live: [] }));
    expect(r.findings.MISSING_LOCALLY).toContain("a.md");
  });

  test("a local file differing from its head is STALE_IN_BACKUP", () => {
    const r = auditCoverage(inputs({ live: [{ path: "a.md", size: 1, hash: "DIFFERENT" }] }));
    expect(r.findings.STALE_IN_BACKUP).toContain("a.md");
  });

  test("reports the plaintext-vs-stored size reconciliation", () => {
    const r = auditCoverage(inputs());
    expect(r.plaintextBytes).toBe(100);
    expect(r.storedBytes).toBe(70);
    expect(r.ratio).toBeCloseTo(0.7, 5);
  });

  test("a live file whose head is a tombstone is TOMBSTONE_RESURRECTED", () => {
    const r = auditCoverage(
      inputs({ heads: { "a.md": { contentHash: "ha", objectKey: "ka", deleted: true, size: 0 } } }),
    );
    expect(r.findings.TOMBSTONE_RESURRECTED).toContain("a.md");
  });
});
