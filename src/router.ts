type Handler = (params: Record<string, string>) => void | (() => void) | Promise<void>

interface Route {
  pattern: RegExp
  keys: string[]
  handler: Handler
}

const routes: Route[] = []
let container: HTMLElement
let currentCleanup: (() => void) | void | Promise<void>

export function route(path: string, handler: Handler): void {
  const keys: string[] = []
  const src = path.replace(/:([^/]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)' })
  routes.push({ pattern: new RegExp(`^${src}$`), keys, handler })
}

export function navigate(path: string): void {
  window.location.hash = path
}

export function initRouter(el: HTMLElement): void {
  container = el

  function dispatch() {
    if (typeof currentCleanup === 'function') void currentCleanup()
    container.innerHTML = ''

    const hash = window.location.hash.slice(1) || '/home'
    for (const { pattern, keys, handler } of routes) {
      const m = hash.match(pattern)
      if (m) {
        const params: Record<string, string> = {}
        keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
        currentCleanup = handler(params)
        return
      }
    }
    navigate('/home')
  }

  window.addEventListener('hashchange', dispatch)
  dispatch()
}
