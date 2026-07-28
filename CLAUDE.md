# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Little Wooly Sync** — a desktop-first Obsidian plugin that backs up, in real time, **ALL**
files in a vault to any S3-compatible bucket, **end-to-end encrypted**, with **provable
coverage** and **no silent caps**. Part of the Little Wooly suite.

North star, in priority order:
1. **Strong client-side E2E encryption** — the bucket never sees plaintext (content or names).
2. **Total, verifiable coverage** — every file/folder/hidden item, any extension, any size.
   Nothing is ever skipped silently. The coverage-audit command must be able to *prove* it.
3. **Reliable multi-device sync** with safe conflict handling (nothing silently lost).
4. **A focused, simple UX** — deliberately the opposite of the over-complicated reference.

The full design lives in `~/.claude/plans/quizzical-twirling-squirrel.md` (the approved plan).

## Hard rules

- **Never commit secrets.** `.env`, `.test.env`, vault data, keys, and `main.js` are gitignored.
  History will be purged before public release, but do not rely on that — keep secrets out.
- **`archive/examples/obsidian-livesync/` is read-only reference.** It is **local-only and
  gitignored** — present on disk, never committed. Study it; never import or extend it. It is a working plugin with great crypto/S3 ideas but the two flaws we exist to
  fix: it silently drops files (opt-in hidden sync, size caps, default exclusions) and it is
  over-complicated (~230 settings, CouchDB/P2P/CLI). We are the lean, total-coverage answer.
- **No silent limits.** Large files are chunked, never skipped. We impose no file/bucket cap.
- **Crypto:** native WebCrypto + `hash-wasm` (Argon2id) only. Never hand-roll primitives.

## Commands

- `npm run dev` — esbuild watch build (writes `main.js`).
- `npm run build` — typecheck + production bundle.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` / `npm run format` / `npm run format:check`.
- `npm run test` / `npm run test:unit` / `npm run test:integration` — vitest.
- `npm run test:minio:up` / `:down` — local MinIO container for S3 integration tests.
- `npm run gates` — typecheck + lint + format:check + unit tests (run before declaring done).
- A single test: `npx vitest run test/unit/object-cipher.test.ts` (or `-t "<name>"`).

## Architecture (see plan for detail)

Bundled by esbuild to a single CJS `main.js`; desktop-only (`isDesktopOnly: true`) so we can
use Node `fs`, `chokidar`, and the S3 SDK's Node HTTP handler (no Electron-renderer CORS).

- `src/crypto/` — `keys.ts` (Argon2id KDF → HKDF subkeys → verifier), `object-cipher.ts`
  (convergent AES-256-GCM: deterministic nonce + secret-keyed HMAC names → dedup + idempotency).
- `src/store/` — `s3-client.ts` (Node-HTTP-handler SDK wrapper, path/virtual style, custom
  headers, conditional-PUT probe, `testConnection`), `prefixed-backend.ts` (`lwsync/<vault>/`
  scoping), `object-store.ts` (chunking, content-addressed dedup, idempotent PUT, GC),
  `manifest-store.ts` (per-device append-only logs + CAS-merged global manifest, tombstones),
  `vault-config.ts` (encrypted `meta/vaultconfig` for cross-device bootstrap; no secrets).
- `src/engine/` — `file-classifier.ts` (**central**: CONTENT / SHARED_CONFIG / DEVICE_CONFIG /
  EXCLUDE — device-specific config is namespaced per device and never auto-applied elsewhere),
  `vault-walker.ts` (dual fs + adapter enumeration), `local-index.ts` (IndexedDB cache,
  rebuildable), `change-detector.ts` (vault events + chokidar + periodic scan + daily deep
  rehash), `sync-engine.ts` (pull-merge before push), `conflict-resolver.ts` (conflict-copy +
  JSON 3-way merge), `trash.ts` (soft-delete via `vault.trash`), `coverage-auditor.ts`
  (three-way live/manifest/bucket diff + size reconciliation), `repair.ts` (additive fix).
- `src/ui/` — `setup-wizard.ts` (≤3 screens; new-vault vs connect-existing + restore choice),
  `settings-tab.ts` (slim, progressive), `status-bar.ts`.
- `src/main.ts` — entry/wiring. `src/types.ts` — shared, dependency-free types.

### Key invariants
- **Manifest source of truth = per-device append-only logs**; the merged manifest is derived
  and advanced by S3 conditional PUT (CAS). If a backend ignores conditional PUT, the merged
  manifest is fully rebuildable from device logs — a lost race costs a recompute, never data.
- **Objects are immutable & content-addressed**; a change makes a new object, old versions stay
  (history/restore). Convergent encryption makes identical plaintext dedupe to one object.
- **Coverage is proven, not assumed**: every walked item is recorded with INCLUDE/EXCLUDE(reason);
  deletions need absence in *both* walkers across *two* scans before tombstoning.

## Testing layout
- `test/unit/` — pure-logic tests (crypto, classifier, manifest fold, audit diff).
- `test/integration/` — against local MinIO (`test:minio:up` first; reads `.test.env`).
- `test/shell/` — MinIO start/stop scripts (ported from the reference's pattern).
