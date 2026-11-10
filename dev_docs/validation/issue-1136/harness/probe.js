#!/usr/bin/env node
/**
 * Read-only boot/probe diagnostics for the synthetic #1136 harness (not evidence).
 *
 * Opens the synthetic host page (fork app iframe + route-mocked Research
 * Gateway), waits for the embedded session, prints frame URLs, embedded UI
 * state, the synthetic project name, draft-cache keys and console/page errors.
 * Optionally exercises the host project-switch dev hook (--switch=p2).
 *
 * Usage:
 *   node probe.js [hostUrl] [waitMs] [--switch=p2]
 */
const {
  chromium,
} = require('/home/lchen/workspace/RDLens/scripts/e2e/node_modules/playwright-core')

const CHROME = '/home/lchen/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'))
const HOST = positional[0] || 'http://127.0.0.1:8972/'
const WAIT = Number(positional[1] || 9000)
const switchArg = process.argv.find((value) => value.startsWith('--switch='))
const SWITCH = switchArg ? switchArg.split('=').slice(1).join('=') : null

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  const logs = []
  page.on('console', (message) => logs.push(`[${message.type()}] ${message.text().slice(0, 400)}`))
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message.slice(0, 400)}`))
  page.on('requestfailed', (request) =>
    logs.push(
      `[requestfailed] ${request.method()} ${request.url().slice(0, 160)} ${request.failure()?.errorText}`,
    ),
  )
  await page.goto(HOST, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(WAIT)
  const frames = page.frames().map((frame) => frame.url())
  console.log('FRAMES:', JSON.stringify(frames, null, 2))
  const app = page.frames().find((frame) => frame.url().includes('/research'))
  if (app) {
    const state = await app.evaluate(() => {
      const projectNode = document.querySelector('[data-testid="rdlens-target-project-name"]')
      return {
        title: document.title,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
        testids: [
          ...new Set(
            [...document.querySelectorAll('[data-testid]')].map((node) =>
              node.getAttribute('data-testid'),
            ),
          ),
        ].slice(0, 80),
        projectName: projectNode
          ? {
              text: (projectNode.textContent || '').trim(),
              source: projectNode.getAttribute('data-project-source'),
            }
          : null,
        storageKeys: Object.keys(window.localStorage || {}).filter((key) =>
          key.startsWith('rdlens.research.note.v1'),
        ),
      }
    })
    console.log('APP STATE:', JSON.stringify(state, null, 2))
    if (SWITCH) {
      const result = await page.evaluate(
        (projectId) =>
          typeof window.__hostSendToken === 'function'
            ? window.__hostSendToken(projectId)
            : { ok: false, reason: 'hook_missing' },
        SWITCH,
      )
      console.log('HOST SWITCH RESULT:', JSON.stringify(result))
      await page.waitForTimeout(4000)
      const after = await app.evaluate(() => {
        const node = document.querySelector('[data-testid="rdlens-target-project-name"]')
        return {
          projectName: node ? (node.textContent || '').trim() : null,
          projectSource: node ? node.getAttribute('data-project-source') : null,
          hasNav: Boolean(document.querySelector('[data-testid="workbench-group-nav"]')),
          hasCatalog: Boolean(document.querySelector('[data-testid="note-catalog"]')),
          text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
        }
      })
      console.log('APP AFTER SWITCH:', JSON.stringify(after, null, 2))
    }
  } else {
    console.log('APP FRAME NOT FOUND')
  }
  console.log('LOGS:')
  for (const line of logs.slice(0, 80)) console.log(' ', line)
  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
