// mercantil · the read-only queries, shared by the local server and by the
// Vercel functions.
//
// Everything talks to libSQL, not to node:sqlite, so there is ONE code path.
// Local development opens the file directly (`file:/...`), production opens
// the Turso replica over HTTP. Same SQL either way.

import { createClient } from '@libsql/client'
import os from 'node:os'
import path from 'node:path'

import { SECCIONES, NOMBRE_SECCION } from './cnae.mjs'
import { HECHOS, BIT, listaHechos } from './hechos.mjs'

// The base lives OUTSIDE Google Drive. Drive syncs files while they are still
// being written, and a half-written SQLite file is a corrupt SQLite file.
export const DB_FILE = path.join(os.homedir(), 'mercantil-data', 'empresas.db')

// ⚠️ This lives here, next to the SQL it serves, and NOT in publish.mjs, where
// it used to. publish.mjs imports CATALOGO from pedidos.mjs, so a `const { ... }
// = await import('./publish.mjs')` inside pedidos.mjs closed a cycle: the
// top-level await of the CLI waited for publish.mjs, which waited for the
// pedidos.mjs that was still evaluating. Node printed "unsettled top-level
// await" and the process exited without running the command. queries.mjs
// imports nothing of ours but cnae and hechos, so importing it is always safe.
export function localClient () {
  return createClient({ url: `file:${DB_FILE}` })
}

const PAGE = 40

// Above this the count stops counting and the page says "more than". See the
// measurement next to the count query itself.
const TOPE = 1000

// How many matches of a text search are ranked and then ordered. ⚠️ This is not
// a nicety, it is what keeps the search alive on the hosted copy, and the shape
// of the query around it was measured against Turso on 2026-10-23.
//
// A text search used to read `empresa_fts MATCH ?` joined to `empresa` and
// ordered by `e.n_actos`. "servicios" matches 78.212 companies and
// "construcciones" 9.659, and ORDER BY makes SQLite build the whole sorted set
// before the LIMIT, so it read every one of those rows out of a 1,1 GB table:
// 50,9 s for "construcciones" and far worse for "servicios". Vercel kills a
// function at 10 s, so /api/buscar answered 504 FUNCTION_INVOCATION_TIMEOUT to
// every common word. A covering index did not save it (22,6 s) because the
// sorter materialises the selected columns, not just the sort key.
//
// What works is to let FTS5 pick the best RELEVANTES claves on its own index,
// which costs nothing, and only then touch the table. Measured, same words:
// "servicios" 2,3 s, two words 3,3 s, a rare name 0,19 s, and 0,5 s warm.
// 400 is ten pages of results, and the page prints the limit out loud.
const RELEVANTES = 400

// Weights for bm25, one per indexed column of empresa_fts in declaration order:
// the name counts ten times the object clause. Measured 2026-10-23: plain
// `ORDER BY rank` answered "servicios" with MARORTOTAL GESTION SL first,
// because the word was in its object clause, while this weighting answers with
// the companies actually called SERVICIOS something.
const PESOS = 'bm25(empresa_fts, 10.0, 1.0)'

// Size bands over capital_eur, in euros.
//
// ⚠️ CAPITAL IS THE ONLY SIZE SIGNAL BORME PUBLISHES. Not employees, not
// revenue, not the balance sheet. The page has to say so, or a reader will
// take "pequeña" to mean few employees, which this base cannot know.
//
// The cuts are the ones the law draws, not round numbers: 3.000 EUR is the
// minimum capital of an SL and 60.000 EUR that of an SA, so the first band is
// "the legal minimum" and the third starts where a public company must start.
// Measured on a two-day build (2026-10-22): of the companies that publish a
// capital, most sit at exactly 3.000,00 EUR, so a band below that cut would be
// almost empty and this one must include it.
export const TRAMOS = [
  ['min', 0, 3000, 'Capital mínimo, hasta 3.000 €'],
  ['peq', 3000, 60000, '3.001 € a 60.000 €'],
  ['med', 60000, 300000, '60.001 € a 300.000 €'],
  ['gra', 300000, 3000000, '300.001 € a 3.000.000 €'],
  ['max', 3000000, null, 'Más de 3.000.000 €'],
]

