#!/usr/bin/env node
// Seed dsw-dev.sqlite with 20 fake runs for each public dataset.
// Run via: npm run seed:dev
// Output: ~/Library/Application Support/com.frontswitchstudio.dsw/dsw-dev.sqlite

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const sqljs = require('sql.js')
const initSqlJs = sqljs.default ?? sqljs

const DB_DIR = join(homedir(), 'Library', 'Application Support', 'com.frontswitchstudio.dsw')
const DB_PATH = join(DB_DIR, 'dsw-dev.sqlite')
const WASM_PATH = join(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm')

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset      TEXT    NOT NULL,
    started_at   TEXT    NOT NULL,
    completed_at TEXT,
    notes        TEXT
  );
  CREATE TABLE IF NOT EXISTS answers (
    run_id      INTEGER NOT NULL,
    question_id TEXT    NOT NULL,
    answer      INTEGER NOT NULL,
    PRIMARY KEY (run_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS emotes (
    run_id      INTEGER NOT NULL,
    question_id TEXT    NOT NULL,
    emote       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS dataset_versions (
    version_hash TEXT PRIMARY KEY,
    dataset      TEXT NOT NULL,
    parent_hash  TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS question_changes (
    version_hash TEXT NOT NULL,
    question_id  TEXT NOT NULL,
    category     TEXT,
    subclass     TEXT,
    flags        TEXT,
    text         TEXT,
    PRIMARY KEY (version_hash, question_id)
  );
`

const MIGRATIONS = [
  'ALTER TABLE runs ADD COLUMN shuffled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN hide_dormant INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN assessment_version TEXT',
  'ALTER TABLE runs ADD COLUMN duration_seconds INTEGER',
]

// Deterministic xorshift32 PRNG
function makePrng(seed) {
  let s = (seed ^ 0x9e3779b9) >>> 0
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 0x100000000
  }
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1))
}

function strSeed(str) {
  return str.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0)
}

const DATASETS = [
  {
    id: 'phq-9',
    questions: ['1','2','3','4','5','6','7','8','9'],
    answerMax: 3,
    baseMean: 1.8,  // starting mean per question (older runs); trends toward 1.0
  },
  {
    id: 'gad-7',
    questions: ['1','2','3','4','5','6','7'],
    answerMax: 3,
    baseMean: 1.6,
  },
  {
    id: 'ffmq-15',
    questions: ['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15'],
    answerMax: 4,
    baseMean: 2.2,  // mindfulness: slightly improving (higher is better but seeded low)
  },
]

const NUM_RUNS = 20
const SPAN_DAYS = 400

async function main() {
  const SQL = await initSqlJs({ wasmBinary: readFileSync(WASM_PATH) })

  let existing = null
  if (existsSync(DB_PATH)) {
    console.log(`Loading existing dev DB: ${DB_PATH}`)
    existing = readFileSync(DB_PATH)
  } else {
    console.log(`Creating new dev DB: ${DB_PATH}`)
    mkdirSync(DB_DIR, { recursive: true })
  }

  const db = existing ? new SQL.Database(existing) : new SQL.Database()
  db.run(SCHEMA)
  for (const m of MIGRATIONS) {
    try { db.run(m) } catch { /* already exists */ }
  }

  const now = Date.now()

  for (const dataset of DATASETS) {
    const [[existingCount]] = db.exec(`SELECT COUNT(*) FROM runs WHERE dataset = '${dataset.id}'`)[0]?.values ?? [[0]]
    if (existingCount >= NUM_RUNS) {
      console.log(`  ${dataset.id}: already has ${existingCount} runs, skipping`)
      continue
    }

    console.log(`  Seeding ${dataset.id} (${NUM_RUNS} runs)…`)
    const rng = makePrng(strSeed(dataset.id))

    for (let i = 0; i < NUM_RUNS; i++) {
      // i=0 = oldest run, i=19 = most recent
      const daysAgo = Math.round(SPAN_DAYS * (1 - i / (NUM_RUNS - 1)))
      const startedAt = new Date(now - daysAgo * 86_400_000)
      const durationSec = randInt(rng, 180, 900)
      const completedAt = new Date(startedAt.getTime() + durationSec * 1000)

      // Gentle improving trend over time (lower score = better for PHQ/GAD)
      const progress = i / (NUM_RUNS - 1)
      const mean = dataset.baseMean - progress * 0.6

      db.run(
        `INSERT INTO runs (dataset, started_at, completed_at, shuffled, hide_dormant, duration_seconds)
         VALUES (?, ?, ?, 0, 1, ?)`,
        [dataset.id, startedAt.toISOString(), completedAt.toISOString(), durationSec],
      )
      const runId = db.exec('SELECT last_insert_rowid()')[0].values[0][0]

      for (const qid of dataset.questions) {
        const noise = (rng() - 0.5) * 2.5
        const raw = Math.min(dataset.answerMax, Math.max(0, Math.round(mean + noise)))
        db.run(
          `INSERT OR REPLACE INTO answers (run_id, question_id, answer) VALUES (?, ?, ?)`,
          [runId, qid, raw],
        )
      }
    }
  }

  writeFileSync(DB_PATH, db.export())
  console.log(`\nDone — dev DB: ${DB_PATH}`)
  console.log(`Run:  npm run tauri:dev`)
}

main().catch(err => { console.error(err); process.exit(1) })
