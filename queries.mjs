// mercantil · the read-only queries, shared by the local server and by the
// Vercel functions.
//
// Everything talks to libSQL, not to node:sqlite, so there is ONE code path.
// Local development opens the file directly (`file:/...`), production opens
// the Turso replica over HTTP. Same SQL either way.

const PAGE = 40

// FTS5 treats most punctuation as syntax. Quoting every token turns a user
// phrase into a safe prefix search and stops a stray `"` from throwing.
export function ftsQuery (q) {
  const tokens = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 8)
  if (!tokens.length) return null
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' ')
}

export async function buscar (db, { q, provincia, forma, estado, page }) {
  const where = []
  const args = []
  let from = 'empresa e'

  if (q) {
    const fq = ftsQuery(q)
    if (fq) {
      from = 'empresa_fts f JOIN empresa e ON e.clave = f.clave'
      where.push('empresa_fts MATCH ?')
      args.push(fq)
    }
  }
  if (provincia) { where.push('e.provincia = ?'); args.push(provincia) }
  if (forma) { where.push('e.forma = ?'); args.push(forma) }
  if (estado) { where.push('e.estado = ?'); args.push(estado) }

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
                 e.objeto, e.cnae, e.ultimo_acto, e.n_actos, e.estado,
                 (SELECT a.etiquetas FROM acto a WHERE a.clave = e.clave
                   ORDER BY a.fecha DESC, a.id DESC LIMIT 1) AS ultimas
          FROM ${from} ${w}
          ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}`,
    args,
  })).rows.map((r) => ({ ...r, ultimas: JSON.parse(r.ultimas || '[]') }))

  // COUNT over a 741k-row FTS match is slow and nobody reads past page 10, so
  // the total is capped and reported as "more than".
  const total = Number((await db.execute({
    sql: `SELECT COUNT(*) n FROM (SELECT e.clave FROM ${from} ${w} LIMIT 5001)`,
    args,
  })).rows[0].n)

  return { rows, total, capped: total > 5000, page: p }
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
  return {
    empresas: Number(a.n),
    actos: Number(b.n),
    provincias: Number(c.n),
    desde: d.d1,
    hasta: d.d2,
    listaProvincias: provs.map((r) => ({ p: r.p, n: Number(r.n) })),
    listaFormas: formas.map((r) => ({ f: r.f, n: Number(r.n) })),
  }
}