// ⚠️ The events live in hechos.mjs, imported above, because build.mjs needs
// the same list and the bit of each event is its position in it. Re-declaring
// them here would let the two files drift, and a drift of one line changes the
// meaning of every row already stored.
export { HECHOS }

const unTramo = (id) => TRAMOS.find((t) => t[0] === id)

// FTS5 treats most punctuation as syntax. Quoting every token turns a user
// phrase into a safe prefix search and stops a stray `"` from throwing.
export function ftsQuery (q) {
  const tokens = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 8)
  if (!tokens.length) return null
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' ')
}

// The filter names, in one place. api/buscar.js and serve.mjs both read the
// request through this, so adding a filter cannot land on one route and be
// missing on the other. That drift is invisible in local development, where
// only serve.mjs runs.
export const FILTROS = ['q', 'provincia', 'forma', 'estado', 'seccion', 'tramo', 'hecho', 'anio']

export function entrada (get) {
  const o = { page: Number(get('page')) || 1 }
  for (const k of FILTROS) o[k] = get(k) || ''
  return o
}

export async function buscar (db, { q, provincia, forma, estado, seccion, tramo, hecho, anio, page }) {
  const where = []
  const args = []
  const from = 'empresa e'
  let texto = false

  // ⚠️ The text search is a bounded set of claves, never a join. See RELEVANTES
  // above: joining empresa_fts to empresa and ordering the result is what made
  // the hosted search time out, and this subquery is answered inside the FTS5
  // index without reading a single company row.
  if (q) {
    const fq = ftsQuery(q)
    if (fq) {
      texto = true
      where.push(`e.clave IN (SELECT f.clave FROM empresa_fts f
                               WHERE empresa_fts MATCH ?
                               ORDER BY ${PESOS} LIMIT ${RELEVANTES})`)
      args.push(fq)
    }
  }
  if (provincia) { where.push('e.provincia = ?'); args.push(provincia) }
  if (forma) { where.push('e.forma = ?'); args.push(forma) }
  if (estado) { where.push('e.estado = ?'); args.push(estado) }

  // Every value below is looked up in a table defined in this file, never
  // interpolated from the request. An unknown section or band is ignored, so a
  // hand-typed query string cannot reach the SQL.
  if (seccion && NOMBRE_SECCION[seccion]) { where.push('e.seccion = ?'); args.push(seccion) }

  const t = tramo && unTramo(tramo)
  if (t) {
    // The lower bound is exclusive and the upper inclusive, so the bands touch
    // without overlapping and 3.000,00 lands in the minimum band.
    where.push(t[2] === null ? 'e.capital_eur > ?' : 'e.capital_eur > ? AND e.capital_eur <= ?')
    args.push(t[1])
    if (t[2] !== null) args.push(t[2])
  }

  // What has happened to the company, as one bit of e.hechos. ⚠️ A bit test and
  // not a second table, and the reason is measured, three times on the full
  // base. As `clave IN (SELECT ... FROM empresa_hecho)` the list of 68.176
  // claves for `extincion` was built and sorted before anything else could
  // happen: 3.768 ms. As `EXISTS (SELECT 1 FROM empresa_hecho ...)` the common
  // cases dropped to 56 ms, but the planner cannot guess how many companies an
  // EXISTS over another table keeps, so it still chose the wrong half of the
  // query whenever a second wide filter was on: the worst pair, "amplió capital"
  // with "capital mínimo", cost 4.315 ms. As a bit of a column the test rides
  // inside the same covering index as every other filter, and the planner can
  // see it: of the 55 pairs of event and size band, 10 were above a second and
  // now none are, worst 469 ms. Full note in build.mjs, on the column itself.
  if (hecho && BIT[hecho]) {
    where.push('(e.hechos & ?) <> 0')
    args.push(BIT[hecho])
  }

  // Year of incorporation. ⚠️ It filters on `comienzo`, the "Comienzo de
  // operaciones" written inside the act, NOT on `constitucion`, which is only
  // the day the Constitucion act was published. Filtering on the publication
  // date can answer nothing but 2024, 2025 and 2026, and it would print
  // "constituida en 2024" over a company of 1998 that was published late.
  //
  // It still means "incorporated in", never "existing since": a company only
  // has a year here if its incorporation was published inside the loaded
  // window. The page offers only the years the data holds, counted in
  // resumen().
  const year = Number(anio)
  if (Number.isInteger(year) && year >= 1900 && year <= 2100) {
    where.push('e.comienzo >= ? AND e.comienzo <= ?')
    args.push(`${year}-01-01`, `${year}-12-31`)
  }

  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const order = q ? 'e.n_actos DESC' : 'e.ultimo_acto DESC'
  const p = Math.max(1, Math.min(250, Number(page) || 1))
  const offset = (p - 1) * PAGE

  // The labels of the newest act come along, because "last movement: 14.03.25"
  // tells a reader nothing on its own and WHAT moved is the whole point of a
  // bulletin of changes. The subquery runs once per returned row, so 40 times,
  // and acto_clave covers it.
  const rows = (await db.execute({
    sql: `SELECT e.clave, e.nombre, e.provincia, e.hoja, e.forma, e.constitucion,
                 e.objeto, e.cnae, e.seccion, e.capital, e.capital_eur,
                 e.ultimo_acto, e.n_actos, e.estado,
                 (SELECT a.etiquetas FROM acto a WHERE a.clave = e.clave
                   ORDER BY a.fecha DESC, a.id DESC LIMIT 1) AS ultimas
          FROM ${from} ${w}
          ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}`,
    args,
  })).rows.map((r) => ({ ...r, ultimas: JSON.parse(r.ultimas || '[]') }))

  // The exact total is the expensive half of this function, so it is capped and
  // reported as "more than" above the cap. A count has to touch one row per
  // company it counts, and two wide filters at once make that the whole query:
  // measured on the full base 2026-10-22, "cambió de domicilio" with "capital
  // mínimo" cost 5.263 ms to count to 5.001 and 439 ms to count to 1.001, while
  // the forty rows the visitor actually reads took 33 ms. Nobody pages past the
  // first few hundred, so the cap buys nothing above TOPE.
  //
  // ⚠️ The ORDER BY inside the subquery is not decoration. Without it the
  // planner picks a different index from the one the rows query uses and the
  // count goes back to seconds.
  const total = Number((await db.execute({
    sql: `SELECT COUNT(*) n FROM (
            SELECT e.clave FROM ${from} ${w} ORDER BY ${order} LIMIT ${TOPE + 1})`,
    args,
  })).rows[0].n)

  // `tope` travels with the answer so the page can write the cap in words
  // instead of carrying a copy of the number that would drift from this one.
  // `relevantes` is only set when a text search filled its whole set, and it is
  // the page's cue to say "the 400 most relevant" instead of "400 companies",
  // because there can be 78.212 behind it.
  return {
    rows,
    total,
    capped: total > TOPE,
    tope: TOPE,
    relevantes: texto && total >= RELEVANTES ? RELEVANTES : null,
    page: p,
  }
}

