import { navigate } from '../router'
import { getRun, getCompletedRuns, getAnswers, getQuestionsForVersion } from '../db'
import { loadQuestions, hasFlag } from '../questions'
import { computeScore, isJump, subclassJumpThreshold, type Score, type SubclassScore } from '../scoring'
import { getSeverityBand } from '../datasets'

function deltaClass(delta: number): string {
  if (Math.abs(delta) < 0.001) return ''
  return delta > 0 ? 'delta-up' : 'delta-down'
}

function fmtDelta(delta: number): string {
  if (Math.abs(delta) < 0.001) return ''
  return (delta > 0 ? '+' : '') + delta.toFixed(2)
}

function subclassMap(score: Score): Map<string, SubclassScore> {
  return new Map(score.subclasses.map(s => [`${s.category}\0${s.subclass}`, s]))
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

export async function summaryPage(
  container: HTMLElement,
  params: Record<string, string>,
): Promise<void> {
  const runId = parseInt(params.runId)

  container.innerHTML = `<div class="page summary-page"><div class="loading">Loading…</div></div>`

  const run = getRun(runId)
  if (!run) {
    container.innerHTML = `
      <div class="page summary-page">
        <header class="summary-header">
          <button class="btn-ghost back-btn">← Home</button>
        </header>
        <div class="error">Run not found.</div>
      </div>`
    container.querySelector('.back-btn')!.addEventListener('click', () => navigate('/home'))
    return
  }

  const psvQuestions = await loadQuestions(run.dataset) ?? []
  const answers = getAnswers(runId)

  const runQuestions = run.assessment_version
    ? getQuestionsForVersion(run.assessment_version)
    : psvQuestions.filter(q => !hasFlag(q, 'obsolete'))
  const score = computeScore(run.dataset, runQuestions, answers)

  // Previous completed run for delta
  const completed = getCompletedRuns(run.dataset).filter(r => r.id !== runId)
  let prevScore: Score | null = null
  if (completed.length > 0) {
    const prevRun = completed[0]
    const prevQuestions = prevRun.assessment_version
      ? getQuestionsForVersion(prevRun.assessment_version)
      : psvQuestions.filter(q => !hasFlag(q, 'obsolete'))
    prevScore = computeScore(run.dataset, prevQuestions, getAnswers(prevRun.id))
  }

  const totalDelta = prevScore !== null ? score.total - prevScore.total : null
  const prevMap = prevScore ? subclassMap(prevScore) : null

  const date = run.completed_at
    ? new Date(run.completed_at).toLocaleDateString(undefined, { dateStyle: 'long' })
    : 'In progress'

  const secondaryRows = score.secondaries.map(sec => {
    const prev = prevScore?.secondaries.find(s => s.flag === sec.flag)
    const isCountGe = sec.type === 'count-ge'
    const delta = prev != null ? sec.sum - prev.sum : null
    const meanDelta = isCountGe ? null : (prev != null ? sec.total - prev.total : null)
    const jump = !isCountGe && meanDelta !== null && Math.abs(meanDelta) >= subclassJumpThreshold()
    return `
      <tr class="${jump ? 'row-jump' : ''} row-taxon-summary">
        <td class="td-category"></td>
        <td class="td-subclass">${sec.label}</td>
        <td class="td-num">${isCountGe ? sec.sum : (sec.count > 0 ? `${sec.sum}/${sec.count}` : '—')}</td>
        <td class="td-num">${isCountGe ? '—' : (sec.count > 0 ? sec.total.toFixed(2) : '—')}</td>
        <td class="td-num">${isCountGe ? sec.count : sec.count}</td>
        ${prevScore ? `
          <td class="td-delta ${deltaClass(isCountGe ? (delta ?? 0) : (meanDelta ?? 0))}">${isCountGe ? (delta !== null ? fmtDelta(delta) : '—') : (meanDelta !== null ? fmtDelta(meanDelta) : '—')}</td>
          <td class="td-delta ${deltaClass(delta ?? 0)}">${delta !== null ? fmtDelta(delta) : '—'}</td>
        ` : ''}
      </tr>
    `
  }).join('')

  // Build subclass rows
  const subclassRows = score.subclasses.map(s => {
    const prev = prevMap?.get(`${s.category}\0${s.subclass}`)
    const meanDelta = prev !== undefined ? s.mean - prev.mean : null
    const sumDelta = prev !== undefined ? s.sum - prev.sum : null
    const jump = meanDelta !== null && Math.abs(meanDelta) >= subclassJumpThreshold()
    return `
      <tr class="${jump ? 'row-jump' : ''}">
        <td class="td-category">${s.category}</td>
        <td class="td-subclass">${s.subclass}</td>
        <td class="td-num">${s.sum}</td>
        <td class="td-num">${s.mean.toFixed(2)}</td>
        <td class="td-num">${s.count}</td>
        ${prevScore ? `
          <td class="td-delta ${deltaClass(meanDelta ?? 0)}">${meanDelta !== null ? fmtDelta(meanDelta) : '—'}</td>
          <td class="td-delta ${deltaClass(sumDelta ?? 0)}">${sumDelta !== null ? fmtDelta(sumDelta) : '—'}</td>
        ` : ''}
      </tr>
    `
  }).join('')

  const totalJump = totalDelta !== null && isJump(run.dataset, totalDelta)
  const severityBand = getSeverityBand(run.dataset, score.total)

  const page = container.querySelector('.page')!
  page.innerHTML = `
    <header class="summary-header">
      <button class="btn-ghost back-btn">← Home</button>
      <h2>${run.dataset.toUpperCase()} — ${date}</h2>
      <button class="btn-ghost history-btn">History</button>
    </header>

    <div class="score-hero ${totalJump ? 'score-jump' : ''} ${severityBand?.level ?? ''}">
      <div class="score-big">${score.total.toFixed(2)}</div>
      <div class="score-scale">${score.scale}</div>
      ${severityBand ? `<div class="score-severity">${severityBand.label}</div>` : ''}
      ${totalDelta !== null ? `
        <div class="score-delta ${deltaClass(totalDelta)}">
          ${fmtDelta(totalDelta)} vs previous
        </div>
      ` : '<div class="score-delta">First run</div>'}
      ${run.assessment_version ? `<div class="score-version">${run.assessment_version}</div>` : ''}
      ${run.duration_seconds != null ? `<div class="score-duration">${fmtDuration(run.duration_seconds)}</div>` : ''}
    </div>

    <div class="summary-section">
      <h3>By subclass</h3>
      <div class="table-scroll">
        <table class="summary-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Subclass</th>
              <th>Sum</th>
              <th>Mean</th>
              <th>n</th>
              ${prevScore ? '<th>Δ Mean</th><th>Δ Sum</th>' : ''}
            </tr>
          </thead>
          <tbody>${subclassRows}${secondaryRows}</tbody>
        </table>
      </div>
    </div>

    ${prevScore ? `
      <div class="summary-section">
        <h3>Changed questions</h3>
        <div id="changed-questions"></div>
      </div>
    ` : ''}
  `

  page.querySelector('.back-btn')!.addEventListener('click', () => navigate('/home'))
  page.querySelector('.history-btn')!.addEventListener('click', () => navigate(`/history/${run.dataset}`))

  // Changed questions
  if (prevScore) {
    const prevAnswers = getAnswers(completed[0].id)
    const changed = runQuestions.filter(q => {
      const cur = answers.get(q.id)
      const pre = prevAnswers.get(q.id)
      return cur !== undefined && pre !== undefined && cur !== pre
    })

    const cq = page.querySelector('#changed-questions')!
    if (changed.length === 0) {
      cq.innerHTML = '<p class="muted">No changes from previous run.</p>'
    } else {
      cq.innerHTML = `
        <table class="summary-table">
          <thead><tr><th>#</th><th>Category</th><th>Subclass</th><th>Question</th><th>Prev</th><th>Now</th><th>Δ</th></tr></thead>
          <tbody>
            ${changed.map(q => {
              const cur = answers.get(q.id)!
              const pre = prevAnswers.get(q.id)!
              const d = cur - pre
              const qi = runQuestions.indexOf(q) + 1
              return `
                <tr>
                  <td class="td-num">${qi}</td>
                  <td>${q.category}</td>
                  <td>${q.subclass}</td>
                  <td class="td-question">${q.text}</td>
                  <td class="td-num">${pre}</td>
                  <td class="td-num">${cur}</td>
                  <td class="td-delta ${deltaClass(d)}">${fmtDelta(d)}</td>
                </tr>
              `
            }).join('')}
          </tbody>
        </table>
      `
    }
  }
}
