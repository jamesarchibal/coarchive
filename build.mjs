#!/usr/bin/env node
//
// mercantil · build the free company base from BORME.
//
// What this is: the Spanish half of a pappers.fr. Pappers works because France
// made the register free, so the SEARCH is free and only the extras are paid.
// In Spain the register is not free, so the only census we can own and publish
// is BORME, the official bulletin, which is open data at the BOE and is
// published precisely to be read.
//
// What BORME gives:   denomination, province, registry sheet, every inscribed
//                     act with its date, and on Constitucion also the objeto
//                     social, domicilio, capital and sometimes the CNAE.
// What BORME lacks:   the NIF and the accounts. Those cost money at
//                     sede.registradores.org (measured 2026-10-21: 2,98 EUR
//                     base + 0,601012 EUR per asiento, before VAT).
//
// PRIVACY. Section A names natural persons: administrators, attorneys, the
// deceased. This builder NEVER stores a personal name: act text goes through
// redact() before it is written. A company administrator KEEPS its name, which
// is the point of a company register. The rule, why it is shaped that way and
// what it cannot do are all in redact.mjs. Read that file before touching this.
//
// Usage
//   node build.mjs                                  # everything in the cache
//   node build.mjs --from 2026-01-01 --to 2026-10-02
//   node build.mjs --from 2024-10-01 --to 2026-10-02 --db empresas.db
//   node build.mjs --stats                          # report, no ingest
//
// Days already ingested are skipped, so re-running is cheap and a long
// backfill can be interrupted.
//
// Cost: zero. No API key. Reads the ARPA cache first, the BOE only on a miss.

import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { redact } from './redact.mjs'
import { seccion } from './cnae.mjs'
import { mascara } from './hechos.mjs'

// `new URL(...).pathname` keeps the %20 of "Mi unidad" and every write fails
// with EACCES on a path that does not exist. Always decode it.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CACHE = path.resolve(HERE, '../arpa-tool/.borme-cache')
// The database lives OUTSIDE Google Drive. Drive syncs mid-write and has
// already reverted in-progress files in this repo twice.
const DATA = path.join(os.homedir(), 'mercantil-data')
const SUMARIO = (ymd) => `https://www.boe.es/datosabiertos/api/borme/sumario/${ymd}`
const CONCURRENCY = 6

// ─────────────────────────────────────────────────────────────────────────────
// schema
// ─────────────────────────────────────────────────────────────────────────────
// `clave` is province + registry sheet, NOT the NIF. BORME does not publish the
// NIF, so the sheet is the only durable identity we have. Joining a bought XBRL
// deposit back to this base needs a name or sheet match.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS empresa (
  clave         TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL,
  provincia     TEXT NOT NULL,
  hoja          TEXT NOT NULL,
  forma         TEXT,
  constitucion  TEXT,
  comienzo      TEXT,
  objeto        TEXT,
  cnae          TEXT,
  seccion       TEXT,
  domicilio     TEXT,
  capital       TEXT,
  capital_eur   INTEGER,
  -- What has happened to the company, as one bit per event from hechos.mjs.
  --
  -- It is a bitmask and not a second table on purpose, and the reason is
  -- measured. As a table, "the companies that raised capital AND have the
  -- minimum capital" cost 4.315 ms, because the planner cannot guess how many
  -- companies an EXISTS over that table will keep, so it chose the wrong half
  -- of the query to drive and then had to sort the rest. As a column the test
  -- rides inside the same index as every other filter and the question is
  -- answered without leaving it. All 55 combinations of event and size band,
  -- timed through buscar() on the full base 2026-10-22: 10 of them were above
  -- one second with the table, worst 4.315 ms; with the column none are, worst
  -- 469 ms, median 20 ms. Vercel kills a Hobby function at 10 s, so this was a
  -- 504 waiting to happen, not a nicety.
  hechos        INTEGER NOT NULL DEFAULT 0,
  primer_acto   TEXT,
  ultimo_acto   TEXT,
  n_actos       INTEGER NOT NULL DEFAULT 0,
  estado        TEXT NOT NULL DEFAULT 'activa'
);

