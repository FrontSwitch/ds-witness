export interface Question {
  id: string
  category: string
  subclass: string
  flags: string
  text: string
}

export interface SeverityBand {
  min: number
  max: number
  label: string
  level: 'sev-none' | 'sev-mild' | 'sev-moderate' | 'sev-mod-severe' | 'sev-severe'
}

export interface DatasetMeta {
  title: string
  tagline: string
  frequencyDays: number
  max: number        // displayed scale max (e.g. 100, 27, 21)
  normalize: number  // question-count divisor for normalized scoring (e.g. 162, 60); raw sum if absent
  itemMax: number    // per-question max value (e.g. 4, 3, 17); defaults to 4
  secondaries: Array<{ flag: string; label: string }>  // secondary score groups declared via @secondary
  countGe: Array<{ id: string; label: string; threshold: number }>  // count-ge secondaries via @count-ge
  link: string       // URL to dataset source / documentation
  copyright: string  // attribution / copyright notice
  scaleLabels: string[]    // answer button labels, 0-indexed; from @scale-labels
  preamble: string         // instruction text shown above questions; from @preamble
  severityBands: SeverityBand[]  // score ranges with labels; from @severity lines
}

const cache = new Map<string, Question[]>()
const metaCache = new Map<string, Partial<DatasetMeta>>()
const notFoundCache = new Set<string>()

// psvPath: path under /data/ (without .psv), defaults to dataset id.
// Returns null if the file is not found (404), throws on other errors.
export async function loadQuestions(dataset: string, psvPath?: string): Promise<Question[] | null> {
  if (cache.has(dataset)) return cache.get(dataset)!
  if (notFoundCache.has(dataset)) return null

  const res = await fetch(`/data/${psvPath ?? dataset}.psv`)
  if (res.status === 404) { notFoundCache.add(dataset); return null }
  if (!res.ok) throw new Error(`Could not load /data/${psvPath ?? dataset}.psv (${res.status})`)

  const questions: Question[] = []
  const meta: Partial<DatasetMeta> = {}
  for (const raw of (await res.text()).split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const m = line.match(/^#\s*@([\w-]+):\s*(.+)$/)
      if (m) {
        const [, key, val] = m
        if (key === 'title') meta.title = val.trim()
        else if (key === 'tagline') meta.tagline = val.trim()
        else if (key === 'frequency') meta.frequencyDays = parseInt(val)
        else if (key === 'max') meta.max = parseInt(val)
        else if (key === 'normalize') meta.normalize = parseInt(val)
        else if (key === 'item-max') meta.itemMax = parseInt(val)
        else if (key === 'secondary') {
          const eq = val.indexOf('=')
          if (eq !== -1) {
            const flag = val.slice(0, eq).trim()
            const label = val.slice(eq + 1).trim()
            meta.secondaries = [...(meta.secondaries ?? []), { flag, label }]
          }
        }
        else if (key === 'count-ge') {
          // format: id=label:threshold  e.g. sds=Severe Dissociation Scale:2
          const colon = val.lastIndexOf(':')
          const eq = val.indexOf('=')
          if (colon !== -1 && eq !== -1 && eq < colon) {
            const id = val.slice(0, eq).trim()
            const label = val.slice(eq + 1, colon).trim()
            const threshold = parseInt(val.slice(colon + 1).trim())
            if (!isNaN(threshold)) {
              meta.countGe = [...(meta.countGe ?? []), { id, label, threshold }]
            }
          }
        }
        else if (key === 'link') { if (val.trim()) meta.link = val.trim() }
        else if (key === 'copyright') { if (val.trim()) meta.copyright = val.trim() }
        else if (key === 'scale-labels') meta.scaleLabels = val.split('|').map(s => s.trim())
        else if (key === 'preamble') { if (val.trim()) meta.preamble = val.trim() }
        else if (key === 'severity') {
          const sm = val.match(/^(\d+)-(\d+)=(.+):(\S+)$/)
          if (sm) {
            const band: SeverityBand = {
              min: parseInt(sm[1]), max: parseInt(sm[2]),
              label: sm[3].trim(), level: sm[4] as SeverityBand['level'],
            }
            meta.severityBands = [...(meta.severityBands ?? []), band]
          }
        }
      }
      continue
    }
    const parts = line.split('|')
    if (parts.length < 5) continue
    const [id, category, subclass, flags, ...rest] = parts
    if (id.trim().toLowerCase() === 'id') continue
    questions.push({ id: id.trim(), category: category.trim(), subclass: subclass.trim(), flags: flags.trim().toLowerCase(), text: rest.join('|').trim() })
  }

  cache.set(dataset, questions)
  metaCache.set(dataset, meta)
  return questions
}

export function getDatasetMeta(dataset: string): Partial<DatasetMeta> {
  return metaCache.get(dataset) ?? {}
}

export function hasFlag(q: Question, flag: string): boolean {
  return q.flags.split(',').map(f => f.trim()).includes(flag)
}

export async function computeAssessmentVersion(questions: Question[]): Promise<string> {
  const active = questions.filter(q => !hasFlag(q, 'obsolete'))
  const sorted = [...active].sort((a, b) => Number(a.id) - Number(b.id))
  const canonical = sorted.map(q => {
    const flags = q.flags.split(',').map(f => f.trim()).filter(Boolean).sort().join(',')
    return `${q.id}|${q.category}|${q.subclass}|${flags}|${q.text}`
  }).join('\n')
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8)
}
