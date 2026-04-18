import sqljs from 'sql.js'
import type { Question } from './questions'
// sql.js is CJS; Vite wraps it so the default may be nested
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const initSqlJs: typeof sqljs = (sqljs as any).default ?? sqljs

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = any

let db: DB

type SqlParam = string | number | null

function query<T>(sql: string, params: SqlParam[] = []): T[] {
  const stmt = db.prepare(sql)
  if (params.length) stmt.bind(params)
  const results: T[] = []
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T)
  }
  stmt.free()
  return results
}

function exec(sql: string, params: SqlParam[] = []): void {
  db.run(sql, params)
}

// ── Storage backend (Tauri file system or browser IndexedDB) ──────────────

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const DB_FILENAME = 'dsw.sqlite'

async function getAppDir(): Promise<string> {
  const { appDataDir } = await import('@tauri-apps/api/path')
  const dir = await appDataDir()
  return dir.replace(/[/\\]$/, '')  // strip trailing slash
}

async function loadFromDisk(): Promise<Uint8Array | null> {
  if (isTauri) {
    const { readFile, exists, mkdir } = await import('@tauri-apps/plugin-fs')
    try {
      const dir = await getAppDir()
      await mkdir(dir, { recursive: true })
      const path = `${dir}/${DB_FILENAME}`
      if (!(await exists(path))) return null
      return await readFile(path)
    } catch {
      return null
    }
  }
  return loadFromIDB()
}

async function saveToDisk(): Promise<void> {
  const data: Uint8Array = db.export()
  if (isTauri) {
    const { writeFile, mkdir } = await import('@tauri-apps/plugin-fs')
    const dir = await getAppDir()
    await mkdir(dir, { recursive: true })
    await writeFile(`${dir}/${DB_FILENAME}`, data)
    return
  }
  await saveToIDB()
}

// ── IndexedDB (browser fallback) ───────────────────────────────────────────

const IDB_NAME = 'com.frontswitchstudio.dsw'
const IDB_STORE = 'data'

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function loadFromIDB(): Promise<Uint8Array | null> {
  const idb = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get('db')
    req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

async function saveToIDB(): Promise<void> {
  const data: Uint8Array = db.export()
  const idb = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(data, 'db')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveToDisk().catch(console.error)
    saveTimer = null
  }, 150)
}

// ── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset     TEXT    NOT NULL,
    started_at  TEXT    NOT NULL,
    completed_at TEXT,
    notes       TEXT
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
    version_hash  TEXT PRIMARY KEY,
    dataset       TEXT NOT NULL,
    parent_hash   TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS question_changes (
    version_hash  TEXT NOT NULL,
    question_id   TEXT NOT NULL,
    category      TEXT,
    subclass      TEXT,
    flags         TEXT,
    text          TEXT,
    PRIMARY KEY (version_hash, question_id)
  );
