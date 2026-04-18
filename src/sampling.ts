import type { Question } from './questions'
import { seededShuffle } from './dormancy'

// Simple djb2-style hash for a string → deterministic number
function strHash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i)
    h = h >>> 0
  }
  return h
}

// Sample 1 question per (category × subclass) group using deck-cycling.
// runIndex = number of runs created before this one (from getRunIndex in db.ts).
// Within each subclass of N questions:
//   - cycleNum = floor(runIndex / N)  — which full pass through the deck we're on
//   - posInCycle = runIndex % N       — position within that pass
//   - deck shuffled deterministically per cycle (cycleNum ^ strHash(key))
//   - pick deck[posInCycle]
// This guarantees all N questions are seen before any repeats.
export function sampleQuestions(questions: Question[], runIndex: number): Question[] {
  const groups = new Map<string, Question[]>()
  for (const q of questions) {
    const key = `${q.category}|${q.subclass}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(q)
  }

  const selected: Question[] = []
  for (const [key, qs] of groups) {
    const n = qs.length
    const cycleNum = Math.floor(runIndex / n)
    const posInCycle = runIndex % n
    const seed = (cycleNum ^ strHash(key)) >>> 0
    const deck = seededShuffle(qs, seed)
    selected.push(deck[posInCycle])
  }
  return selected
}
