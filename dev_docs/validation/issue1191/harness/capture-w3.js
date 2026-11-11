#!/usr/bin/env node
/**
 * Issue #1191 (W3 接线: 目标壳 W3 入口 + 单份 Markdown 导出入口) fork visual evidence.
 *
 * Synthetic harness: real fork Next.js app (`next dev --webpack`, embedded mode) in a
 * synthetic host iframe + route-mocked Research Gateway. No real RDLens host /
 * PostgreSQL / SurrealDB / private data / model calls; all fixtures synthetic.
 *
 * Scenes:
 *   s12b  PR-A: default target shell -> Outcomes trigger -> W3 note catalog ->
 *         open d2-v1 note -> wide editor overlay (save status) -> close.
 *         Before: target shell -> Outcomes trigger -> read-only catalog (gap).
 *   s10   PR-B: editor overlay action area -> "Export Markdown" -> real download
 *         (bytes verified) / status. Before: no export UI entry (gap).
 *
 * Usage:
 *   node capture-w3.js --phase=after  --host=http://127.0.0.1:8874/ --head=<sha>
 *   node capture-w3.js --phase=before --host=http://127.0.0.1:8872/ --head=<sha>
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { chromium } = require('/home/lchen/workspace/RDLens/scripts/e2e/node_modules/playwright-core')

const CHROME = '/home/lchen/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const arg = (name, fallback) => {
  const match = process.argv.find((item) => item.startsWith(`--${name}=`))
  return match ? match.split('=').slice(1).join('=') : fallback
}
const PHASE = arg('phase', 'after')
const HOST = arg('host', PHASE === 'after' ? 'http://127.0.0.1:8874/' : 'http://127.0.0.1:8872/')
const HEAD = arg('head', 'unrecorded')
const OUT_DIR = path.resolve(arg('outdir', path.join(__dirname, '..', 'screenshots')))
const LOG_FILE = path.resolve(arg('logfile', path.join(__dirname, '..', 'capture.log')))
const GATEWAY = arg('gateway', 'http://127.0.0.1:8841')
const PREFIX = PHASE === 'after' ? 'after' : 'before'
const ONLY_SCENES = (arg('scenes', 's12b,s10') || '').split(',').filter(Boolean)
const sceneEnabled = (name) => ONLY_SCENES.includes(name)
const CAPABILITY_MODE_FILE = '/tmp/issue1048-capability-mode'
const EXPORT_MODE_FILE = '/tmp/issue1191-export-mode'
fs.mkdirSync(OUT_DIR, { recursive: true })

function log(line) {
  const text = `${new Date().toISOString()} ${line}`
  console.log(text)
  fs.appendFileSync(LOG_FILE, `${text}\n`)
}

function gatewayCall(method, urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${GATEWAY}${urlPath}`, { method }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') })
        } catch {
          resolve({ status: response.statusCode, body: null })
        }
      })
    })
    request.on('error', reject)
    request.end()
  })
}

async function setModes({ capability = 'export_on', exportMode = 'success' } = {}) {
  fs.writeFileSync(CAPABILITY_MODE_FILE, capability)
  fs.writeFileSync(EXPORT_MODE_FILE, exportMode)
  await gatewayCall('GET', '/__reset')
}

const stats = async () => (await gatewayCall('GET', '/__stats')).body || {}

async function openApp(browser, width) {
  const height = width === 1440 ? 900 : 768
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    acceptDownloads: true,
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  await page.goto(HOST, { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({
    content: 'nextjs-portal,[data-nextjs-toast],[data-nextjs-dialog-overlay]{display:none!important}',
  })
  let frame = null
  for (let attempt = 0; attempt < 120 && frame === null; attempt += 1) {
    frame = page.frames().find((candidate) => candidate.url().includes('/research')) ?? null
    if (frame === null) await page.waitForTimeout(250)
  }
  if (frame === null) throw new Error('research iframe did not boot')
  await frame.waitForSelector('[data-testid="rdlens-target-shell"]', { timeout: 45000 })
  // 等待顶栏成果入口与（可能的）能力读取就绪。
  await frame.waitForSelector('[data-testid="rdlens-target-outcomes-trigger"]', { timeout: 30000 })
  await page.waitForTimeout(1200)
  return { context, page, frame, consoleErrors, width, height }
}

async function shot(bundle, name) {
  const file = path.join(OUT_DIR, `${PREFIX}__${name}__${bundle.width}x${bundle.height}.png`)
  await bundle.page.screenshot({ path: file, fullPage: false })
  log(`SHOT ${path.basename(file)} head=${HEAD} width=${bundle.width}`)
  return file
}

async function openOutcomes(bundle) {
  const frame = bundle.frame
  await frame.locator('[data-testid="rdlens-target-outcomes-trigger"]').click()
  await frame.waitForSelector('[data-testid="rdlens-target-right-pane"][data-pane-kind="outcomes"]', {
    timeout: 20000,
  })
  await bundle.page.waitForTimeout(600)
}

async function openEditorFromCatalog(bundle, noteId = 'note_cite') {
  const frame = bundle.frame
  await frame.waitForSelector(`[data-testid="note-open-${noteId}"]`, { timeout: 25000 })
  await frame.locator(`[data-testid="note-open-${noteId}"]`).click()
  await frame.waitForSelector('[data-testid="rdlens-target-editor"]', { timeout: 30000 })
  await frame.waitForSelector('[data-testid="note-editor"]', { timeout: 30000 })
  await bundle.page.waitForTimeout(900)
}

async function run() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const results = []
  try {
    for (const width of [1440, 1024]) {
      await setModes()
      const bundle = await openApp(browser, width)
      log(`OPEN phase=${PHASE} width=${width} head=${HEAD} host=${HOST}`)
      const frame = bundle.frame
      try {
        // ── S12b：默认目标壳 W3 入口 ──
        if (!sceneEnabled('s12b')) {
          results.push({ scenario: 'S12b', skipped: true })
        } else {
          const s12b = { scenario: 'S12b', phase: PHASE, width, checks: {}, shots: [] }
          s12b.shots.push(await shot(bundle, 's12b_01-target-shell'))
          await openOutcomes(bundle)
          s12b.shots.push(await shot(bundle, 's12b_02-outcomes-panel'))
          const catalogCount = await frame.locator('[data-testid="note-catalog"]').count()
          const editorCount = await frame.locator('[data-testid="note-editor"]').count()
          s12b.checks.target_shell =
            (await frame.locator('[data-testid="rdlens-target-shell"]').count()) > 0
          s12b.checks.w3_catalog_visible = catalogCount > 0
          s12b.checks.editor_before_click_absent = editorCount === 0
          if (PHASE === 'after') {
            await openEditorFromCatalog(bundle)
            const title = await frame
              .locator('[data-testid="rdlens-target-editor-title"]')
              .textContent()
            const revision = await frame
              .locator('[data-testid="rdlens-target-editor-revision"]')
              .textContent()
            const saveStatus = await frame
              .locator('[data-testid="rdlens-target-editor"] [data-testid="note-save-status"]')
              .first()
              .getAttribute('data-status')
            const writingFull = await frame.locator('[data-testid="note-editor-write-full"]').count()
            s12b.checks.editor_overlay = true
            s12b.checks.editor_title = title
            s12b.checks.editor_revision = revision
            s12b.checks.save_status = saveStatus
            s12b.checks.writing_entry = writingFull > 0
            s12b.shots.push(await shot(bundle, 's12b_03-editor-overlay'))
            s12b.checks.delete_entry =
              (await frame.locator('[data-testid="note-editor-delete"]').count()) > 0
            s12b.checks.close_entry =
              (await frame.locator('[data-testid="rdlens-target-editor-back"]').count()) > 0
            await frame.locator('[data-testid="rdlens-target-editor-back"]').click()
            await frame.waitForSelector('[data-testid="rdlens-target-editor"]', {
              state: 'detached',
              timeout: 20000,
            })
            s12b.checks.closed_and_catalog_kept =
              (await frame.locator('[data-testid="note-catalog"]').count()) > 0
            s12b.shots.push(await shot(bundle, 's12b_04-closed-back-to-catalog'))
          } else {
            // Before：只读成果目录（无 W3 目录/编辑器）——登记缺口，不折算 PASS。
            const readonlyText = await frame
              .locator('[data-testid="rdlens-target-outcomes-panel"]')
              .first()
              .textContent()
            s12b.checks.note_catalog_absent = catalogCount === 0
            s12b.checks.editor_absent = editorCount === 0
            s12b.checks.readonly_text_present = Boolean(
              readonlyText && /W3|not available/i.test(readonlyText),
            )
            s12b.expected_gap = true
          }
          results.push(s12b)
          log(`RESULT_S12B ${JSON.stringify(s12b)}`)
        }

        // ── S10：单份 Markdown 导出 UI 入口 ──
        if (!sceneEnabled('s10')) {
          results.push({ scenario: 'S10', skipped: true })
        } else {
          const s10 = { scenario: 'S10', phase: PHASE, width, checks: {}, shots: [] }
          if (PHASE === 'after') {
            await openEditorFromCatalog(bundle)
            const exportEntry = await frame.locator('[data-testid="note-export-markdown"]').count()
            s10.checks.export_entry_visible = exportEntry > 0
            s10.shots.push(await shot(bundle, 's10_01-editor-export-entry'))
            const downloadPromise = bundle.page.waitForEvent('download', { timeout: 30000 })
            await frame.locator('[data-testid="note-export-markdown"]').click()
            const download = await downloadPromise
            const downloadPath = path.join(OUT_DIR, 'downloads')
            fs.mkdirSync(downloadPath, { recursive: true })
            const savedFile = path.join(
              downloadPath,
              `${PREFIX}_s10__${width}__${download.suggestedFilename()}`,
            )
            await download.saveAs(savedFile)
            const bytes = fs.readFileSync(savedFile)
            const text = bytes.toString('utf8')
            s10.checks.filename = download.suggestedFilename()
            s10.checks.bytes = bytes.length
            s10.checks.utf8_no_bom = !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
            s10.checks.not_json = !text.trimStart().startsWith('{')
            s10.checks.has_markdown_heading = text.startsWith('# ')
            s10.checks.has_version_anchor = /revision=\d+ snapshot_hash=[0-9a-f]{8,}/.test(text)
            s10.checks.has_note_body = text.includes('[synthetic]')
            await bundle.page.waitForTimeout(800)
            s10.checks.status_exported =
              (await frame.locator('[data-testid="note-export-status"]').textContent()) ?? null
            s10.shots.push(await shot(bundle, 's10_02-exported'))
            const s = await stats()
            const create = (s.export_creates || [])[0] || null
            s10.checks.server_contract = create ? create.contract : null
            s10.checks.server_idempotency_key_present = create
              ? Boolean(create.idempotency_key)
              : false
            s10.checks.server_body_keys =
              create && create.body ? Object.keys(create.body).sort() : null
            s10.checks.server_body = create ? create.body : null
            s10.checks.download_gets = (s.export_gets || []).length
          } else {
            const exportEntry = await frame.locator('[data-testid="note-export-markdown"]').count()
            const anyEditor = await frame.locator('[data-testid="note-editor"]').count()
            s10.checks.export_entry_absent = exportEntry === 0
            s10.checks.w3_editor_absent = anyEditor === 0
            s10.expected_gap = true
            s10.shots.push(await shot(bundle, 's10_01-no-w3-export-entry'))
          }
          results.push(s10)
          log(`RESULT_S10 ${JSON.stringify(s10)}`)
        }

        log(
          `CONSOLE_ERRORS phase=${PHASE} width=${width} ${JSON.stringify(
            bundle.consoleErrors.slice(0, 10),
          )}`,
        )
      } finally {
        await bundle.context.close()
      }
    }
  } finally {
    await browser.close()
  }
  fs.writeFileSync(path.join(OUT_DIR, `${PREFIX}-results.json`), JSON.stringify(results, null, 2))
  log(`DONE phase=${PHASE} results=${results.length}`)
}

run().catch((error) => {
  log(`FATAL ${error && error.stack ? error.stack : String(error)}`)
  process.exit(1)
})
