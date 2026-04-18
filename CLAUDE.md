# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # Browser dev server (Vite, HMR) — http://localhost:5173
npm run build         # tsc type-check then Vite bundle
npm run preview       # Serve the production build locally
npm run tauri:dev     # Launch native app (starts Vite + Rust, first run compiles ~60s)
npm run tauri:build   # Build distributable .app → src-tauri/target/release/bundle/macos/
npx tsc --noEmit      # Type-check only (no test runner configured)
```

`tauri:dev` requires port 5173 to be free. Kill any stale dev server first:
```bash
lsof -ti :5173 | xargs kill -9
```

## What this is

Dissociative System Witness — a local, private psychology assessment tracker. Runs MID-60, MID-162, PHQ-9, GAD-7, FFMQ-15, DSS, and custom assessments, stores answers in SQLite, shows scores and deltas over time. No backend, no auth. Version tracked in `src/version.ts`.

## Architecture

**Stack:** Vanilla TypeScript + Vite + Tauri 2. No UI framework. sql.js (SQLite WASM) in-memory, persisted to disk via Tauri's fs plugin (native app) or IndexedDB (`com.frontswitchstudio.dsw`) in browser.

**Routing:** `src/router.ts` — hash-based (`#/assessment/mid-60`). `route()` registers handlers; `navigate()` changes the hash.

**Database:** `src/db.ts` — wraps sql.js. Detects Tauri via `window.__TAURI_INTERNALS__`. In Tauri: reads/writes `~/Library/Application Support/com.frontswitchstudio.dsw/dsw.sqlite`. In browser: uses IndexedDB. Writes debounced 150ms. Schema migrations run via `ALTER TABLE` with try/catch on each.

**Questions:** Loaded from `public/data/<dataset>.psv` at runtime. PSV format: `id|category|subclass|flags|question text`. Lines starting with `#` are comments. Flags are comma-separated lowercase strings. Parsed and cached by `src/questions.ts`. Key exports: `hasFlag(q, flag)`, `getDatasetMeta(dataset)`, `computeAssessmentVersion(questions)`.

**PSV metadata** — `# @key: value` comment lines at the top of each PSV file, parsed into `DatasetMeta`:
- `@title` — full display name
- `@tagline` — short descriptor shown on home card
- `@frequency` — target days between runs (drives "take now" / "in N days" badge)
- `@max` — displayed scale ceiling (e.g. 100, 27, 21)
- `@normalize` — canonical question count used as divisor for normalized scoring (e.g. 162, 60); omit for raw sum
- `@item-max` — per-question max value (default 4); used in reverse scoring and normalized formula
- `@secondary: flag=Label` — declares a secondary score group; one line per group. Questions get the flag in their flags field. Repeatable for multiple groups.

**Scoring** (`src/scoring.ts`):
- Normalized datasets (have both `@max` and `@normalize`): `total = (sum × (max / itemMax)) / normalize`
- Raw sum datasets (have only `@max`): `total = sum`
- Jump threshold: 8% of `@max` for totals; 0.5 for subclass means
- `obsolete`-flagged questions are excluded from scoring; callers filter before passing to `computeScore`
- Secondary scores: `Score.secondaries` array, one entry per `@secondary` group with answered questions. Each entry: `{ flag, label, sum, total (mean), scale, count }`.
- Reverse scoring: `itemMax - raw` (uses per-dataset `itemMax`, not hardcoded 4)

**Dataset config** (`src/datasets.ts`): scale labels (answer text), preamble, severity bands per dataset. `getSeverityBand(dataset, score)` returns band for highlighting.

**Emotes** (`src/emotes.ts`): bitmask per question per run, stored in `emotes` table. ❓(1) ❌(2) 🔥(4) 💜(8) 🌱(16) 🔍(32). `emoteIcons(mask)` returns emoji string.

**Dormancy** (`src/dormancy.ts`): `computeDormant()` marks questions dormant if scored 0 in each of last 2 completed runs, or flagged `dormant` in PSV. `anchor` flag overrides. `selectDormantSample()` picks 10% (min 1) seeded by run ID. `seededShuffle()` for consistent shuffle per run. Obsolete questions are excluded before calling these. Uses `itemMax` from metadata for reverse-score normalization.

