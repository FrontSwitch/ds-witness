import { navigate } from '../router'
import { VERSION } from '../version'
import { getCompletedRuns, getIncompleteRun, getAnswers } from '../db'
import { loadQuestions, getDatasetMeta, type DatasetMeta } from '../questions'
import { computeScore } from '../scoring'
import { radarSvg } from '../radar'
import type { Run } from '../db'

// Fallback if datasets.json is missing
const FALLBACK_DATASETS = ['mid-60', 'mid-162', 'phq-9', 'gad-7', 'ffmq-15', 'dss', 'fsp']

interface DatasetEntry {
  id: string
  path?: string  // path under /data/ (without .psv); defaults to id
}

async function loadManifest(): Promise<DatasetEntry[]> {
  try {
    const res = await fetch('/data/datasets.json')
    if (!res.ok) return FALLBACK_DATASETS.map(id => ({ id }))
    const raw: Array<string | DatasetEntry> = await res.json()
    return raw.map(e => typeof e === 'string' ? { id: e } : e)
  } catch {
    return FALLBACK_DATASETS.map(id => ({ id }))
  }
}

interface CardData {
  dataset: string
  completed: Run[]
  incomplete: Run | null
  scoreHtml: string
  radarHtml: string
  meta: Partial<DatasetMeta>
  daysUntilDue: number | null
}

function datasetCard({ dataset, completed, incomplete, scoreHtml, radarHtml, meta, daysUntilDue }: CardData): string {
  const title = meta.title ?? dataset.toUpperCase()

  let dueHtml = ''
  if (daysUntilDue !== null) {
    if (daysUntilDue === -Infinity || daysUntilDue <= 0) {
      dueHtml = `<div class="card-due take-now">take now</div>`
    } else {
      dueHtml = `<div class="card-due">in ${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</div>`
    }
  }

  const attribution = meta.copyright || meta.link
    ? `<div class="card-attribution">` +
      (meta.copyright ? `<span class="card-copyright">${meta.copyright}</span>` : '') +
      (meta.link ? `<a class="card-link" href="${meta.link}" target="_blank" rel="noopener noreferrer">↗</a>` : '') +
      `</div>`
    : ''

  return `
    <div class="dataset-card">
      <div class="card-header">
        <div class="card-title">${title}</div>
        ${meta.tagline ? `<div class="card-tagline">${meta.tagline}</div>` : ''}
        ${attribution}
      </div>
      <div class="card-status">
        <span class="card-meta">${completed.length} run${completed.length !== 1 ? 's' : ''}</span>
        ${dueHtml}
      </div>
      ${scoreHtml}
      ${radarHtml}
      <div class="card-actions">
        ${incomplete
          ? `<button class="btn-secondary" data-action="resume" data-dataset="${dataset}">Resume</button>`
          : `<button class="btn-primary" data-action="start" data-dataset="${dataset}">Start</button>`
        }
        ${incomplete ? `<button class="btn-primary" data-action="start-new" data-dataset="${dataset}">New run</button>` : ''}
        ${completed.length > 0
          ? `<button class="btn-ghost" data-action="history" data-dataset="${dataset}">History</button>`
          : ''}
      </div>
    </div>
  `
}