`

const MIGRATIONS = [
  'ALTER TABLE runs ADD COLUMN shuffled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN hide_dormant INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN assessment_version TEXT',
  'ALTER TABLE runs ADD COLUMN duration_seconds INTEGER',
]

export async function initDB(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' })
  const existing = await loadFromDisk()
  db = existing ? new SQL.Database(existing) : new SQL.Database()
  db.run(SCHEMA)
  for (const m of MIGRATIONS) {
    try { db.run(m) } catch { /* column already exists */ }
  }
  await saveToDisk()
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface Run {
  id: number
  dataset: string
  started_at: string
  completed_at: string | null
  notes: string | null
  shuffled: number       // 0 | 1
  hide_dormant: number   // 0 | 1
  assessment_version: string | null
  duration_seconds: number | null
}

// ── Queries ────────────────────────────────────────────────────────────────

export function createRun(dataset: string, version: string | null = null): number {
  exec(
    'INSERT INTO runs (dataset, started_at, hide_dormant, assessment_version) VALUES (?, ?, 1, ?)',
    [dataset, new Date().toISOString(), version],
  )
  const [{ id }] = query<{ id: number }>('SELECT last_insert_rowid() as id')
  scheduleSave()
  return id
}

export function completeRun(runId: number): void {
  const run = getRun(runId)
  const completedAt = new Date().toISOString()
  let duration: number | null = null
  if (run?.started_at) {
    duration = Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000)
  }
  exec('UPDATE runs SET completed_at = ?, duration_seconds = ? WHERE id = ?', [completedAt, duration, runId])
  scheduleSave()
}

export function getRun(runId: number): Run | null {
  return query<Run>('SELECT * FROM runs WHERE id = ?', [runId])[0] ?? null
}

export function getRuns(dataset: string): Run[] {
  return query<Run>(
    'SELECT * FROM runs WHERE dataset = ? ORDER BY started_at DESC',
    [dataset],
  )
}

export function getCompletedRuns(dataset: string): Run[] {
  return query<Run>(
    'SELECT * FROM runs WHERE dataset = ? AND completed_at IS NOT NULL ORDER BY started_at DESC',
    [dataset],
  )
}

export function getIncompleteRun(dataset: string): Run | null {
  return query<Run>(
    'SELECT * FROM runs WHERE dataset = ? AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1',
    [dataset],
  )[0] ?? null
}

// Returns how many runs for this dataset were created before runId.
// Used as a stable cycle index for deck-cycling question sampling.
export function getRunIndex(dataset: string, runId: number): number {
  return query<{ c: number }>(
    'SELECT COUNT(*) as c FROM runs WHERE dataset = ? AND id < ?',
    [dataset, runId],
  )[0].c
}

export function saveAnswer(runId: number, questionId: string, answer: number): void {
  exec(
    'INSERT OR REPLACE INTO answers (run_id, question_id, answer) VALUES (?, ?, ?)',
    [runId, questionId, answer],
  )
  scheduleSave()
}

export function getAnswers(runId: number): Map<string, number> {
  const rows = query<{ question_id: string; answer: number }>(
    'SELECT question_id, answer FROM answers WHERE run_id = ?',
    [runId],
  )
  return new Map(rows.map(r => [r.question_id, r.answer]))
}

export function saveEmote(runId: number, questionId: string, emote: number): void {
  exec(
    'INSERT OR REPLACE INTO emotes (run_id, question_id, emote) VALUES (?, ?, ?)',
    [runId, questionId, emote],
  )
  scheduleSave()
}

export function getEmotes(runId: number): Map<string, number> {
  const rows = query<{ question_id: string; emote: number }>(
    'SELECT question_id, emote FROM emotes WHERE run_id = ?',
    [runId],
  )
  return new Map(rows.map(r => [r.question_id, r.emote]))
}

export function updateRunSettings(runId: number, settings: { shuffled?: boolean; hideDormant?: boolean }): void {
  if (settings.shuffled !== undefined) {
    exec('UPDATE runs SET shuffled = ? WHERE id = ?', [settings.shuffled ? 1 : 0, runId])
  }
  if (settings.hideDormant !== undefined) {
    exec('UPDATE runs SET hide_dormant = ? WHERE id = ?', [settings.hideDormant ? 1 : 0, runId])
  }
  scheduleSave()
}

export function deleteRun(runId: number): void {
  exec('DELETE FROM answers WHERE run_id = ?', [runId])
  exec('DELETE FROM emotes WHERE run_id = ?', [runId])
  exec('DELETE FROM runs WHERE id = ?', [runId])
  scheduleSave()
}

export function importRun(
  dataset: string,
  date: string,
  answerPairs: Array<[string, number]>,
  notes?: string,
  version?: string | null,
): number {
  exec(
    'INSERT INTO runs (dataset, started_at, completed_at, notes, assessment_version) VALUES (?, ?, ?, ?, ?)',
    [dataset, date, date, notes ?? null, version ?? null],
  )
  const [{ id }] = query<{ id: number }>('SELECT last_insert_rowid() as id')
  for (const [qid, answer] of answerPairs) {
    exec(
      'INSERT OR REPLACE INTO answers (run_id, question_id, answer) VALUES (?, ?, ?)',
      [id, qid, answer],
    )
  }
  scheduleSave()
  return id
}

// ── Assessment versioning ──────────────────────────────────────────────────

type QuestionChangeRow = {
  version_hash: string
  question_id: string
  category: string | null
  subclass: string | null
  flags: string | null
  text: string | null
}

export function snapshotVersion(
  dataset: string,
  activeQuestions: Question[],  // already filtered: no obsolete
  versionHash: string,
): void {
  const exists = query<{ c: number }>(
    'SELECT COUNT(*) as c FROM dataset_versions WHERE version_hash = ?',
    [versionHash],
  )[0].c
  if (exists > 0) return

  const parentHash = query<{ version_hash: string }>(
    'SELECT version_hash FROM dataset_versions WHERE dataset = ? ORDER BY created_at DESC LIMIT 1',
    [dataset],
  )[0]?.version_hash ?? null

  let toInsert: Question[]
  let tombstones: string[]

  if (parentHash === null) {
    toInsert = activeQuestions
    tombstones = []
  } else {
    const parentQuestions = getQuestionsForVersion(parentHash)
    const parentMap = new Map(parentQuestions.map(q => [q.id, q]))
    const currentMap = new Map(activeQuestions.map(q => [q.id, q]))

    toInsert = activeQuestions.filter(q => {
      const p = parentMap.get(q.id)
      return !p || p.text !== q.text || p.flags !== q.flags || p.category !== q.category || p.subclass !== q.subclass
    })
    tombstones = parentQuestions.filter(p => !currentMap.has(p.id)).map(p => p.id)
  }

  exec(
    'INSERT INTO dataset_versions (version_hash, dataset, parent_hash, created_at) VALUES (?, ?, ?, ?)',
    [versionHash, dataset, parentHash, new Date().toISOString()],
  )
  for (const q of toInsert) {
    exec(
      'INSERT OR REPLACE INTO question_changes (version_hash, question_id, category, subclass, flags, text) VALUES (?, ?, ?, ?, ?, ?)',
      [versionHash, q.id, q.category, q.subclass, q.flags, q.text],
    )
  }
  for (const qid of tombstones) {
    exec(
      'INSERT OR REPLACE INTO question_changes (version_hash, question_id, category, subclass, flags, text) VALUES (?, ?, NULL, NULL, NULL, NULL)',
      [versionHash, qid],
    )
  }
  scheduleSave()
}

export function getQuestionsForVersion(versionHash: string): Question[] {
  // Walk parent chain, collecting hashes oldest-to-newest (we'll reverse for depth ordering)
  const chain: string[] = []
  let current: string | null = versionHash
  while (current !== null) {
    chain.push(current)
    current = query<{ parent_hash: string | null }>(
      'SELECT parent_hash FROM dataset_versions WHERE version_hash = ?',
      [current],
    )[0]?.parent_hash ?? null
  }

  const depthOf = new Map(chain.map((h, i) => [h, i]))
  const placeholders = chain.map(() => '?').join(',')
  const rows = query<QuestionChangeRow>(
    `SELECT version_hash, question_id, category, subclass, flags, text FROM question_changes WHERE version_hash IN (${placeholders})`,
    chain,
  )

  // Per question_id: keep the row with the smallest depth (most recent in chain)
  const best = new Map<string, QuestionChangeRow>()
  for (const row of rows) {
    const d = depthOf.get(row.version_hash)!
    const existing = best.get(row.question_id)
    if (existing === undefined || depthOf.get(existing.version_hash)! > d) {
      best.set(row.question_id, row)
    }
  }

  return [...best.values()]
    .filter(r => r.text !== null)
    .map(r => ({
      id: r.question_id,
      category: r.category ?? '',
      subclass: r.subclass ?? '',
      flags: r.flags ?? '',
      text: r.text!,
    }))
    .sort((a, b) => Number(a.id) - Number(b.id))
}

export function backfillRunVersions(dataset: string, versionHash: string): void {
  const count = query<{ c: number }>(
    'SELECT COUNT(*) as c FROM runs WHERE dataset = ? AND assessment_version IS NULL',
    [dataset],
  )[0].c
  if (count === 0) return
  exec(
    'UPDATE runs SET assessment_version = ? WHERE dataset = ? AND assessment_version IS NULL',
    [versionHash, dataset],
  )
  scheduleSave()
}
