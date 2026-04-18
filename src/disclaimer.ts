const STORAGE_KEY = 'dsw-disclaimer-accepted'

export function hasAccepted(): boolean {
  return localStorage.getItem(STORAGE_KEY) === '1'
}

function setAccepted(): void {
  localStorage.setItem(STORAGE_KEY, '1')
}

async function exitApp(container: HTMLElement): Promise<void> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().close()
  } else {
    container.innerHTML = `
      <div class="disclaimer-declined">
        <p>You have declined the disclaimer.</p>
        <p>Close this tab to exit.</p>
      </div>`
  }
}

// Shows the disclaimer and resolves true (accepted) or false (declined).
// If already accepted, resolves immediately.
export function checkDisclaimer(container: HTMLElement): Promise<boolean> {
  if (hasAccepted()) return Promise.resolve(true)

  return new Promise(resolve => {
    container.innerHTML = `
      <div class="disclaimer-overlay">
        <div class="disclaimer-box">
          <h2>Disclaimer</h2>
          <p class="disclaimer-text">
            This tool is a personal data collection project for self-observation.
            It is <strong>NOT</strong> a diagnostic tool, medical device, or substitute
            for professional clinical advice. Use at your own risk.
          </p>
          <div class="disclaimer-actions">
            <button class="btn-primary" id="disclaimer-accept">Accept</button>
            <button class="btn-ghost" id="disclaimer-decline">Decline</button>
          </div>
        </div>
      </div>`

    container.querySelector('#disclaimer-accept')!.addEventListener('click', () => {
      setAccepted()
      resolve(true)
    })

    container.querySelector('#disclaimer-decline')!.addEventListener('click', () => {
      resolve(false)
      exitApp(container)
    })
  })
}
