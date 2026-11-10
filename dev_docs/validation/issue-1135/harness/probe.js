#!/usr/bin/env node
/**
 * Read-only boot/probe diagnostics for the synthetic #1135 harness (not
 * evidence). Opens the synthetic host page (fork app iframe + route-mocked
 * Research Gateway), waits for the embedded session, prints frame URLs, the
 * embedded UI state (testids / body text / catalog rows), the synthetic
 * project/role and console/page errors.
 *
 * Usage:
 *   node probe.js [hostUrl] [waitMs] [--role=admin_readonly] [--scenes-inspect]
 */
const {
  chromium,
} = require('/home/lchen/workspace/RDLens/scripts/e2e/node_modules/playwright-core')

const CHROME = '/home/lchen/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'))
const HOST = positional[0] || 'http://127.0.0.1:8990/'
const WAIT = Number(positional[1] || 12000)
const roleArg = process.argv.find((value) => value.startsWith('--role='))
const ROLE = roleArg ? roleArg.split('=').slice(1).join('=') : null

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
    locale: 'en-US',
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
  const url = ROLE === null ? HOST : `${HOST}?role=${encodeURIComponent(ROLE)}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(WAIT)
  const frames = page.frames().map((frame) => frame.url())
  console.log('FRAMES:', JSON.stringify(frames, null, 2))
  const app = page.frames().find((frame) => frame.url().includes('/research'))
  if (app) {
    const notesReady = await app
      .locator('[data-testid="workbench-group-nav"]')
      .count()
      .catch(() => 0)
    console.log('WORKBENCH NAV:', notesReady)
    if (notesReady > 0) {
      await app.getByRole('button', { name: 'Notes', exact: true }).click().catch(() => {})
      await page.waitForTimeout(2500)
    }
    const state = await app.evaluate(() => {
      const testids = [
        ...new Set(
          [...document.querySelectorAll('[data-testid]')].map((node) =>
            node.getAttribute('data-testid'),
          ),
        ),
      ].slice(0, 120)
      const rows = [...document.querySelectorAll('[data-testid^="note-catalog-row-"]')].map(
        (node) => ({
          testid: node.getAttribute('data-testid'),
          editSchema: node.getAttribute('data-edit-schema'),
          buttons: [...node.querySelectorAll('button')].map((button) =>
            (button.getAttribute('aria-label') || button.textContent || '')
              .replace(/\s+/g, ' ')
              .trim(),
          ),
        }),
      )
      return {
        title: document.title,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 2000),
        testids,
        rows,
      }
    })
    console.log('APP STATE:', JSON.stringify(state, null, 2))
  } else {
    console.log('APP FRAME NOT FOUND')
  }
  console.log('LOGS:')
  for (const line of logs.slice(0, 100)) console.log(' ', line)
  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
