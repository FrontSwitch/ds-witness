import type { Question } from './questions'
import { hasFlag, getDatasetMeta } from './questions'

export interface SubclassScore {
  category: string
  subclass: string
  sum: number
  count: number
  mean: number
}

export interface SecondaryScore {
  flag: string
  label: string
  sum: number
  total: number
  scale: string
  count: number
  type?: 'count-ge'  // absent = flag-based mean; 'count-ge' = count of answers >= threshold
}

export interface Score {
  total: number
  scale: string
  subclasses: SubclassScore[]
  answeredCount: number
  totalQuestions: number
  secondaries: SecondaryScore[]
}

// Jump threshold for highlight: fraction of the full scale
const JUMP_THRESHOLD_FRACTION = 0.08

export function computeScore(
  dataset: string,
  questions: Question[],
  answers: Map<string, number>,
): Score {
  const answered = questions.filter(q => answers.has(q.id))
  const meta = getDatasetMeta(dataset)
  const max = meta.max
  const normalize = meta.normalize
  const itemMax = meta.itemMax ?? 4
  const effectiveValue = (q: Question) => {
    const raw = answers.get(q.id)!
    return hasFlag(q, 'reverse') ? itemMax - raw : raw
  }
  const sum = answered.reduce((acc, q) => acc + effectiveValue(q), 0)

  // Group by category+subclass
  const groups = new Map<string, SubclassScore>()
  for (const q of answered) {
    const key = `${q.category}\0${q.subclass}`
    if (!groups.has(key)) {
      groups.set(key, { category: q.category, subclass: q.subclass, sum: 0, count: 0, mean: 0 })
    }
    const g = groups.get(key)!
    g.sum += effectiveValue(q)
    g.count++
  }
  for (const g of groups.values()) g.mean = g.sum / g.count

  // Sort subclasses by category then subclass name
  const subclasses = Array.from(groups.values()).sort((a, b) =>
    a.category.localeCompare(b.category) || a.subclass.localeCompare(b.subclass),
  )

  let total: number
  let scale: string
  if (normalize && max) {
    total = (sum * (max / itemMax)) / normalize
  } else {
    total = sum
  }
  scale = max ? `0–${max}` : `0–${questions.length * 4}`

  const secondaries: SecondaryScore[] = [
    ...(meta.secondaries ?? []).flatMap(({ flag, label }) => {
      const secAnswered = answered.filter(q => hasFlag(q, flag))
      if (secAnswered.length === 0) return []
      const secSum = secAnswered.reduce((acc, q) => acc + effectiveValue(q), 0)
      return [{ flag, label, sum: secSum, total: secSum / secAnswered.length, scale: `0–${itemMax}`, count: secAnswered.length }]
    }),
    ...(meta.countGe ?? []).map(({ id, label, threshold }) => {
      const n = answered.filter(q => (answers.get(q.id) ?? 0) >= threshold).length
      return { flag: id, label, sum: n, total: n, scale: `0–${answered.length}`, count: answered.length, type: 'count-ge' as const }
    }),
  ]

  return { total, scale, subclasses, answeredCount: answered.length, totalQuestions: questions.length, secondaries }
}

export function isJump(dataset: string, delta: number): boolean {
  const fullScale = getDatasetMeta(dataset).max ?? 100
  return Math.abs(delta) >= fullScale * JUMP_THRESHOLD_FRACTION
}

export function subclassJumpThreshold(): number {
  // For subclass means (0–4 scale), flag changes ≥ 0.5
  return 0.5
}
