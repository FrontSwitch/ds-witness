#!/usr/bin/env node
// Generates human-readable markdown from public/data/frontswitchpool.psv
// Usage:
//   npm run export-fsp                            → writes docs/fsp.md
//   npm run export-fsp -- ../fsp-repo/README.md   → writes to another path

import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PSV_PATH      = join(__dirname, '../public/data/frontswitchpool.psv')
const TEMPLATE_PATH = join(__dirname, 'fsp-template.md')
const OUT_PATH      = resolve(process.argv[2] ?? join(__dirname, '../docs/fsp.md'))

// ── Parse PSV ────────────────────────────────────────────────────────────────

const lines = readFileSync(PSV_PATH, 'utf8').split('\n')

const meta = {}
const questions = []

for (const raw of lines) {
  const line = raw.trim()
  if (!line) continue
  if (line.startsWith('#')) {
    const m = line.match(/^#\s*@([\w-]+):\s*(.+)$/)
    if (m) meta[m[1]] = m[2].trim()
    continue
  }
  const parts = line.split('|')
  if (parts.length < 5) continue
  const [id, category, subclass, flags, ...rest] = parts
  if (id.trim().toLowerCase() === 'id') continue
  questions.push({
    id: id.trim(),
    category: category.trim(),
    subclass: subclass.trim(),
    flags: flags.trim().toLowerCase(),
    text: rest.join('|').trim(),
  })
}

const scaleLabels = (meta['scale-labels'] ?? '').split('|').map(s => s.trim())
const preamble = meta['preamble'] ?? ''

// ── Group by category → subclass ─────────────────────────────────────────────

const categoryOrder = []
const grouped = {}

for (const q of questions) {
  if (!grouped[q.category]) {
    grouped[q.category] = {}
    categoryOrder.push(q.category)
  }
  if (!grouped[q.category][q.subclass]) {
    grouped[q.category][q.subclass] = {}
  }
  grouped[q.category][q.subclass][q.flags] = q.text
}

// ── Flag config ───────────────────────────────────────────────────────────────

const FLAG_ORDER = ['load', 'resistance', 'interference']
const FLAG_LABEL = { load: 'Load', resistance: 'Resistance', interference: 'Interference' }

// ── Domain descriptions ───────────────────────────────────────────────────────


// ── Generate substitution blocks ─────────────────────────────────────────────

const formatLines = []
if (preamble) formatLines.push(`Preamble: *${preamble}*`, '')
if (scaleLabels.length) formatLines.push(`Scale: ${scaleLabels.map((l, i) => `${i} = ${l}`).join(' · ')}`)
const generated_format = formatLines.join('\n')

const questionLines = []
for (const category of categoryOrder) {
  questionLines.push(`### ${category}`, '')
  for (const subclass of Object.keys(grouped[category])) {
    questionLines.push(`#### ${subclass}`, '')
    questionLines.push('| Type | Question |')
    questionLines.push('|------|----------|')
    for (const flag of FLAG_ORDER) {
      const text = grouped[category][subclass][flag]
      if (text) questionLines.push(`| **${FLAG_LABEL[flag]}** | ${text} |`)
    }
    questionLines.push('')
  }
}
const generated_questions = questionLines.join('\n')

// ── Apply template ────────────────────────────────────────────────────────────

const template = readFileSync(TEMPLATE_PATH, 'utf8')
const output = template
  .replace('{generated_format}', generated_format)
  .replace('{generated_questions}', generated_questions)

writeFileSync(OUT_PATH, output, 'utf8')
console.log(`Written to ${OUT_PATH}`)