CREATE TABLE IF NOT EXISTS acto (
  id        INTEGER PRIMARY KEY,
  clave     TEXT NOT NULL,
  fecha     TEXT NOT NULL,
  borme     TEXT NOT NULL,
  etiquetas TEXT,
  texto     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dia (
  iso        TEXT PRIMARY KEY,
  documentos INTEGER NOT NULL,
  actos      INTEGER NOT NULL,
  cargado    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS acto_clave  ON acto (clave);
CREATE INDEX IF NOT EXISTS acto_fecha  ON acto (fecha);
CREATE INDEX IF NOT EXISTS emp_prov    ON empresa (provincia);
CREATE INDEX IF NOT EXISTS emp_estado  ON empresa (estado);

-- The two below are for the sort order of the page, not for the filters.
-- Without them the hosted copy answered a plain browse in 10,4 s, because
-- ORDER BY ultimo_acto had to read and sort all 741k rows; with them it is
-- 43 ms. Measured on Turso, 2026-10-21. emp_prov_ultimo covers the province
-- filter plus the sort in one index, which is the most used combination.
--
-- ⚠️ THERE IS NO emp_ultimo (ultimo_acto DESC) HERE AND THERE MUST NOT BE. It
-- existed until 2026-10-23 and it shadowed emp_fecha, which starts with the
-- same column and carries every filter column inside it. The planner preferred
-- the short one, so each candidate row had to be fetched from the 1,1 GB table
-- just to test the filter. Measured on Turso the day the filters went live:
-- the forty rows of "en concurso" took 5,4 s and its capped count 61,9 s, a
-- 504 in production; forced onto emp_fecha the same two took 1,1 s and 1,5 s,
-- and a plain browse went from 2,3 s to 0,3 s. This is the second time a one
-- column index next to a covering one has cost a day (see emp_tamano below),
-- and the rule is the same: if a wider index starts with the same column, the
-- narrow one is not a spare, it is a trap.
CREATE INDEX IF NOT EXISTS emp_prov_ultimo ON empresa (provincia, ultimo_acto DESC);
CREATE INDEX IF NOT EXISTS emp_n_actos     ON empresa (n_actos DESC);
-- A rare legal form has to be found, not scanned for. Filtering by SCP, 13
-- companies out of 741k, took 2,0 s without this index because every row was
-- read before the answer came back empty. Measured 2026-10-21.
CREATE INDEX IF NOT EXISTS emp_forma_ultimo ON empresa (forma, ultimo_acto DESC);
-- The size filter and the age filter, the two indexes whose shape was measured
-- instead of guessed. Both carry the OTHER filter columns along, and that is
-- the whole point of them.
--
-- ⚠️ DO NOT shorten either one to a single column. A capital band holds up to
-- 181.786 companies and a year holds 128.582, so neither range is narrow, and
-- with a one column index SQLite reads every one of those rows at random
-- inside a 1,1 GB file just to test the second filter. Carrying the columns
-- here means the answer never leaves the index. Measured on the full base,
-- 2026-10-22, through buscar(), rows plus capped count:
--   constituida en 2024, sector F, capital 3.001 a 60.000   9.150 ms -> 500 ms
--   sector J, capital 60.001 a 300.000                      2.496 ms -> 216 ms
--   capital de más de 3.000.000 y constituida en 2025        4.128 ms ->  94 ms
-- ⚠️ And a one column index must not even EXIST next to these: while
-- emp_capital(capital_eur) and emp_comienzo(comienzo) were still there, the
-- planner preferred them and the queries stayed at seconds.
--
-- ⚠️ The age index is on comienzo, the real date of incorporation read from
-- inside the act, not on constitucion, which is only the publication day.
-- (No backticks in here: this whole schema is one template literal, and a
-- backtick in a comment ends the string and breaks the file.)
-- That is the column the year filter asks for.
CREATE INDEX IF NOT EXISTS emp_tamano ON empresa
  (capital_eur, seccion, comienzo, hechos, provincia, forma, estado, ultimo_acto);
CREATE INDEX IF NOT EXISTS emp_anio ON empresa
  (comienzo, capital_eur, seccion, hechos, provincia, forma, estado, ultimo_acto);
CREATE INDEX IF NOT EXISTS emp_cnae    ON empresa (cnae);
CREATE INDEX IF NOT EXISTS emp_seccion ON empresa (seccion, ultimo_acto DESC);
-- The same columns again, led by the date this time, because the page always
-- asks for the forty newest and two wide filters at once leave the planner
-- nothing else to stand on: it would read every matching row and sort the lot.
-- Led by ultimo_acto it walks the base newest first and stops at the fortieth
-- hit. Measured on the full base 2026-10-22, "cambió de domicilio" with
-- "capital mínimo", 56.000 companies between them: 7.615 ms without this index
-- and 33 ms with it.
CREATE INDEX IF NOT EXISTS emp_fecha ON empresa
  (ultimo_acto DESC, capital_eur, seccion, comienzo, hechos, provincia, forma, estado);

CREATE VIRTUAL TABLE IF NOT EXISTS empresa_fts USING fts5 (
  nombre, objeto, clave UNINDEXED, tokenize = "unicode61 remove_diacritics 2"
);
`

// ─────────────────────────────────────────────────────────────────────────────
// parsing · lifted from arpa-tool/scripts/borme-probe.mjs, which measured every
// one of these rules against real bulletins from 2009 to 2026.
// ─────────────────────────────────────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decode (s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => ENTITIES[n])
}

function parseSectionA (xml) {
  const provincia = decode((xml.match(/<titulo>([\s\S]*?)<\/titulo>/) || [])[1] || '').trim()
  const fecha = (xml.match(/<fecha_publicacion>(\d{8})<\/fecha_publicacion>/) || [])[1] || ''
  const entries = []
  const re = /<p class="(articulo|parrafo)">([\s\S]*?)<\/p>/g
  let m
  let current = null
  while ((m = re.exec(xml))) {
    const body = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (m[1] === 'articulo') {
      const head = body.match(/^(\d+)\s*-\s*(.+?)\.?$/)
      current = { nombre: head ? head[2] : body, provincia, fecha, texto: '' }
      entries.push(current)
    } else if (current) {
      current.texto = current.texto ? `${current.texto} ${body}` : body
    }
  }
  return entries
}

// The field list before the hoja is NOT fixed. Anchoring to the whole line gave
// 0% coverage on 2009-2013 and 99.9% on 2026, so read the `H <letters> <digits>`
// pair out of the tail instead.
function registryKey (texto, provincia) {
  const i = texto.search(/Datos registrales\./i)
  if (i < 0) return null
  const tail = texto.slice(i, i + 200)
  const h = tail.match(/\bH\s+([A-Za-z]{1,3})\s*(\d+)/)
  if (!h) return null
  const libro = h[1].toUpperCase()
  return { hoja: `${libro}${h[2]}`, clave: `${provincia}|${libro}${h[2]}` }
}

const OBJETO_END = /\s(?:Domicilio|Capital|Datos registrales|Nombramientos|Ceses|Declaraci[oó]n\s+de\s+unipersonalidad|Socio\s+[UÚ]nico|Modificaciones|Cambio\s+de|Reelecciones|Revocaciones|Apoderado)\b/

function objetoSocial (texto) {
  const i = texto.search(/Objeto social\s*:/i)
  if (i < 0) return null
  const after = texto.slice(i).replace(/^Objeto social\s*:\s*/i, '')
  const end = after.search(OBJETO_END)
  return (end > 0 ? after.slice(0, end) : after).trim().slice(0, 600) || null
}

// A value ends where the next label starts, and the list of labels cannot be
// enumerated: Capital was running on into "Resultante Suscrito:" and "Otros
// conceptos:" and then being cut mid-word by the 80 character cap, so the page
// showed "1.500,00 Euros. Resultante Suscrito: 4.500,00 Euros. Otros
// conceptos: DECLARACIO". So the rule is positional, not a word list: a value
// ends at a full stop followed by any capitalised label and its colon.
const SIGUIENTE_ETIQUETA = /\.\s*(?=[A-ZÁÉÍÓÚÑ][^:.]{2,40}:)/

function campo (texto, etiqueta, max = 200) {
  const re = new RegExp(`${etiqueta}\\s*:\\s*`, 'i')
  const i = texto.search(re)
  if (i < 0) return null
  const after = texto.slice(i).replace(re, '')
  const ends = [after.search(OBJETO_END), after.search(SIGUIENTE_ETIQUETA)].filter((n) => n > 0)
  const end = ends.length ? Math.min(...ends) : -1
  return (end > 0 ? after.slice(0, end) : after).trim().slice(0, max) || null
}

// In an "Ampliación de capital" act, `Capital:` is the SIZE OF THE INCREASE and
// `Resultante Suscrito:` is the capital the company ends up with. Reading the
// first one and letting it overwrite the previous value put the increase in a
// field labelled Capital, so a company that went from 3.009.960 to 3.012.960
// was shown as having a capital of 3.000. The resulting figure wins when the
// act publishes one.
// A capital is a figure and a currency, so it ends where the figure ends. The
// label rule alone is not enough: "42.000,00 Euros. Ampliación del objeto
// social. La investigación, el desarrollo t" carries no colon to stop at and
// came out cut mid-word. This cannot be done inside campo(), because a
// Domicilio legitimately contains "AV. DIAGONAL" and a sentence rule would
// cut it in half.
function capital (texto) {
  const v = campo(texto, 'Resultante\\s+Suscrito', 80) || campo(texto, 'Capital(?:\\s+social)?', 80)
  if (!v) return null
  return (v.match(/^[\d.,]+\s*(?:Euros?|Ptas?\.?|Pesetas)/i) || [v])[0]
}

// A size filter needs a number, and `capital` is a sentence. Two traps, both
// real in this base: the figure is in Spanish format (44.500,00 is forty four
// thousand, not forty four) so a plain Number() gives 44; and some old acts
// still publish Pesetas, so comparing them against Euros would put a 500.000
// Ptas company (3.005 EUR) above a 100.000 EUR one. A Peseta figure returns
// null rather than a converted guess: the act does not say what the capital is
// in euros today, and a filter must not invent the number it filters on.
function capitalEur (v) {
  if (!v || !/Euros?/i.test(v)) return null
  const cifra = (v.match(/^[\d.,]+/) || [''])[0].replace(/\./g, '').replace(',', '.')
  const n = Number(cifra)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

// The date BORME prints as the act date is the PUBLICATION date, which runs a
// few weeks behind. The real incorporation date is inside the Constitucion act
// as `Comienzo de operaciones: 4.02.25`. Verified against a bought XBRL deposit
// on 2026-10-21: ORBIOAI published 03.03.2025, incorporated 04.02.2025, and the
// deposit says 04.02.2025. Two-digit years, so pivot at 50.
function comienzo (texto) {
  const m = texto.match(/Comienzo de operaciones\s*:\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/i)
  if (!m) return null
  const [, d, mo, y] = m
  const year = y.length === 4 ? Number(y) : Number(y) < 50 ? 2000 + Number(y) : 1900 + Number(y)
  if (year < 1850 || year > 2100) return null
  return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

function cnae (texto) {
  const m = texto.match(/CNAE[^0-9]{0,40}(\d{4})/i) || texto.match(/CNAE[^0-9]{0,10}(\d{2})\b/i)
  return m ? m[1] : null
}

// The act vocabulary is closed and printed as "Etiqueta. detalle." segments.
function etiquetas (texto) {
  const out = new Set()
  for (const m of texto.matchAll(/(?:^|\.\s|\.-\s{0,2})([A-ZÁÉÍÓÚÑ][^.;:]{2,58}?)[.:]/g)) {
    const label = m[1].trim()
    if (/\d/.test(label)) continue
    if (/^Datos registrales$/i.test(label)) continue
    out.add(label)
  }
  return [...out]
}

// Legal form from the denomination suffix. BORME prints it inconsistently
// (`SL.`, `S.L.`, `SOCIEDAD LIMITADA`), so normalise to a short code.
const FORMAS = [
  [/\bS\.?\s?L\.?\s?N\.?\s?E\.?$/i, 'SLNE'],
  [/\bS\.?\s?L\.?\s?L\.?$/i, 'SLL'],
  [/\bS\.?\s?L\.?\s?U\.?$/i, 'SLU'],
  [/\bS\.?\s?A\.?\s?U\.?$/i, 'SAU'],
  [/\bS\.?\s?COOP\.?.*$/i, 'SCOOP'],
  [/\bS\.?\s?A\.?\s?S\.?$/i, 'SAS'],
  [/\bA\.?\s?I\.?\s?E\.?$/i, 'AIE'],
  [/\bS\.?\s?C\.?\s?P\.?$/i, 'SCP'],
  [/\b(?:S\.?\s?L\.?|SOCIEDAD\s+(?:LIMITADA|DE\s+RESPONSABILIDAD\s+LIMITADA))$/i, 'SL'],
  [/\b(?:S\.?\s?A\.?|SOCIEDAD\s+ANONIMA)$/i, 'SA'],
]

function forma (nombre) {
  const n = nombre.replace(/\.$/, '').trim()
  for (const [re, code] of FORMAS) if (re.test(n)) return code
  return null
}

const MUERTE = /\b(?:Extinci[oó]n|Cancelaci[oó]n\s+de\s+oficio|Disoluci[oó]n)\b/i
const CONCURSO = /\bconcurs/i

// ─────────────────────────────────────────────────────────────────────────────
// fetch
// ─────────────────────────────────────────────────────────────────────────────
async function getCached (url, key) {
  const file = path.join(CACHE, key)
  // A zero byte cache entry is a MISS, not a hit. The cache sits in Google
  // Drive, and Drive empties files it is syncing: on 2026-10-22 it had gutted
  // 47 of the 16.047 entries, and the build died at day 200 of 732 on a
  // sumario that parsed as empty JSON. Refetching one file costs a request;
  // trusting it costs the whole run.
  if (existsSync(file) && statSync(file).size > 0) return readFile(file, 'utf8')
  const res = await fetch(url, {
    headers: { Accept: 'application/json, application/xml;q=0.9', 'User-Agent': 'joblanders-mercantil/1' },
  })
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { status: res.status })
  const body = await res.text()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body)
  return body
}

async function pool (items, worker) {
  const out = []
  let next = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const i = next++
      try { out[i] = await worker(items[i]) } catch (err) { out[i] = { error: err } }
    }
  }))
  return out
}

async function sectionADocs (iso) {
  const ymd = iso.replaceAll('-', '')
  let raw
  try {
    raw = await getCached(SUMARIO(ymd), path.join(ymd, 'sumario.json'))
  } catch (err) {
    if (err.status === 404) return []
    throw err
  }
  const json = JSON.parse(raw)
  if (json?.status?.code !== '200') return []
  // The API collapses a single-element list into a bare object at every level.
  const diarios = [].concat(json?.data?.sumario?.diario || [])
  const out = []
  for (const diario of diarios) {
    for (const sec of [].concat(diario.seccion || [])) {
      if (sec.codigo !== 'A') continue
      for (const item of [].concat(sec.item || [])) {
        out.push({ iso, ymd, id: item.identificador, url: item.url_xml })
      }
    }
  }
  return out
}

function* dateRange (from, to) {
  for (const d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ingest
// ─────────────────────────────────────────────────────────────────────────────
function openDb (file) {
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  return db
}

function ingestDay (db, stmts, iso, docs) {
  let actos = 0
  db.exec('BEGIN')
  try {
    for (const entries of docs) {
      for (const e of entries) {
        const rk = registryKey(e.texto, e.provincia)
        if (!rk) continue
        const fecha = `${e.fecha.slice(0, 4)}-${e.fecha.slice(4, 6)}-${e.fecha.slice(6, 8)}`
        const limpio = redact(e.texto)
        const labels = etiquetas(limpio)

        stmts.acto.run(rk.clave, fecha, e.fecha, JSON.stringify(labels), limpio)
        actos++

        const esConstitucion = labels.some((l) => /^Constituci/i.test(l))
        const estado = MUERTE.test(limpio) ? 'extinguida' : CONCURSO.test(limpio) ? 'concurso' : null
        const cap = capital(e.texto)
        const cod = cnae(e.texto)

        stmts.empresa.run(
          rk.clave, e.nombre, e.provincia, rk.hoja, forma(e.nombre),
          esConstitucion ? fecha : null, comienzo(e.texto),
          objetoSocial(e.texto), cod, seccion(cod),
          campo(e.texto, 'Domicilio'), cap, capitalEur(cap),
          mascara(labels), fecha, fecha, estado,
        )

      }
    }
    stmts.dia.run(iso, docs.length, actos, new Date().toISOString())
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return actos
}

function prepare (db) {
  return {
    acto: db.prepare('INSERT INTO acto (clave, fecha, borme, etiquetas, texto) VALUES (?,?,?,?,?)'),
    dia: db.prepare('INSERT OR REPLACE INTO dia (iso, documentos, actos, cargado) VALUES (?,?,?,?)'),
    // First write wins for the facts that are only printed once (constitucion,
    // objeto). Last write wins for the denomination, because a company that
    // changes its name should be found under the current one.
    empresa: db.prepare(`
      INSERT INTO empresa (clave, nombre, provincia, hoja, forma, constitucion, comienzo, objeto, cnae, seccion,
                           domicilio, capital, capital_eur, hechos, primer_acto, ultimo_acto, n_actos, estado)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,COALESCE(?,'activa'))
      ON CONFLICT(clave) DO UPDATE SET
        nombre       = CASE WHEN excluded.ultimo_acto >= empresa.ultimo_acto THEN excluded.nombre ELSE empresa.nombre END,
        forma        = COALESCE(empresa.forma, excluded.forma),
        constitucion = COALESCE(empresa.constitucion, excluded.constitucion),
        comienzo     = COALESCE(empresa.comienzo, excluded.comienzo),
        objeto       = COALESCE(excluded.objeto, empresa.objeto),
        cnae         = COALESCE(excluded.cnae, empresa.cnae),
        seccion      = COALESCE(excluded.seccion, empresa.seccion),
        domicilio    = COALESCE(excluded.domicilio, empresa.domicilio),
        -- capital and capital_eur must move together or the figure stops
        -- matching the text next to it. A Peseta capital parses to a null
        -- capital_eur on purpose, so this cannot be a COALESCE: it has to
        -- follow whether the new act published a capital at all.
        capital      = CASE WHEN excluded.capital IS NOT NULL THEN excluded.capital     ELSE empresa.capital     END,
        capital_eur  = CASE WHEN excluded.capital IS NOT NULL THEN excluded.capital_eur ELSE empresa.capital_eur END,
        -- Events accumulate: a company that raised capital in March and moved
        -- in July has both bits, for ever. This is the only column that is
        -- neither first write nor last write wins.
        hechos       = empresa.hechos | excluded.hechos,
        primer_acto  = MIN(empresa.primer_acto, excluded.primer_acto),
        ultimo_acto  = MAX(empresa.ultimo_acto, excluded.ultimo_acto),
        n_actos      = empresa.n_actos + 1,
        estado       = CASE WHEN excluded.estado IS NOT NULL AND excluded.estado <> 'activa'
                            THEN excluded.estado ELSE empresa.estado END
    `),
  }
}

async function run (from, to, dbFile) {
  const db = openDb(dbFile)
  const stmts = prepare(db)
  const done = new Set(db.prepare('SELECT iso FROM dia').all().map((r) => r.iso))

  const days = [...dateRange(from, to)].filter((d) => !done.has(d))
  process.stderr.write(`${days.length} days to ingest (${done.size} already done)\n`)

  let n = 0
  let actos = 0
  for (const iso of days) {
    const metas = await sectionADocs(iso)
    if (!metas.length) {
      stmts.dia.run(iso, 0, 0, new Date().toISOString())
      continue
    }
    const parsed = await pool(metas, async (d) => {
      const xml = await getCached(d.url, path.join(d.ymd, `${d.id}.xml`))
      return parseSectionA(xml)
    })
    const ok = parsed.filter(Array.isArray)
    if (ok.length < parsed.length) {
      process.stderr.write(`  ${iso}: WARNING ${parsed.length - ok.length} documents failed\n`)
    }
    actos += ingestDay(db, stmts, iso, ok)
    if (++n % 20 === 0) process.stderr.write(`  ${iso}  ${n}/${days.length}  ${actos} acts\n`)
  }

  rebuildFts(db)
  stats(db)
  db.close()
}

function rebuildFts (db) {
  process.stderr.write('rebuilding search index\n')
  db.exec('DELETE FROM empresa_fts')
  db.exec('INSERT INTO empresa_fts (nombre, objeto, clave) SELECT nombre, COALESCE(objeto,\'\'), clave FROM empresa')
  db.exec('ANALYZE')
}

function stats (db) {
  const one = (sql) => db.prepare(sql).get()
  const e = one('SELECT COUNT(*) n FROM empresa').n
  const a = one('SELECT COUNT(*) n FROM acto').n
  const d = one('SELECT COUNT(*) n FROM dia WHERE actos > 0').n
  const r = one('SELECT MIN(fecha) a, MAX(fecha) b FROM acto')
  const con = one('SELECT COUNT(*) n FROM empresa WHERE comienzo IS NOT NULL').n
  const obj = one('SELECT COUNT(*) n FROM empresa WHERE objeto IS NOT NULL').n
  const cn = one('SELECT COUNT(*) n FROM empresa WHERE cnae IS NOT NULL').n
  const ext = one("SELECT COUNT(*) n FROM empresa WHERE estado = 'extinguida'").n
  const pct = (x) => `${((x / e) * 100).toFixed(1)}%`

  console.log(`
  empresas            ${e.toLocaleString('es-ES')}
  actos inscritos     ${a.toLocaleString('es-ES')}
  dias publicados     ${d}  (${r.a} a ${r.b})

  con constitucion    ${con.toLocaleString('es-ES')}  ${pct(con)}
  con objeto social   ${obj.toLocaleString('es-ES')}  ${pct(obj)}
  con CNAE            ${cn.toLocaleString('es-ES')}  ${pct(cn)}
  extinguidas         ${ext.toLocaleString('es-ES')}  ${pct(ext)}
  con NIF             0  0.0%   <- lo que BORME no publica, y cuesta 2,98 EUR
`)

  console.log('  por provincia, top 12')
  for (const row of db.prepare('SELECT provincia, COUNT(*) n FROM empresa GROUP BY 1 ORDER BY 2 DESC LIMIT 12').all()) {
    console.log(`    ${String(row.n).padStart(8)}  ${row.provincia}`)
  }
  console.log('\n  por forma')
  for (const row of db.prepare('SELECT COALESCE(forma,\'(sin forma)\') f, COUNT(*) n FROM empresa GROUP BY 1 ORDER BY 2 DESC LIMIT 10').all()) {
    console.log(`    ${String(row.n).padStart(8)}  ${row.f}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function args () {
  const a = process.argv.slice(2)
  const get = (k, d) => { const i = a.indexOf(k); return i < 0 ? d : a[i + 1] }
  return {
    from: get('--from', '2024-10-01'),
    to: get('--to', '2026-10-02'),
    db: path.resolve(DATA, get('--db', 'empresas.db')),
    stats: a.includes('--stats'),
  }
}

const o = args()
if (o.stats) {
  const db = openDb(o.db)
  stats(db)
  db.close()
} else {
  await run(o.from, o.to, o.db)
}
