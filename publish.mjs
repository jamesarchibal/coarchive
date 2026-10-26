// mercantil · turns index.html into the page that ships.
//
//   node publish.mjs        -> writes public/index.html
//
// Three things get filled in, and NONE of them is typed by hand:
//   {{WORDMARK}} {{FAVICON}}  lifted from the live /agentes page, so the brand
//                             stays in one place
//   {{RESUMEN}}               counted by the database, so the hero numbers
//                             cannot drift from the data
//   {{CATALOGO}}              the products and their prices, straight from
//                             pedidos.mjs, so the price shown and the price
//                             charged are the same number
//
// serve.mjs imports plantilla() from here, so local development and the
// published page are built by the same code.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { CATALOGO } from './pedidos.mjs'
import { localClient, resumen } from './queries.mjs'

// fileURLToPath, never new URL(...).pathname: the latter keeps the %20 of
// "Mi unidad" and every file call then fails with EACCES.
export const HERE = path.dirname(fileURLToPath(import.meta.url))

const BRAND = path.resolve(HERE, '../content/media/landeros-site/agentes/index.html')

async function brand () {
  const html = await readFile(BRAND, 'utf8')
  const wordmark = (html.match(/<a class="brand"[^>]*>\s*<img[^>]*src="([^"]+)"/) || [])[1] || ''
  const favicon = (html.match(/<link[^>]+rel="(?:shortcut )?icon"[^>]*href="([^"]+)"/) || [])[1] || ''
  if (!wordmark || !favicon) throw new Error(`no brand assets in ${BRAND}`)
  return { wordmark, favicon }
}

// `ya` is a resumen that has already been counted. Nothing in production uses
// it, because publish.mjs runs once; serve.mjs does, because the resumen is a
// full scan of 741.233 rows and costs 5 to 6 seconds, and a browser that
// reloads three times queues three of those behind one SQLite connection and
// looks hung. Caching it is correct and not a shortcut: the base is REPLACED
// wholesale by build.mjs and never written to while being served, so the counts
// cannot change under a running process. The template itself is still rebuilt
// on every request, so editing index.html and reloading still works.
export async function plantilla (db, ya) {
  const [{ wordmark, favicon }, r] = await Promise.all([brand(), ya || resumen(db)])
  const html = (await readFile(path.join(HERE, 'index.html'), 'utf8'))
    .replace('{{WORDMARK}}', wordmark)
    .replace('{{FAVICON}}', favicon)
    .replace('{{RESUMEN}}', JSON.stringify(r))
    .replace('{{CATALOGO}}', JSON.stringify(CATALOGO))
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
