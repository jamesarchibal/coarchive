// mercantil · turns index.html into the page that ships.
//
//   node publish.mjs        -> writes public/index.html
//
// Three things get filled in, and NONE of them is typed by hand:
//   {{WORDMARK}} {{FAVICON}}  lifted from the live /agentes page, so the brand
//                             stays in one place
//   {{RESUMEN}}               counted by the database, so the hero numbers
//                             cannot drift from the data
//
// serve.mjs imports plantilla() from here, so local development and the
// published page are built by the same code.

import { createClient } from '@libsql/client'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

import { resumen } from './queries.mjs'

// fileURLToPath, never new URL(...).pathname: the latter keeps the %20 of
// "Mi unidad" and every file call then fails with EACCES.
export const HERE = path.dirname(fileURLToPath(import.meta.url))

// The base lives OUTSIDE Google Drive. Drive syncs files while they are still
// being written, and a half-written SQLite file is a corrupt SQLite file.
export const DB_FILE = path.join(os.homedir(), 'mercantil-data', 'empresas.db')

const BRAND = path.resolve(HERE, '../content/media/landeros-site/agentes/index.html')

export function localClient () {
  return createClient({ url: `file:${DB_FILE}` })
}

async function brand () {
  const html = await readFile(BRAND, 'utf8')
  const wordmark = (html.match(/<a class="brand"[^>]*>\s*<img[^>]*src="([^"]+)"/) || [])[1] || ''
  const favicon = (html.match(/<link[^>]+rel="(?:shortcut )?icon"[^>]*href="([^"]+)"/) || [])[1] || ''
  if (!wordmark || !favicon) throw new Error(`no brand assets in ${BRAND}`)
  return { wordmark, favicon }
}

export async function plantilla (db) {
  const [{ wordmark, favicon }, r] = await Promise.all([brand(), resumen(db)])
  const html = (await readFile(path.join(HERE, 'index.html'), 'utf8'))
    .replace('{{WORDMARK}}', wordmark)
    .replace('{{FAVICON}}', favicon)
    .replace('{{RESUMEN}}', JSON.stringify(r))
  if (html.includes('{{')) throw new Error('a placeholder was left unfilled')
  return { html, resumen: r }
}

// Comparing import.meta.url to a file:// string silently fails here: the URL
// keeps the %20 of "Mi unidad" and the argv path does not. Compare real paths.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = localClient()
  const { html, resumen: r } = await plantilla(db)
  await mkdir(path.join(HERE, 'public'), { recursive: true })
  await writeFile(path.join(HERE, 'public', 'index.html'), html)
  const n = (x) => x.toLocaleString('es-ES')
  process.stdout.write(
    `public/index.html  ${n(html.length)} bytes\n` +
    `${n(r.empresas)} empresas · ${n(r.actos)} actos · ${r.desde} a ${r.hasta}\n`,
  )
}