export async function homePage(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="page home-page">
      <header class="app-header">
        <h1>Dissociative System Witness</h1>
        <button class="btn-ghost" id="import-btn">Import data</button>
      </header>
      <div class="dataset-grid" id="dataset-grid">
        <div class="loading">Loading…</div>
      </div>
      <footer class="app-footer">
        <span class="footer-copy">© 2026 Front Switch Studio</span>
        <button class="btn-ghost footer-about-btn" id="about-btn">About</button>
        <span class="footer-version">v${VERSION}</span>
      </footer>
      <div class="about-overlay" id="about-overlay" hidden>
        <div class="about-modal">
          <button class="about-close" id="about-close">✕</button>
          <img src="/logo.svg" class="about-logo" alt="Front Switch Studio logo" />
          <h2 class="about-title">Dissociative System Witness</h2>
          <p>A local, private psychology assessment tracker. Run structured assessments, watch your scores change over time, and annotate questions that stand out with emotes.</p>
          <p>Customize question wording to match what means something to you. No server, no account, no data leaves your machine. The database is a plain SQLite file you own.</p>
          <p class="about-disclaimer">DISCLAIMER: This tool is a personal data collection project for self-observation. It is NOT a diagnostic tool, medical device, or substitute for professional clinical advice. Use at your own risk.</p>
          <div class="about-links">
            <a class="about-github" href="https://github.com/FrontSwitch/ds-witness" target="_blank" rel="noopener">GitHub</a>
            <span class="about-copy-line">© 2026 Front Switch Studio</span>
          </div>
        </div>
      </div>
    </div>
  `

  container.querySelector('#import-btn')!.addEventListener('click', () => navigate('/import'))

  const aboutOverlay = container.querySelector<HTMLElement>('#about-overlay')!
  container.querySelector('#about-btn')!.addEventListener('click', () => { aboutOverlay.hidden = false })
  container.querySelector('#about-close')!.addEventListener('click', () => { aboutOverlay.hidden = true })
  aboutOverlay.addEventListener('click', (e) => { if (e.target === aboutOverlay) aboutOverlay.hidden = true })

  const grid = container.querySelector('#dataset-grid')!

  const manifest = await loadManifest()

  // Build card data (load questions + meta, compute urgency); skip missing PSVs
  const cardData = (await Promise.all(manifest.map(async ({ id: dataset, path: psvPath }) => {
    const completed = getCompletedRuns(dataset)
    const incomplete = getIncompleteRun(dataset)

    let scoreHtml = ''
    let radarHtml = ''
    try {
      const questions = await loadQuestions(dataset, psvPath)
      if (!questions) return null  // PSV not found — skip this card
      if (completed.length > 0) {
        const answers = getAnswers(completed[0].id)
        const score = computeScore(dataset, questions, answers)
        const d = new Date(completed[0].completed_at!).toLocaleDateString()
        scoreHtml = `<div class="latest-score">Last: <strong>${score.total.toFixed(2)}</strong> <span class="scale">(${score.scale})</span> on ${d}</div>`

        const itemMax = getDatasetMeta(dataset).itemMax ?? 4
        const cats = [...new Set(score.subclasses.map(s => s.category).filter(Boolean))]
        const catSvg = cats.length > 3 ? radarSvg(cats, cats.map(cat => {
          const subs = score.subclasses.filter(s => s.category === cat)
          const sum = subs.reduce((acc, s) => acc + s.sum, 0)
          const max = subs.reduce((acc, s) => acc + s.count * itemMax, 0)
          return max > 0 ? sum / max : 0
        })) : ''
        const secSvg = score.secondaries.length >= 3 ? radarSvg(
          score.secondaries.map(s => s.label),
          score.secondaries.map(s => s.total / itemMax),
        ) : ''
        if (catSvg && secSvg) {
          radarHtml = `<div class="card-radar">
            <div class="radar-modes">
              <button class="radar-mode-btn active" data-action="radar-mode" data-mode="cat">Categories</button>
              <button class="radar-mode-btn" data-action="radar-mode" data-mode="sec">Secondary</button>
            </div>
            <div class="radar-view" data-mode="cat">${catSvg}</div>
            <div class="radar-view" data-mode="sec" style="display:none">${secSvg}</div>
          </div>`
        } else if (catSvg) {
          radarHtml = `<div class="card-radar">${catSvg}</div>`
        } else if (secSvg) {
          radarHtml = `<div class="card-radar">${secSvg}</div>`
        }
      }
    } catch { /* psv not loaded yet */ }

    const meta = getDatasetMeta(dataset)

    let daysUntilDue: number | null = null
    if (meta.frequencyDays !== undefined) {
      if (completed.length === 0) {
        daysUntilDue = -Infinity
      } else {
        const lastMs = new Date(completed[0].completed_at!).getTime()
        const nextMs = lastMs + meta.frequencyDays * 86400_000
        daysUntilDue = Math.ceil((nextMs - Date.now()) / 86400_000)
      }
    }

    return { dataset, completed, incomplete, scoreHtml, radarHtml, meta, daysUntilDue }
  }))).filter((d): d is CardData => d !== null)

  // Sort: most overdue first; datasets with no frequency last
  cardData.sort((a, b) => {
    if (a.daysUntilDue === null && b.daysUntilDue === null) return 0
    if (a.daysUntilDue === null) return 1
    if (b.daysUntilDue === null) return -1
    if (a.daysUntilDue === -Infinity) return b.daysUntilDue === -Infinity ? 0 : -1
    if (b.daysUntilDue === -Infinity) return 1
    return (a.daysUntilDue as number) - (b.daysUntilDue as number)
  })

  grid.innerHTML = cardData.map(datasetCard).join('')

  grid.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
    if (!btn) return
    const { action, dataset, mode } = btn.dataset
    if (action === 'start' || action === 'resume') navigate(`/assessment/${dataset}`)
    if (action === 'start-new') navigate(`/assessment/${dataset}/new`)
    if (action === 'history') navigate(`/history/${dataset}`)
    if (action === 'radar-mode') {
      const card = btn.closest('.dataset-card')!
      card.querySelectorAll<HTMLElement>('.radar-view').forEach(v => {
        v.style.display = v.dataset.mode === mode ? '' : 'none'
      })
      card.querySelectorAll<HTMLElement>('.radar-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode)
      })
    }
  })
}
