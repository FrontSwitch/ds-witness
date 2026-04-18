import { navigate } from '../router'
import { createRun, getIncompleteRun, saveAnswer, getAnswers, getEmotes, saveEmote,
         updateRunSettings, completeRun, deleteRun, getRun, getRunIndex,
         snapshotVersion, backfillRunVersions } from '../db'
import { loadQuestions, hasFlag, computeAssessmentVersion, type Question } from '../questions'
import { getDatasetConfig } from '../datasets'
import { EMOTES } from '../emotes'
import { seededShuffle, computeDormant, selectDormantSample } from '../dormancy'
import { sampleQuestions } from '../sampling'

function frontier(questions: Question[], answers: Map<string, number>): number {
  for (let i = 0; i < questions.length; i++) {
    if (!answers.has(questions[i].id)) return i
  }
  return questions.length
}

export async function assessmentPage(
  container: HTMLElement,
  params: Record<string, string>,
): Promise<void> {
  const dataset = params.dataset
  const forceNew = params.new === 'new'

  container.innerHTML = `
    <div class="page assessment-page">
      <header class="assessment-header">
        <button class="btn-ghost back-btn">← Back</button>
        <span class="dataset-label">${dataset.toUpperCase()}</span>
        <span class="progress-label" id="progress">0 / …</span>
        <button class="btn-ghost toggle-btn" id="shuffle-btn" title="Shuffle question order">⇄ Shuffle</button>
        <button class="btn-ghost toggle-btn" id="dormant-btn" title="Hide dormant questions">💤 Dormant</button>
        <button class="btn-ghost abandon-btn" id="abandon-btn">Abandon</button>
      </header>
      <div class="question-list" id="question-list">
        <div class="loading">Loading questions…</div>
      </div>
      <div class="assessment-footer" id="footer"></div>
    </div>
  `

  let questions: Question[]
  try {
    const loaded = await loadQuestions(dataset)
    if (!loaded) {
      container.querySelector('#question-list')!.innerHTML = `<div class="error">Dataset not found: ${dataset}</div>`
      return
    }
    questions = loaded
  } catch (err) {
    container.querySelector('#question-list')!.innerHTML =
      `<div class="error">Failed to load questions: ${err instanceof Error ? err.message : err}</div>`
    return
  }

  // Snapshot current version and backfill any unversioned runs
  const activeQuestions = questions.filter(q => !hasFlag(q, 'obsolete'))
  const version = await computeAssessmentVersion(questions)
  snapshotVersion(dataset, activeQuestions, version)
  backfillRunVersions(dataset, version)

  // Resolve run
  let runId: number
  if (forceNew) {
    runId = createRun(dataset, version)
  } else {
    const incomplete = getIncompleteRun(dataset)
    runId = incomplete ? incomplete.id : createRun(dataset, version)
  }

  // Mutable run settings (updated on toggle)
  let run = getRun(runId)!

  const answers = getAnswers(runId)
  const emoteState = getEmotes(runId)
  const config = getDatasetConfig(dataset)
  const scaleLabels = config.scaleLabels
  const answerValues = scaleLabels.map((_, i) => i)

  // Sampled datasets: pick 1 question per subclass per run using deck-cycling
  const isSampled = dataset === 'fsp'
  const sampledQuestions = isSampled ? sampleQuestions(activeQuestions, getRunIndex(dataset, runId)) : null

  // Dormancy (computed once; stable for this page load; skipped for sampled datasets)
  const dormantSet = isSampled ? new Set<string>() : computeDormant(dataset, activeQuestions, runId)
  const dormantSample = isSampled ? new Set<string>() : selectDormantSample([...dormantSet], runId)

  const ql = container.querySelector<HTMLElement>('#question-list')!
  const footer = container.querySelector<HTMLElement>('#footer')!
  const progressEl = container.querySelector<HTMLElement>('#progress')!
  const shuffleBtn = container.querySelector<HTMLButtonElement>('#shuffle-btn')!
  const dormantBtn = container.querySelector<HTMLButtonElement>('#dormant-btn')!

  if (config.preamble) {
    const preambleEl = document.createElement('p')
    preambleEl.className = 'assessment-preamble'
    preambleEl.textContent = config.preamble
    ql.before(preambleEl)
  }

  // ── Visible questions ────────────────────────────────────────────────────

  function getVisibleQuestions(): Question[] {
    let qs = sampledQuestions ?? questions.filter(q => !hasFlag(q, 'obsolete'))
    if (!isSampled && run.hide_dormant) {
      qs = qs.filter(q =>
        hasFlag(q, 'anchor') || !dormantSet.has(q.id) || dormantSample.has(q.id),
      )
    }
    if (run.shuffled) {
      qs = seededShuffle(qs, run.id)
    }
    return qs
  }

  let visibleQuestions = getVisibleQuestions()

  function updateProgress() {
    progressEl.textContent = `${answers.size} / ${visibleQuestions.length}`
  }

  function syncToggleButtons() {
    shuffleBtn.classList.toggle('active', run.shuffled === 1)
    if (isSampled) {
      dormantBtn.style.display = 'none'
    } else {
      dormantBtn.classList.toggle('active', run.hide_dormant === 1)
      if (dormantSet.size === 0) {
        dormantBtn.setAttribute('disabled', 'true')
        dormantBtn.title = 'No dormant questions yet (need 2 completed runs)'
      }
    }
  }

  // ── Question rendering ───────────────────────────────────────────────────

  function makeQuestionEl(q: Question, idx: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'question-item'
    el.dataset.qid = q.id

    const selected = answers.get(q.id)
    const emote = emoteState.get(q.id) ?? 0
    const isDormant = dormantSet.has(q.id)

    el.innerHTML = `
      <div class="q-header">
        <div class="q-meta">
          ${idx + 1}.
          ${q.category ? `<span class="q-category">${q.category}</span> › ` : ''}
          <span class="q-subclass">${q.subclass}</span>
          ${isDormant ? '<span class="dormant-badge">dormant</span>' : ''}
        </div>
        <div class="emote-row">
          ${EMOTES.map(e => `
            <button class="emote-btn${(emote & e.mask) ? ' active' : ''}"
                    data-emote="${e.mask}" title="${e.label}">${e.emoji}</button>
          `).join('')}
        </div>
      </div>
      <div class="q-text">${q.text}</div>
      <div class="answer-row">
        ${answerValues.map(v => `
          <button class="ans-btn${selected === v ? ' selected' : ''}" data-val="${v}" aria-pressed="${selected === v}">
            <span class="ans-num">${v}</span>
            <span class="ans-lbl">${scaleLabels[v]}</span>
          </button>
        `).join('')}
      </div>
    `

    el.querySelectorAll<HTMLButtonElement>('.ans-btn').forEach(btn => {
      btn.addEventListener('click', () => onAnswer(q, parseInt(btn.dataset.val!), el))
    })

    el.querySelectorAll<HTMLButtonElement>('.emote-btn').forEach(btn => {
      btn.addEventListener('click', () => onEmote(q, parseInt(btn.dataset.emote!), btn))
    })

    return el
  }

  // ── Event handlers ───────────────────────────────────────────────────────

  function onAnswer(q: Question, value: number, el: HTMLElement) {
    const prevFrontier = frontier(visibleQuestions, answers)
    answers.set(q.id, value)
    saveAnswer(runId, q.id, value)

    el.querySelectorAll<HTMLButtonElement>('.ans-btn').forEach(btn => {
      const isSelected = parseInt(btn.dataset.val!) === value
      btn.classList.toggle('selected', isSelected)
      btn.setAttribute('aria-pressed', String(isSelected))
    })

    updateProgress()

    const newFrontier = frontier(visibleQuestions, answers)

    if (newFrontier > prevFrontier && newFrontier < visibleQuestions.length) {
      const nextEl = makeQuestionEl(visibleQuestions[newFrontier], newFrontier)
      nextEl.classList.add('q-entering')
      ql.appendChild(nextEl)
      requestAnimationFrame(() => {
        nextEl.classList.remove('q-entering')
        requestAnimationFrame(() => {
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
        })
      })
    }

    if (newFrontier === visibleQuestions.length) {
      showCompleteButton()
    }
  }

  function onEmote(q: Question, mask: number, btn: HTMLButtonElement) {
    const current = emoteState.get(q.id) ?? 0
    const next = current ^ mask
    emoteState.set(q.id, next)
    saveEmote(runId, q.id, next)
    btn.classList.toggle('active', (next & mask) !== 0)
  }

  function showCompleteButton() {
    footer.innerHTML = `<button class="btn-primary complete-btn">Complete assessment →</button>`
    footer.querySelector('.complete-btn')!.addEventListener('click', () => {
      completeRun(runId)
      navigate(`/summary/${runId}`)
    })
    setTimeout(() => footer.querySelector('.complete-btn')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100)
  }

  // ── List rebuild (on shuffle/dormant toggle) ─────────────────────────────

  function rebuildList() {
    visibleQuestions = getVisibleQuestions()
    const f = frontier(visibleQuestions, answers)
    const visCount = Math.min(f + 1, visibleQuestions.length)
    ql.innerHTML = ''
    for (let i = 0; i < visCount; i++) {
      ql.appendChild(makeQuestionEl(visibleQuestions[i], i))
    }
    updateProgress()
    footer.innerHTML = ''
    if (f === visibleQuestions.length) showCompleteButton()
  }

  // ── Toggle buttons ───────────────────────────────────────────────────────

  shuffleBtn.addEventListener('click', () => {
    run = { ...run, shuffled: run.shuffled ? 0 : 1 }
    updateRunSettings(runId, { shuffled: run.shuffled === 1 })
    syncToggleButtons()
    rebuildList()
  })

  dormantBtn.addEventListener('click', () => {
    run = { ...run, hide_dormant: run.hide_dormant ? 0 : 1 }
    updateRunSettings(runId, { hideDormant: run.hide_dormant === 1 })
    syncToggleButtons()
    rebuildList()
  })

  const abandonBtn = container.querySelector<HTMLButtonElement>('#abandon-btn')!
  let abandonPending = false
  abandonBtn.addEventListener('click', () => {
    if (!abandonPending) {
      abandonPending = true
      abandonBtn.textContent = 'Sure?'
      abandonBtn.classList.add('abandon-confirm')
      setTimeout(() => {
        if (abandonPending) {
          abandonPending = false
          abandonBtn.textContent = 'Abandon'
          abandonBtn.classList.remove('abandon-confirm')
        }
      }, 3000)
    } else {
      deleteRun(runId)
      navigate('/home')
    }
  })

  container.querySelector('.back-btn')!.addEventListener('click', () => navigate('/home'))

  // ── Initial render ───────────────────────────────────────────────────────

  syncToggleButtons()
  rebuildList()

  const f = frontier(visibleQuestions, answers)
  if (f < visibleQuestions.length) {
    setTimeout(() => {
      const items = ql.querySelectorAll('.question-item')
      items[f]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
  }
}
