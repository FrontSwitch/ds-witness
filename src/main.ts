import './style.css'
import { initDB } from './db'
import { checkDisclaimer } from './disclaimer'
import { route, initRouter } from './router'
import { homePage } from './pages/home'
import { assessmentPage } from './pages/assessment'
import { summaryPage } from './pages/summary'
import { historyPage } from './pages/history'
import { importPage } from './pages/import'

async function main() {
  const app = document.querySelector<HTMLDivElement>('#app')!

  app.innerHTML = '<div class="loading app-loading">Initialising…</div>'

  await initDB()

  const accepted = await checkDisclaimer(app)
  if (!accepted) return

  app.innerHTML = '<div class="loading app-loading">Loading…</div>'

  route('/home', () => homePage(app))
  route('/assessment/:dataset', ({ dataset }) => assessmentPage(app, { dataset }))
  route('/assessment/:dataset/:new', ({ dataset, new: n }) => assessmentPage(app, { dataset, new: n }))
  route('/summary/:runId', ({ runId }) => summaryPage(app, { runId }))
  route('/history/:dataset', ({ dataset }) => historyPage(app, { dataset }))
  route('/import', () => importPage(app))

  initRouter(app)
}

main().catch(err => {
  document.querySelector('#app')!.innerHTML =
    `<div class="error app-error">Failed to start: ${err.message}</div>`
  console.error(err)
})