**Assessment versioning** (`src/db.ts`):
- Each run stores an `assessment_version` — an 8-char SHA-256 hash of the active (non-obsolete) question content (id, sorted flags, text) at run creation time.
- `computeAssessmentVersion(questions)` in `src/questions.ts` computes the hash via Web Crypto API.
- `snapshotVersion(dataset, activeQuestions, hash)` — stores a delta snapshot. First call for a dataset writes all questions; subsequent calls write only changed questions + tombstones (null `text`) for removed/obsoleted ones. Idempotent on hash.
- `getQuestionsForVersion(hash)` — reconstructs the question set by walking the `dataset_versions` parent chain and taking the most recent definition per question ID. Tombstones are dropped.
- `backfillRunVersions(dataset, hash)` — one-shot UPDATE that tags all null-version runs for a dataset with the current hash (runs before versioning was introduced).
- Two tables: `dataset_versions` (hash, dataset, parent_hash, created_at) and `question_changes` (version_hash, question_id, category, subclass, flags, text — text NULL = tombstone).
- Pages call `snapshotVersion` + `backfillRunVersions` after `loadQuestions`, before creating or displaying runs.

**Radar charts** (`src/radar.ts`):
- `radarSvg(axes, values, w, h)` — static single-series spider chart; used on home cards.
- `historyRadarSvg(axes, avgValues, runs, w, h)` — multi-series; grey filled average polygon + hidden per-run polygons toggled by `data-run-id`. SVGs use `overflow="visible"` so labels outside the bounding box are not clipped.
- Home card shows radar when last run has >3 named categories OR ≥3 secondary scores. Both: toggle buttons appear.
- History shows radar above the table with same trigger. Hovering a column header highlights that run's polygon.

**PSV flags:**
- `reverse` — score as `itemMax - raw`
- `anchor` — never dormant
- `dormant` — hidden unless recently answered non-zero (see dormancy rules)
- `obsolete` — excluded from assessment, scoring, and version snapshots; causes a tombstone in the next snapshot
- Any flag declared via `@secondary` — marks questions belonging to that secondary score group

**Pages** (`src/pages/`):
- `home.ts` — dataset cards with latest score, due-date badge, optional radar chart; `DATASETS` array controls which appear; sorted most-overdue first; version string in footer from `src/version.ts`
- `assessment.ts` — progressive reveal; emote buttons top-right of each card; Shuffle + Dormant toggles in header; dormant hidden by default on new runs; snapshots version on load; abandon uses two-click pattern (no `confirm()`)
- `summary.ts` — score hero with severity tint/label and version hash; subclass table with secondary score rows; changed-questions table vs previous run; scores against run's own snapshot
- `history.ts` — optional radar above table; transposed table (runs as columns); three-level expand: category → subclass → questions; sparklines; severity tints; version hash in column header; scores each run against its own snapshot; secondary score rows above subclasses; emotes in cells; delete uses two-click pattern
- `import.ts` — paste historical MID data as `id|answer` columns with date headers; validates question IDs against current active set; tags imported runs with current version

**Tauri** (`src-tauri/`):
- `tauri.conf.json` — app config, window size, bundle settings
- `capabilities/default.json` — fs permissions (read, write, mkdir, exists, app-recursive)
- `src/lib.rs` + `src/main.rs` — minimal Rust, just initialises tauri-plugin-fs
- Icons in `src-tauri/icons/` — currently placeholder indigo squares; replace with `npx tauri icon <1024x1024.png>`

## Adding a new dataset

1. Add `public/data/<name>.psv` with metadata headers (`@title`, `@tagline`, `@frequency`, `@max`; add `@normalize` + `@item-max` if normalized scoring is needed; add `@secondary: flag=Label` lines for any secondary score groups)
2. Add name to `DATASETS` in `src/pages/home.ts`
3. Add config entry in `src/datasets.ts` (scale labels, preamble, severity bands)

## Editing a PSV file

- **Wording change** → new version hash minted automatically on next run creation. Old runs score against their snapshot.
- **New question** → add with a new unique ID; gaps in IDs are fine.
- **Retiring a question** → add `obsolete` to its flags. It will be tombstoned in the next snapshot and excluded from all future runs. Old runs that answered it continue to score it via their snapshot.
- **Intent change** → assign a new ID; treat the old ID as obsolete.
- **Adding a secondary group** → add `# @secondary: flagname=Label` to the header, then add `flagname` to the flags field of the relevant questions.
