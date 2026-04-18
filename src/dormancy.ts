import type { Question } from './questions'
import { hasFlag, getDatasetMeta } from './questions'
import { getCompletedRuns, getAnswers } from './db'

// Deterministic Fisher-Yates using a simple xorshift32 seeded by runId
export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr]
  let s = (seed ^ 0x9e3779b9) >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    s = s >>> 0
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 10% of dormant questions (min 1) always included, seeded per run
export function selectDormantSample(dormantIds: string[], runId: number): Set<string> {
  if (dormantIds.length === 0) return new Set()
  const count = Math.max(1, Math.ceil(dormantIds.length * 0.1))
  const shuffled = seededShuffle(dormantIds, runId ^ 0xdeadbeef)
  return new Set(shuffled.slice(0, count))
}

// Dormant = PSV-flagged dormant, OR scored 0 in each of the last 2 completed runs.
// Anchor questions are never dormant.
// "Changes back to active if non-zero" is satisfied naturally: the two-zeros rule
// only fires when both recent runs are 0.
export function computeDormant(
  dataset: string,
  questions: Question[],
  currentRunId: number,
): Set<string> {
  const dormant = new Set<string>()
  const completed = getCompletedRuns(dataset).filter(r => r.id !== currentRunId)
  const run1 = completed[0] ? getAnswers(completed[0].id) : null
  const run2 = completed[1] ? getAnswers(completed[1].id) : null
  const itemMax = getDatasetMeta(dataset).itemMax ?? 4

  for (const q of questions) {
    if (hasFlag(q, 'anchor')) continue

    const rev = hasFlag(q, 'reverse')
    const effective = (raw: number) => rev ? itemMax - raw : raw
    const e1 = effective(run1?.get(q.id) ?? 0)
    const e2 = effective(run2?.get(q.id) ?? 0)

    if (hasFlag(q, 'dormant')) {
      // PSV dormant: active once last run was non-zero (effective), otherwise dormant
      if (e1 === 0) dormant.add(q.id)
    } else if (run1 && run2) {
      // Consecutive-zeros rule requires at least 2 runs
      if (e1 === 0 && e2 === 0) dormant.add(q.id)
    }
  }

  return dormant
}
