import { navigate } from '../router'
import { importRun, snapshotVersion } from '../db'
import { loadQuestions, hasFlag, computeAssessmentVersion } from '../questions'

const DATASETS = ['mid-60', 'mid-162']

// 0–10 → 0–4 mapping
function remap10to4(v: number): number {
  if (v === 0)  return 0
  if (v <= 3)   return 1
  if (v <= 6)   return 2
  if (v <= 8)   return 3
  return 4  // 9–10
}

export function importPage(container: HTMLElement): void {
  container.innerHTML = `
    <div class="page import-page">
      <header class="page-header">
        <button class="btn-ghost back-btn">← Home</button>
        <h2>Import historical data</h2>
      </header>

      <div class="import-form">
        <div class="form-row">
          <label for="imp-dataset">Dataset</label>
          <select id="imp-dataset">
            ${DATASETS.map(d => `<option value="${d}">${d.toUpperCase()}</option>`).join('')}
          </select>
        </div>

        <div class="form-row">
          <label for="imp-notes">Notes (optional)</label>
          <input type="text" id="imp-notes" placeholder="e.g. baseline batch" />
        </div>

        <div class="form-row form-row-inline">
          <input type="checkbox" id="imp-remap" checked />
          <label for="imp-remap">Answers are on 0–10 scale — remap to 0–4
            <span class="field-hint">0→0 · 1–3→1 · 4–6→2 · 7–8→3 · 9–10→4</span>
          </label>
        </div>

        <div class="form-row">
          <label for="imp-data">
            Answers
            <span class="field-hint">First row: <code>id|date1|date2|…</code> — remaining rows: <code>question_id|answer|answer|…</code></span>
          </label>
          <textarea id="imp-data" rows="14" placeholder="id|2023-06-01|2023-09-15|2024-01-10&#10;3|2|1|3&#10;36|1|0|2&#10;39|0|0|1&#10;…"></textarea>
        </div>

        <div id="imp-preview" class="imp-preview" style="display:none"></div>
        <div id="imp-error" class="error" style="display:none"></div>

        <div class="form-actions">
          <button class="btn-ghost" id="cancel-btn">Cancel</button>
          <button class="btn-secondary" id="preview-btn">Preview</button>
          <button class="btn-primary" id="import-btn">Import</button>
        </div>
      </div>
    </div>
  `

  container.querySelector('.back-btn')!.addEventListener('click', () => navigate('/home'))
  container.querySelector('#cancel-btn')!.addEventListener('click', () => navigate('/home'))
  container.querySelector('#preview-btn')!.addEventListener('click', () => runPreview(container))
  container.querySelector('#import-btn')!.addEventListener('click', () => runImport(container))
}

interface ParseResult {
  dates: string[]
  runs: Array<Array<[string, number]>>
  errors: string[]
  warnings: string[]
}

function parse(raw: string, remap: boolean): ParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)

  if (lines.length === 0) {
    return { dates: [], runs: [], errors: ['No data.'], warnings: [] }
  }

  const headerParts = lines[0].split('|').map(s => s.trim())
  if (headerParts[0].toLowerCase() !== 'id') {
    errors.push(`First row must start with "id". Got: "${headerParts[0]}"`)
    return { dates: [], runs: [], errors, warnings }
  }

  const dates = headerParts.slice(1)
  if (dates.length === 0) {
    errors.push('No date columns found in header row.')
    return { dates: [], runs: [], errors, warnings }
  }

  dates.forEach((d, i) => {
    if (isNaN(Date.parse(d))) errors.push(`Column ${i + 1} header "${d}" is not a valid date.`)
  })
  if (errors.length) return { dates: [], runs: [], errors, warnings }

  const maxVal = remap ? 10 : 4
  const runs: Array<Array<[string, number]>> = dates.map(() => [])

  for (let li = 1; li < lines.length; li++) {
    const parts = lines[li].split('|').map(s => s.trim())
    const qid = parts[0]
    if (!qid) continue

    if (parts.length - 1 !== dates.length) {
      warnings.push(`Row ${li + 1} (id=${qid}): expected ${dates.length} answers, got ${parts.length - 1} — skipped`)
      continue
    }

    for (let col = 0; col < dates.length; col++) {
      const cell = parts[col + 1]
      if (cell === '' || cell === '-') continue
      const val = parseInt(cell)
      if (isNaN(val) || val < 0 || val > maxVal) {
        warnings.push(`Row ${li + 1} (id=${qid}), col ${col + 1}: invalid value "${cell}" (0–${maxVal}) — skipped`)
        continue
      }
      runs[col].push([qid, remap ? remap10to4(val) : val])
    }
  }

  return { dates, runs, errors, warnings }
}

