/**
 * Runs in the page's ISOLATED world. Bridges the postMessage events emitted by capture-fetch
 * (which lives in the MAIN world and can't talk to chrome.runtime) over to the service worker.
 */
const TAG = 'afino-capture'

console.log('[afino-capture] bridge loaded on', location.host)

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as { source?: string; host?: string; headers?: Record<string, string>; ts?: number } | null
  if (!data || data.source !== TAG || !data.host || !data.headers) return
  console.log('[afino-capture] forwarding headers to SW', { host: data.host, names: Object.keys(data.headers) })
  chrome.runtime
    .sendMessage({
      type: 'captured-headers',
      host: data.host,
      headers: data.headers,
    })
    .catch(() => {
      // Service worker may be sleeping; chrome.runtime queues the wake-up. Ignore failures.
    })
})
