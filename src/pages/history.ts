import { navigate } from '../router'
import { getCompletedRuns, getAnswers, getEmotes, deleteRun,
         snapshotVersion, backfillRunVersions, getQuestionsForVersion } from '../db'
import { loadQuestions, hasFlag, computeAssessmentVersion, getDatasetMeta } from '../questions'
import type { Question } from '../questions'
import { computeScore, isJump, subclassJumpThreshold } from '../scoring'
import { historyRadarSvg } from '../radar'
import { getDatasetConfig, getSeverityBand } from '../datasets'
import { emoteIcons } from '../emotes'

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

export async function historyPage(
  container: HTMLElement,
  params: Record<string, string>,
): Promise<void> {
  const dataset = params.dataset

  container.innerHTML = `
    <div class="page history-page">
      <header class="page-header">
        <button class="btn-ghost back-btn">← Home</button>
        <h2>${dataset.toUpperCase()} — History</h2>
        <button class="btn-primary start-btn">New run</button>
      </header>
      <div id="history-body"><div class="loading">Loading…</div></div>
    </div>
  `

  container.querySelector('.back-btn')!.addEventListener('click', () => navigate('/home'))
  container.querySelector('.start-btn')!.addEventListener('click', () => navigate(`/assessment/${dataset}`))

  const body = container.querySelector('#history-body')!
  const runs = getCompletedRuns(dataset)   // newest first

  if (runs.length === 0) {
    body.innerHTML = '<p class="muted center">No completed runs yet.</p>'
    return
  }

  const questions = await loadQuestions(dataset)
  if (!questions) { body.innerHTML = '<p class="muted center">Dataset not found.</p>'; return }
  const { scaleLabels } = getDatasetConfig(dataset)
  const itemMax = getDatasetMeta(dataset).itemMax ?? 4

  // Snapshot current version and backfill any unversioned runs
  const activeQuestions = questions.filter(q => !hasFlag(q, 'obsolete'))
  const version = await computeAssessmentVersion(questions)
  snapshotVersion(dataset, activeQuestions, version)
  backfillRunVersions(dataset, version)

  // Per-run scores, answers, and emotes — score against each run's own snapshot
  const runData = runs.map(r => {
    const answers = getAnswers(r.id)
    const runQuestions = r.assessment_version
      ? getQuestionsForVersion(r.assessment_version)
      : activeQuestions
    return {
      run: r,
      score: computeScore(dataset, runQuestions, answers),
      answers,
      emotes: getEmotes(r.id),
      runQuestions,
    }
  })

  // All subclass keys sorted by mean descending in the latest run
  const subclassKeys = [...runData[0].score.subclasses]
    .sort((a, b) => b.mean - a.mean)
    .map(s => `${s.category}\0${s.subclass}`)

  // Questions grouped by subclass key — use the most recent run's snapshot for row structure
  const questionsBySubclass = new Map<string, Question[]>()
  for (const q of runData[0].runQuestions) {
    const key = `${q.category}\0${q.subclass}`
    if (!questionsBySubclass.has(key)) questionsBySubclass.set(key, [])
    questionsBySubclass.get(key)!.push(q)
  }

  // ── Sparkline helper ────────────────────────────────────────────────────

  function sparkline(vals: (number | undefined)[], w = 88, h = 26): string {
    const defined = vals.filter((v): v is number => v !== undefined)
    if (defined.length < 2) return ''
    const min = Math.min(...defined)
    const max = Math.max(...defined)
    const range = max - min || 1
    const avg = defined.reduce((a, b) => a + b, 0) / defined.length
    const pad = 3
    const iw = w - pad * 2
    const ih = h - pad * 2
    const xOf = (i: number) => pad + (i / (vals.length - 1)) * iw
    const yOf = (v: number) => pad + ih - ((v - min) / range) * ih
    const pts = vals.map((v, i) => v !== undefined ? `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}` : null).filter(Boolean).join(' ')
    const avgY = yOf(avg).toFixed(1)
    const lastDefined = [...vals].reverse().find(v => v !== undefined)
    const lastIdx = vals.length - 1 - [...vals].reverse().findIndex(v => v !== undefined)
    const dotX = xOf(lastIdx).toFixed(1)
    const dotY = lastDefined !== undefined ? yOf(lastDefined).toFixed(1) : null
    return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <polyline points="${pts}" fill="none" stroke="var(--spark-line)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      <line x1="${pad}" y1="${avgY}" x2="${w - pad}" y2="${avgY}" stroke="var(--spark-avg)" stroke-width="1" stroke-dasharray="3,2"/>
      ${dotY !== null ? `<circle cx="${dotX}" cy="${dotY}" r="2.5" fill="var(--spark-dot)"/>` : ''}
    </svg>`
  }

  // ── Build table ─────────────────────────────────────────────────────────

  // Values oldest → newest (for sparklines, left = oldest, right = newest)
  const totalsChron = [...runData].reverse().map(d => d.score.total)

  // Severity level per column (index matches runData)
  const severities = runData.map(({ score }) => getSeverityBand(dataset, score.total)?.level ?? '')

  // Column header dates — show time when multiple runs share the same calendar date
  const shortDates = runData.map(({ run }) =>
    new Date(run.completed_at!).toLocaleDateString(undefined, { dateStyle: 'short' }),
  )
  const dateHeaders = runData.map(({ run }, i) => {
    const collision = shortDates.filter(d => d === shortDates[i]).length > 1
    const label = collision
      ? new Date(run.completed_at!).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : shortDates[i]
    const sev = severities[i]
    const band = getSeverityBand(dataset, runData[i].score.total)
    return `
      <th class="col-run${sev ? ' ' + sev : ''}">
        <a class="run-link" data-run-id="${run.id}" href="#">${label}</a>
        ${band ? `<span class="sev-label">${band.label}</span>` : ''}
        ${run.assessment_version ? `<span class="version-hash">${run.assessment_version}</span>` : ''}
        ${run.duration_seconds != null ? `<span class="duration-label">${fmtDuration(run.duration_seconds)}</span>` : ''}
        <button class="delete-run-btn" data-run-id="${run.id}" title="Delete">✕</button>
      </th>
    `
  }).join('')

  // Helper: value cell with optional delta, severity tint, and emote icons
  function valueCell(
    val: number | undefined,
    prevVal: number | undefined,
    jump: boolean,
    decimals = 2,
    sevClass = '',
    emoteMask = 0,
  ): string {
    if (val === undefined) return '<td class="td-num muted">—</td>'
    const delta = prevVal !== undefined ? val - prevVal : null
    const deltaStr = delta !== null && Math.abs(delta) >= 0.005
      ? `<span class="cell-delta ${delta > 0 ? 'delta-up' : 'delta-down'}">${delta > 0 ? '+' : ''}${delta.toFixed(decimals)}</span>`
      : ''
    const cls = ['td-num', jump ? 'cell-jump' : (sevClass || '')].filter(Boolean).join(' ')
    const icons = emoteMask ? `<span class="cell-emotes">${emoteIcons(emoteMask)}</span>` : ''
    return `<td class="${cls}"><div class="cell-inner">${deltaStr}<span class="cell-val">${val.toFixed(decimals)}</span></div>${icons}</td>`
  }

  // Helper: single data cell for a raw question answer (handles reverse scoring display)
  function questionCell(
    q: Question,
    val: number | undefined,
    prevVal: number | undefined,
    emoteMask: number,
  ): string {
    if (val === undefined) return '<td class="td-num muted">—</td>'
    const rev = hasFlag(q, 'reverse')
    const effective = (raw: number) => rev ? itemMax - raw : raw
    const eff = effective(val)
    const prevEff = prevVal !== undefined ? effective(prevVal) : undefined
    const delta = prevEff !== undefined ? eff - prevEff : null
    const deltaStr = delta !== null && delta !== 0
      ? `<span class="cell-delta ${delta > 0 ? 'delta-up' : 'delta-down'}">${delta > 0 ? '+' : ''}${delta}</span>`
      : ''
    const reverseLabel = rev ? ` → ${eff} scored` : ''
    const title = `${val} — ${scaleLabels[val] ?? val}${reverseLabel}`
    const icons = emoteMask ? `<span class="cell-emotes">${emoteIcons(emoteMask)}</span>` : ''
    const display = rev ? `${val}<span class="cell-reversed" title="${title}"> ⇄${eff}</span>` : `${val}`
    return `<td class="td-num" title="${title}"><div class="cell-inner">${deltaStr}<span class="cell-val">${display}</span></div>${icons}</td>`
  }

  // Helper: full question row (<tr> with one questionCell per run column)
  function questionRow(q: Question, subclassKey: string, directCategory?: string): string {
    const qCells = runData.map(({ answers, emotes }, i) =>
      questionCell(q, answers.get(q.id), runData[i + 1]?.answers.get(q.id), emotes.get(q.id) ?? 0)
    ).join('')
    const rev = hasFlag(q, 'reverse')
    const revMarker = rev ? ' <span class="reverse-marker" title="reverse scored">⇄</span>' : ''
    const catAttr = directCategory ? ` data-category="${directCategory}"` : ''
    return `
      <tr class="row-question" data-subclass="${subclassKey}"${catAttr} style="display:none">
        <td class="td-question-text" title="${q.text}">${q.id}.${revMarker} ${q.text.length > 55 ? q.text.slice(0, 55) + '…' : q.text}</td>
        <td class="spark-col"></td>
        ${qCells}
      </tr>`
  }


  // Total row
  const totalCells = runData.map(({ score }, i) => {
    const prev = runData[i + 1]?.score
    const jump = prev !== undefined && isJump(dataset, score.total - prev.total)
    return valueCell(score.total, prev?.total, jump, 2, severities[i])
  }).join('')

  // Secondary score rows — one per @secondary / @count-ge declared in PSV
  const secondaryRows = runData[0].score.secondaries.map(sec => {
    const hasAny = runData.some(d => d.score.secondaries.some(s => s.flag === sec.flag))
    if (!hasAny) return ''
    const isCountGe = sec.type === 'count-ge'
    const secQuestions = isCountGe ? [] : runData[0].runQuestions.filter(q => hasFlag(q, sec.flag))
    const secValsChron = [...runData].reverse().map(d => d.score.secondaries.find(s => s.flag === sec.flag)?.total)
    const secCells = runData.map(({ score }, i) => {
      const s = score.secondaries.find(x => x.flag === sec.flag)
      const prev = runData[i + 1]?.score.secondaries.find(x => x.flag === sec.flag)
      if (!s) return '<td class="td-num muted">—</td>'
      const delta = prev !== undefined ? s.total - prev.total : null
      const jump = !isCountGe && delta !== null && Math.abs(delta) >= subclassJumpThreshold()
      const decimals = isCountGe ? 0 : 2
      const minDelta = isCountGe ? 0.5 : 0.005
      const deltaStr = delta !== null && Math.abs(delta) >= minDelta
        ? `<span class="cell-delta ${delta > 0 ? 'delta-up' : 'delta-down'}">${delta > 0 ? '+' : ''}${delta.toFixed(decimals)}</span>`
        : ''
      const cls = ['td-num', jump ? 'cell-jump' : ''].filter(Boolean).join(' ')
      const val = isCountGe ? `${s.sum}` : `${s.sum}/${s.count}=${s.total.toFixed(2)}`
      return `<td class="${cls}"><div class="cell-inner">${deltaStr}<span class="cell-val">${val}</span></div></td>`
    }).join('')
    const secQRows = secQuestions.map(q => questionRow(q, sec.flag)).join('')
    const toggleIcon = secQuestions.length > 0 ? '<span class="toggle-icon">▶</span> ' : ''
    const qCountLabel = secQuestions.length > 0 ? `<span class="q-count">${secQuestions.length}q</span>` : ''
    return `
      <tr class="row-subclass row-taxon${secQuestions.length === 0 ? ' no-expand' : ''}" data-subclass="${sec.flag}">
        <td class="subclass-toggle">
          ${toggleIcon}${sec.label}${qCountLabel}
        </td>
        <td class="spark-col">${sparkline(secValsChron)}</td>
        ${secCells}
      </tr>
      ${secQRows}`
  }).join('')

  // Subclass rows + question rows, grouped by category
  // Named category → collapsed category row + hidden subclass rows
  // Empty category → subclass rows shown directly
  // Empty subclass → questions appear directly under category (no subclass row)
  function subclassRowHtml(key: string, indent: boolean): string {
    const [cat, subName] = key.split('\0')
    const qs = questionsBySubclass.get(key) ?? []

    if (!subName) {
      // No subclass — questions are direct children of the category; controlled by category toggle
      return qs.map(q => questionRow(q, key, cat)).join('')
    }

    const subValsChron = [...runData].reverse().map(({ score }) => {
      const s = score.subclasses.find(x => `${x.category}\0${x.subclass}` === key)
      return s?.sum
    })
    const subCells = runData.map(({ score, emotes }, i) => {
      const s = score.subclasses.find(x => `${x.category}\0${x.subclass}` === key)
      const prev = runData[i + 1]?.score.subclasses.find(x => `${x.category}\0${x.subclass}` === key)
      const jumpThreshold = subclassJumpThreshold() * (s?.count ?? 1)
      const jump = s !== undefined && prev !== undefined && Math.abs(s.sum - prev.sum) >= jumpThreshold
      const subEmotes = qs.reduce((acc, q) => acc | (emotes.get(q.id) ?? 0), 0)
      return valueCell(s?.sum, prev?.sum, jump, 0, severities[i], subEmotes)
    }).join('')
    const qRows = qs.map(q => questionRow(q, key)).join('')
    return `
      <tr class="row-subclass" data-subclass="${key}"${cat ? ` data-category="${cat}"` : ''} ${indent ? 'style="display:none"' : ''}>
        <td class="subclass-toggle${indent ? ' subclass-indent' : ''}">
          <span class="toggle-icon">▶</span> ${subName}
          <span class="q-count">${qs.length}q</span>
        </td>
        <td class="spark-col">${sparkline(subValsChron)}</td>
        ${subCells}
      </tr>
      ${qRows}`
  }

  const categoryKeys = [...new Set(subclassKeys.map(k => k.split('\0')[0]))]
  const subclassRows = categoryKeys.map(cat => {
    const keys = subclassKeys.filter(k => k.split('\0')[0] === cat)
    if (!cat) return keys.map(k => subclassRowHtml(k, false)).join('')

    const catValsChron = [...runData].reverse().map(({ score }) => {
      const subs = score.subclasses.filter(s => s.category === cat)
      return subs.length > 0 ? subs.reduce((acc, s) => acc + s.sum, 0) : undefined
    })
    const catCells = runData.map(({ score }, i) => {
      const subs = score.subclasses.filter(s => s.category === cat)
      const val = subs.length > 0 ? subs.reduce((acc, s) => acc + s.sum, 0) : undefined
      const prevSubs = runData[i + 1]?.score.subclasses.filter(s => s.category === cat)
      const prevVal = prevSubs && prevSubs.length > 0 ? prevSubs.reduce((acc, s) => acc + s.sum, 0) : undefined
      return valueCell(val, prevVal, false, 0, severities[i])
    }).join('')
    const qCount = keys.reduce((acc, k) => acc + (questionsBySubclass.get(k)?.length ?? 0), 0)
    const hasSubs = keys.some(k => k.split('\0')[1] !== '')
    const countLabel = hasSubs ? `${keys.filter(k => k.split('\0')[1]).length} sub · ${qCount}q` : `${qCount}q`

    return `
      <tr class="row-category" data-category="${cat}">
        <td class="category-toggle">
          <span class="toggle-icon">▶</span> ${cat}
          <span class="q-count">${countLabel}</span>
        </td>
        <td class="spark-col">${sparkline(catValsChron)}</td>
        ${catCells}
      </tr>
      ${keys.map(k => subclassRowHtml(k, true)).join('')}`
  }).join('')

  // Radar chart — category mode (>3 named categories) and/or secondary mode (≥3 secondaries)
  const namedCats = categoryKeys.filter(c => c !== '')

  let catRadarSvg = ''
  if (namedCats.length > 3) {
    // Normalize by answered count (s.count * itemMax), not total questions in version.
    // For sampled datasets this is stable between runs (always same answered count per category).
    const catVals = (score: ReturnType<typeof computeScore>) => namedCats.map(cat => {
      const subs = score.subclasses.filter(s => s.category === cat)
      if (subs.length === 0) return 0
      const sum = subs.reduce((acc, s) => acc + s.sum, 0)
      const max = subs.reduce((acc, s) => acc + s.count * itemMax, 0)
      return max > 0 ? sum / max : 0
    })
    const avgValues = namedCats.map(cat => {
      const total = runData.reduce((acc, { score }) => {
        const subs = score.subclasses.filter(s => s.category === cat)
        if (subs.length === 0) return acc
        const sum = subs.reduce((a, s) => a + s.sum, 0)
        const max = subs.reduce((a, s) => a + s.count * itemMax, 0)
        return acc + (max > 0 ? sum / max : 0)
      }, 0)
      return total / runData.length
    })
    catRadarSvg = historyRadarSvg(namedCats, avgValues, runData.map(({ run, score }) => ({ id: run.id, values: catVals(score) })))
  }

  const secDefs = runData[0].score.secondaries
  let secRadarSvg = ''
  if (secDefs.length >= 3) {
    const axes = secDefs.map(s => s.label)
    const secVals = (score: ReturnType<typeof computeScore>) => secDefs.map(sec => {
      const s = score.secondaries.find(x => x.flag === sec.flag)
      return s ? s.total / itemMax : 0
    })
    const avgValues = secDefs.map(sec => {
      const avg = runData.reduce((acc, { score }) => {
        const s = score.secondaries.find(x => x.flag === sec.flag)
        return acc + (s ? s.total / itemMax : 0)
      }, 0) / runData.length
      return avg
    })
    secRadarSvg = historyRadarSvg(axes, avgValues, runData.map(({ run, score }) => ({ id: run.id, values: secVals(score) })))
  }

  let radarHtml = ''
  if (catRadarSvg && secRadarSvg) {
    radarHtml = `
      <div class="radar-section">
        <div class="radar-modes">
          <button class="radar-mode-btn active" data-radar-mode="cat">Categories</button>
          <button class="radar-mode-btn" data-radar-mode="sec">Secondary</button>
        </div>
        <div class="radar-view" data-mode="cat">${catRadarSvg}</div>
        <div class="radar-view" data-mode="sec" style="display:none">${secRadarSvg}</div>
      </div>`
  } else if (catRadarSvg) {
    radarHtml = `<div class="radar-section">${catRadarSvg}</div>`
  } else if (secRadarSvg) {
    radarHtml = `<div class="radar-section">${secRadarSvg}</div>`
  }

  body.innerHTML = `
    ${radarHtml}
    <div class="expand-controls">
      <button class="btn-ghost expand-next-btn">Expand next</button>
      <button class="btn-ghost collapse-all-btn">Collapse all</button>
    </div>
    <div class="table-scroll">
      <table class="history-table">
        <thead>
          <tr>
            <th class="metric-col"></th>
            <th class="spark-col"></th>
            ${dateHeaders}
          </tr>
        </thead>
        <tbody>
          <tr class="row-total">
            <td class="metric-label">Total <span class="scale-hint">${runData[0].score.scale}</span></td>
            <td class="spark-col">${sparkline(totalsChron)}</td>
            ${totalCells}
          </tr>
          ${secondaryRows}
          ${subclassRows}
        </tbody>
      </table>
    </div>
    <p class="legend muted">Click a category to expand subclasses. Click a subclass to expand questions. Highlighted cells changed ≥ jump threshold vs. next older run.</p>
  `

  // Expand-next / Collapse-all buttons
  function anyCollapsedCategories(): boolean {
    for (const row of body.querySelectorAll<HTMLElement>('.row-category')) {
      const cat = row.dataset.category!
      const children = [
        ...body.querySelectorAll<HTMLElement>(`.row-subclass[data-category="${CSS.escape(cat)}"]`),
        ...body.querySelectorAll<HTMLElement>(`.row-question[data-category="${CSS.escape(cat)}"]`),
      ]
      if (children.some(r => r.style.display === 'none')) return true
    }
    return false
  }

  function anyCollapsedSubclasses(): boolean {
    for (const row of body.querySelectorAll<HTMLElement>('.row-subclass')) {
      if (row.style.display === 'none') continue
      const key = row.dataset.subclass!
      const qRows = body.querySelectorAll<HTMLElement>(`.row-question[data-subclass="${CSS.escape(key)}"]`)
      if (qRows.length > 0 && Array.from(qRows).some(r => r.style.display === 'none')) return true
    }
    return false
  }

  function syncExpandButtons(): void {
    const btn = body.querySelector<HTMLButtonElement>('.expand-next-btn')
    if (btn) btn.disabled = !anyCollapsedCategories() && !anyCollapsedSubclasses()
  }

  function doExpandNext(): void {
    if (anyCollapsedCategories()) {
      body.querySelectorAll<HTMLElement>('.row-category').forEach(row => {
        const cat = row.dataset.category!
        body.querySelectorAll<HTMLElement>(`.row-subclass[data-category="${CSS.escape(cat)}"]`)
          .forEach(r => { r.style.display = '' })
        body.querySelectorAll<HTMLElement>(`.row-question[data-category="${CSS.escape(cat)}"]`)
          .forEach(r => { r.style.display = '' })
        const icon = row.querySelector<HTMLElement>('.toggle-icon')
        if (icon) icon.textContent = '▼'
      })
    } else if (anyCollapsedSubclasses()) {
      body.querySelectorAll<HTMLElement>('.row-subclass').forEach(row => {
        if (row.style.display === 'none') return
        const key = row.dataset.subclass!
        const qRows = body.querySelectorAll<HTMLElement>(`.row-question[data-subclass="${CSS.escape(key)}"]`)
        qRows.forEach(r => { r.style.display = '' })
        if (qRows.length > 0) {
          const icon = row.querySelector<HTMLElement>('.toggle-icon')
          if (icon) icon.textContent = '▼'
        }
      })
    }
    syncExpandButtons()
  }

  function doCollapseAll(): void {
    body.querySelectorAll<HTMLElement>('.row-question').forEach(r => { r.style.display = 'none' })
    body.querySelectorAll<HTMLElement>('.row-subclass[data-category]').forEach(r => {
      r.style.display = 'none'
      const icon = r.querySelector<HTMLElement>('.toggle-icon')
      if (icon) icon.textContent = '▶'
    })
    body.querySelectorAll<HTMLElement>('.row-category .toggle-icon').forEach(icon => { icon.textContent = '▶' })
    body.querySelectorAll<HTMLElement>('.row-subclass:not([data-category]) .toggle-icon')
      .forEach(icon => { icon.textContent = '▶' })
    syncExpandButtons()
  }

  syncExpandButtons()
  body.querySelector('.expand-next-btn')?.addEventListener('click', doExpandNext)
  body.querySelector('.collapse-all-btn')?.addEventListener('click', doCollapseAll)

  // Scroll to top so getBoundingClientRect() gives correct viewport-relative positions
  // even when navigating from a previously-scrolled history page.
  window.scrollTo(0, 0)

  // Set sticky offsets and table-scroll height after layout so measurements are accurate
  requestAnimationFrame(() => {
    const tbl = body.querySelector<HTMLElement>('.history-table')
    const scroll = body.querySelector<HTMLElement>('.table-scroll')
    if (!tbl || !scroll) return

    const ths = tbl.querySelectorAll<HTMLElement>('thead tr th')
    const col1w = ths[0]?.offsetWidth ?? 200
    const col2w = ths[1]?.offsetWidth ?? 90
    tbl.style.setProperty('--sticky-col2', `${col1w}px`)
    tbl.style.setProperty('--sticky-col3', `${col1w + col2w}px`)

    // max-height: sticky rows only activate when the table actually overflows the box.
    // height would create a tall empty box for short/collapsed tables, killing overflow.
    const legendH = (body.querySelector<HTMLElement>('.legend')?.offsetHeight ?? 0) + 16
    scroll.style.maxHeight = `${window.innerHeight - scroll.getBoundingClientRect().top - legendH}px`
  })

  // Radar hover — highlight run polygon on column header mouseenter (all radar SVGs)
  const radarEls = body.querySelectorAll<SVGElement>('.history-radar')
  if (radarEls.length > 0) {
    body.querySelectorAll<HTMLElement>('th.col-run').forEach((th, i) => {
      const runId = runData[i].run.id.toString()
      th.addEventListener('mouseenter', () => {
        radarEls.forEach(el => el.querySelectorAll<SVGElement>('.radar-run').forEach(p => {
          p.style.display = p.dataset.runId === runId ? '' : 'none'
        }))
      })
      th.addEventListener('mouseleave', () => {
        radarEls.forEach(el => el.querySelectorAll<SVGElement>('.radar-run').forEach(p => { p.style.display = 'none' }))
      })
    })
  }

  // Radar mode toggle
  body.querySelectorAll<HTMLElement>('.radar-mode-btn[data-radar-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.radarMode!
      const section = btn.closest('.radar-section')!
      section.querySelectorAll<HTMLElement>('.radar-view').forEach(v => {
        v.style.display = v.dataset.mode === mode ? '' : 'none'
      })
      section.querySelectorAll<HTMLElement>('.radar-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.radarMode === mode)
      })
    })
  })

  // Category / subclass / question expand-collapse
  body.addEventListener('click', e => {
    const target = e.target as HTMLElement

    const categoryRow = target.closest('.row-category') as HTMLElement | null
    if (categoryRow) {
      const cat = categoryRow.dataset.category!
      const subRows = body.querySelectorAll<HTMLElement>(`.row-subclass[data-category="${CSS.escape(cat)}"]`)
      const directQRows = body.querySelectorAll<HTMLElement>(`.row-question[data-category="${CSS.escape(cat)}"]`)
      const icon = categoryRow.querySelector('.toggle-icon')!
      const expanded = subRows.length > 0
        ? subRows[0].style.display !== 'none'
        : directQRows[0]?.style.display !== 'none'
      subRows.forEach(r => {
        r.style.display = expanded ? 'none' : ''
        if (expanded) {
          // collapse any open question rows when hiding the category
          const key = r.dataset.subclass!
          body.querySelectorAll<HTMLElement>(`.row-question[data-subclass="${CSS.escape(key)}"]`)
            .forEach(qr => { qr.style.display = 'none' })
          const subIcon = r.querySelector('.toggle-icon')
          if (subIcon) subIcon.textContent = '▶'
        }
      })
      directQRows.forEach(r => { r.style.display = expanded ? 'none' : '' })
      icon.textContent = expanded ? '▶' : '▼'
      syncExpandButtons()
      return
    }

    const subclassRow = target.closest('.row-subclass') as HTMLElement | null
    if (subclassRow) {
      const key = subclassRow.dataset.subclass!
      const qRows = body.querySelectorAll<HTMLElement>(`.row-question[data-subclass="${CSS.escape(key)}"]`)
      const icon = subclassRow.querySelector('.toggle-icon')!
      const expanded = qRows[0]?.style.display !== 'none'
      qRows.forEach(r => { r.style.display = expanded ? 'none' : '' })
      icon.textContent = expanded ? '▶' : '▼'
      syncExpandButtons()
      return
    }

    const link = target.closest('.run-link') as HTMLElement | null
    if (link) {
      e.preventDefault()
      navigate(`/summary/${link.dataset.runId}`)
      return
    }

    const del = target.closest('.delete-run-btn') as HTMLElement | null
    if (del) {
      if (del.dataset.pending !== 'true') {
        del.dataset.pending = 'true'
        del.textContent = 'Delete?'
        del.title = 'Click again to confirm delete'
        setTimeout(() => {
          if (del.dataset.pending === 'true') {
            del.dataset.pending = 'false'
            del.textContent = '✕'
            del.title = 'Delete'
          }
        }, 3000)
      } else {
        deleteRun(parseInt(del.dataset.runId!))
        // Remove the run's column from the DOM immediately.
        // navigate() won't re-trigger if the hash is already #/history/<dataset>.
        const th = del.closest('th') as HTMLTableCellElement
        const colIdx = th.cellIndex
        th.remove()
        body.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach(tr => {
          tr.cells[colIdx]?.remove()
        })
        // Remove radar polygon for this run
        const rid = del.dataset.runId!
        body.querySelectorAll<SVGElement>(`.radar-run[data-run-id="${rid}"]`).forEach(el => el.remove())
        if (body.querySelectorAll('th.col-run').length === 0) {
          body.innerHTML = '<p class="muted center">No completed runs yet.</p>'
        }
      }
    }
  })
}