export async function empresa (db, clave) {
  const e = (await db.execute({
    sql: 'SELECT * FROM empresa WHERE clave = ?',
    args: [String(clave || '')],
  })).rows[0]
  if (!e) return null

  const actos = (await db.execute({
    sql: 'SELECT fecha, etiquetas, texto FROM acto WHERE clave = ? ORDER BY fecha DESC, id DESC',
    args: [e.clave],
  })).rows

  return {
    ...e,
    // The column holds a bitmask; the page wants the ids, so the mask is
    // decoded here and the page never has to know there are bits.
    hechos: listaHechos(e.hechos),
    actos: actos.map((a) => ({ ...a, etiquetas: JSON.parse(a.etiquetas || '[]') })),
  }
}

// Counted once at publish time and baked into the page, never typed by hand
// and never re-run per visit: it reads the whole table.
export async function resumen (db) {
  const one = async (sql) => (await db.execute(sql)).rows[0]
  const [a, b, c, d] = await Promise.all([
    one('SELECT COUNT(*) n FROM empresa'),
    one('SELECT COUNT(*) n FROM acto'),
    one('SELECT COUNT(DISTINCT provincia) n FROM empresa'),
    one('SELECT MIN(fecha) d1, MAX(fecha) d2 FROM acto'),
  ])
  const provs = (await db.execute(
    'SELECT provincia p, COUNT(*) n FROM empresa GROUP BY 1 ORDER BY 1',
  )).rows
  // The legal forms come from the data, not from a list in the page. The page
  // used to offer SLU, SAU and SAS, and all three match zero companies: BORME
  // registers the legal name, and unipersonality is a circumstance written in
  // the acts, never a suffix of the name. A filter that can only return
  // nothing is worse than no filter.
  const formas = (await db.execute(
    'SELECT forma f, COUNT(*) n FROM empresa WHERE forma IS NOT NULL GROUP BY 1 ORDER BY 2 DESC',
  )).rows

  // Same rule for the three new filters: every option carries the number of
  // companies behind it, counted here, and an option with zero behind it is
  // dropped before the page ever sees it.
  const secCount = Object.fromEntries((await db.execute(
    'SELECT seccion s, COUNT(*) n FROM empresa WHERE seccion IS NOT NULL GROUP BY 1',
  )).rows.map((r) => [r.s, Number(r.n)]))

  // One pass for all eleven events, not eleven passes. The bits cannot be
  // grouped by, so each one is its own SUM over the same scan; the column
  // travels inside emp_tamano, so SQLite reads the index and never touches the
  // table. ⚠️ The SQL is generated from HECHOS, so an event added there is
  // counted here without anyone remembering to come back.
  const hechoRow = (await db.execute(
    `SELECT ${HECHOS.map(([id]) => `SUM((hechos & ${BIT[id]}) <> 0) "${id}"`).join(', ')}
       FROM empresa`,
  )).rows[0]
  const hechoCount = Object.fromEntries(HECHOS.map(([id]) => [id, Number(hechoRow[id])]))

  const tramoCount = Object.fromEntries(await Promise.all(TRAMOS.map(async ([id, lo, hi]) => {
    const sql = hi === null
      ? 'SELECT COUNT(*) n FROM empresa WHERE capital_eur > ?'
      : 'SELECT COUNT(*) n FROM empresa WHERE capital_eur > ? AND capital_eur <= ?'
    const r = await db.execute({ sql, args: hi === null ? [lo] : [lo, hi] })
    return [id, Number(r.rows[0].n)]
  })))

  // ⚠️ A handful of acts carry a Comienzo de operaciones in the future (45 in
  // 2027 and 19 beyond, measured on the full base 2026-10-22). They are typing
  // mistakes in the bulletin, not companies, so the upper bound drops them
  // instead of offering a year that cannot have happened.
  const anios = (await db.execute({
    sql: `SELECT substr(comienzo, 1, 4) y, COUNT(*) n FROM empresa
           WHERE comienzo IS NOT NULL AND comienzo <= ? GROUP BY 1 ORDER BY 1 DESC`,
    args: [new Date().toISOString().slice(0, 10)],
  })).rows

  const conCapital = await one('SELECT COUNT(*) n FROM empresa WHERE capital_eur IS NOT NULL')
  const conCnae = await one('SELECT COUNT(*) n FROM empresa WHERE seccion IS NOT NULL')
  const conConstitucion = await one('SELECT COUNT(*) n FROM empresa WHERE comienzo IS NOT NULL')

  const conCuenta = (lista) => lista.filter((x) => x.n > 0)

  return {
    empresas: Number(a.n),
    actos: Number(b.n),
    provincias: Number(c.n),
    desde: d.d1,
    hasta: d.d2,
    listaProvincias: provs.map((r) => ({ p: r.p, n: Number(r.n) })),
    listaFormas: formas.map((r) => ({ f: r.f, n: Number(r.n) })),
    listaSecciones: conCuenta(SECCIONES.map(([l, , nombre]) => ({ s: l, nombre, n: secCount[l] || 0 }))),
    listaTramos: conCuenta(TRAMOS.map(([id, , , nombre]) => ({ t: id, nombre, n: tramoCount[id] || 0 }))),
    listaHechos: conCuenta(HECHOS.map(([id, nombre]) => ({ h: id, nombre, n: hechoCount[id] || 0 }))),
    listaAnios: anios.map((r) => ({ y: r.y, n: Number(r.n) })),
    // What the page must print next to each filter, so nobody reads an empty
    // result as "there are none" when it means "BORME did not publish it".
    cobertura: {
      capital: Number(conCapital.n),
      cnae: Number(conCnae.n),
      constitucion: Number(conConstitucion.n),
    },
  }
}