function getInputs(container: HTMLElement) {
  return {
    dataset: (container.querySelector('#imp-dataset') as HTMLSelectElement).value,
    notes: (container.querySelector('#imp-notes') as HTMLInputElement).value.trim(),
    raw: (container.querySelector('#imp-data') as HTMLTextAreaElement).value.trim(),
    remap: (container.querySelector('#imp-remap') as HTMLInputElement).checked,
  }
}

function runPreview(container: HTMLElement) {
  const { raw, remap } = getInputs(container)
  const errEl = container.querySelector('#imp-error') as HTMLElement
  const previewEl = container.querySelector('#imp-preview') as HTMLElement

  errEl.style.display = 'none'
  previewEl.style.display = 'none'

  const { dates, runs, errors, warnings } = parse(raw, remap)

  if (errors.length) {
    errEl.innerHTML = errors.map(e => `<div>${e}</div>`).join('')
    errEl.style.display = ''
    return
  }

  previewEl.innerHTML = `
    <div class="preview-title">Runs to import${remap ? ' (0–10 → 0–4 remapped)' : ''}:</div>
    <table class="summary-table">
      <thead><tr><th>Date</th><th>Answers</th></tr></thead>
      <tbody>${dates.map((d, i) => `<tr><td>${d}</td><td class="td-num">${runs[i].length}</td></tr>`).join('')}</tbody>
    </table>
    ${warnings.length ? `<div class="preview-warnings">${warnings.slice(0, 10).map(w => `<div>⚠ ${w}</div>`).join('')}${warnings.length > 10 ? `<div>…and ${warnings.length - 10} more</div>` : ''}</div>` : ''}
  `
  previewEl.style.display = ''
}

async function runImport(container: HTMLElement) {
  const { dataset, notes, raw, remap } = getInputs(container)
  const errEl = container.querySelector('#imp-error') as HTMLElement
  errEl.style.display = 'none'

  if (!raw) {
    errEl.textContent = 'Please paste answer data.'
    errEl.style.display = ''
    return
  }

  const { dates, runs, errors } = parse(raw, remap)

  if (errors.length) {
    errEl.innerHTML = errors.map(e => `<div>${e}</div>`).join('')
    errEl.style.display = ''
    return
  }

  // Load and snapshot current version; validate all incoming question IDs
  let version: string
  let validIds: Set<string>
  try {
    const questions = await loadQuestions(dataset)
    if (!questions) throw new Error(`Dataset not found: ${dataset}`)
    const active = questions.filter(q => !hasFlag(q, 'obsolete'))
    version = await computeAssessmentVersion(questions)
    snapshotVersion(dataset, active, version)
    validIds = new Set(active.map(q => q.id))
  } catch (err) {
    errEl.textContent = `Failed to load questions: ${err instanceof Error ? err.message : err}`
    errEl.style.display = ''
    return
  }

  for (let i = 0; i < runs.length; i++) {
    for (const [qid] of runs[i]) {
      if (!validIds.has(qid)) {
        errEl.textContent = `Unknown question ID "${qid}" — not in current ${dataset.toUpperCase()} questions.`
        errEl.style.display = ''
        return
      }
    }
  }

  let lastRunId = -1
  for (let i = 0; i < dates.length; i++) {
    if (runs[i].length === 0) continue
    lastRunId = importRun(dataset, new Date(`${dates[i]}T12:00:00`).toISOString(), runs[i], notes || undefined, version)
  }

  if (lastRunId === -1) {
    errEl.textContent = 'No answers to import.'
    errEl.style.display = ''
    return
  }

  navigate(`/history/${dataset}`)
}
