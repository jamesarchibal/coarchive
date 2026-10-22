// mercantil · the orders.
//
// Coarchive serves BORME, which is free and open. The two fields BORME does
// NOT publish, the NIF and the cuentas anuales, are only in the Registro
// Mercantil and are paid per consultation. We never store them and we never
// buy them on spec. The rule, from James on 2026-10-22:
//
//   "solo pedir cuando un cliente nos lo pida y pague a nosotros primero"
//
// So this module is the till, not a cache. It holds what a named client asked
// for, who the document is issued to, and how far the order got. The document
// itself never comes back through here.
//
// WHY A SEPARATE DATABASE. The base is REPLACED wholesale on every rebuild:
// build.mjs writes a new file and the Turso database is swapped (`coarchive`
// became `coarchive-v2` on 2026-10-21). An order living in the base would be
// destroyed by the next load of the bulletin. The company name, provincia and
// hoja are also copied into the order row for the same reason: the order has
// to stay readable after the base it was taken from is gone.
//
// WHY THE REPRESENTED PARTY IS MANDATORY. §4.2 of the sede terms allows
// ordering "por cuenta ajena", which is exactly our model, but it requires the
// represented party's "número de identificación, nombre y apellidos o razón
// social" in the request. Without those three the order cannot legally be
// placed at all, so an order that lacks them is rejected here, not later.
//
// CLI, which is the whole back office:
//   node pedidos.mjs listar [estado]
//   node pedidos.mjs ver <id>
//   node pedidos.mjs tramitar <id>        -> what to order, or orders it
//   node pedidos.mjs estado <id> <estado> [nota]

import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

// Same reason as publish.mjs: outside Google Drive, because Drive syncs files
// while they are still being written.
export const PEDIDOS_FILE = path.join(os.homedir(), 'mercantil-data', 'pedidos.db')

const IVA = 0.21

// The arancel is what the registry charges us, measured on a real purchase on
// 2026-10-21 (ORBIOAI SL, solicitud F05ZF09T8, 10,88 € with IVA). The price to
// the client is COMPUTED from it, never typed, so the two cannot drift: 899
// cents plus IVA is 1088, which is the exact amount that was charged.
//
// precio === arancel + IVA means we charge the cost and keep nothing. That is
// a decision James has not taken yet, so it is one number in one place here
// rather than a margin invented across the page.
const PRODUCTOS = {
  identificacion: { nombre: 'Bloque de identificación (NIF y CNAE)', arancel_cent: 298 },
  cuentas: { nombre: 'Cuentas anuales del último ejercicio depositado', arancel_cent: 899 },
  // Anything else the register sells. We have not measured its arancel, and a
  // price we have not measured is not a price we quote, so this one is priced
  // by hand before it is charged.
  otro: { nombre: 'Otro documento del Registro Mercantil', arancel_cent: null },
}

export const CATALOGO = Object.entries(PRODUCTOS).map(([id, p]) => ({
  id,
  nombre: p.nombre,
  arancel_cent: p.arancel_cent,
  precio_cent: p.arancel_cent === null ? null : Math.round(p.arancel_cent * (1 + IVA)),
}))

export const ESTADOS = ['nuevo', 'pagado', 'solicitado', 'entregado', 'anulado']

export const euros = (cent) =>
  cent === null ? 'a presupuestar' : (cent / 100).toLocaleString('es-ES', { minimumFractionDigits: 2 }) + ' €'

export function pedidosClient () {
  const url = process.env.PEDIDOS_DATABASE_URL
  if (url) return createClient({ url, authToken: process.env.PEDIDOS_AUTH_TOKEN })
  // On Vercel the filesystem is ephemeral, so falling back to a local file
  // would accept an order, answer 200 and then lose it when the instance dies.
  // Losing a paid order silently is worse than refusing it.
  if (process.env.VERCEL) throw new Error('PEDIDOS_DATABASE_URL is not set')
  return createClient({ url: `file:${PEDIDOS_FILE}` })
}

let listo
export async function migrar (db) {
  if (listo) return
  await db.batch([
    `CREATE TABLE IF NOT EXISTS pedido (
       id TEXT PRIMARY KEY,
       creado TEXT NOT NULL,
       clave TEXT NOT NULL,
       empresa TEXT NOT NULL,
       provincia TEXT NOT NULL,
       hoja TEXT NOT NULL,
       productos TEXT NOT NULL,
       precio_cent INTEGER,
       arancel_cent INTEGER,
       rep_nombre TEXT NOT NULL,
       rep_nif TEXT NOT NULL,
       rep_email TEXT NOT NULL,
       motivo TEXT,
       estado TEXT NOT NULL,
       nota TEXT
     )`,
    'CREATE INDEX IF NOT EXISTS pedido_estado ON pedido(estado, creado)',
  ], 'write')
  listo = true
}

const limpio = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

// Something the person filling the form can fix, as opposed to something
// broken on our side. The flag is what lets api/pedir.js answer 400 and show
// the sentence instead of hiding it behind "error del servidor".
const mal = (m) => Object.assign(new Error(m), { cliente: true })

// A Spanish NIF is 8 digits plus a letter, or a letter plus 7 digits plus a
// letter or digit. The check digit is NOT verified: a typo there is caught by
// the registrar, and rejecting a valid foreign identifier would block a real
// sale. The shape is checked so an empty or obviously wrong field cannot pass.
const NIF = /^[0-9A-Z]{8,10}$/

export async function crear (pedidosDb, baseDb, entrada) {
  const productos = [...new Set(
    (Array.isArray(entrada.productos) ? entrada.productos : []).map(String),
  )].filter((p) => p in PRODUCTOS)
  if (!productos.length) throw mal('No has marcado ningún documento.')

  const rep_nombre = limpio(entrada.rep_nombre, 160)
  const rep_nif = limpio(entrada.rep_nif, 12).toUpperCase().replace(/[^0-9A-Z]/g, '')
  const rep_email = limpio(entrada.rep_email, 160)
  if (!rep_nombre) throw mal('Falta la razón social o el nombre de quien lo pide.')
  if (!NIF.test(rep_nif)) throw mal('El NIF no tiene una forma válida.')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rep_email)) throw mal('El correo no es válido.')

  // The company is read from the base, never taken from the request. The page
  // sends a clave; the name, provincia and hoja that end up on the order and
  // on the registry request are the ones the base holds for that clave.
  const e = (await baseDb.execute({
    sql: 'SELECT clave, nombre, provincia, hoja FROM empresa WHERE clave = ?',
    args: [limpio(entrada.clave, 64)],
  })).rows[0]
  if (!e) throw mal('Esa empresa no está en la base.')

  // Priced here and only here. A price that arrives from the browser is a
  // price the buyer chose.
  const items = productos.map((p) => CATALOGO.find((c) => c.id === p))
  const falta = items.some((i) => i.precio_cent === null)
  const precio_cent = falta ? null : items.reduce((n, i) => n + i.precio_cent, 0)
  const arancel_cent = falta ? null : items.reduce((n, i) => n + i.arancel_cent, 0)

  const p = {
    id: randomUUID().split('-')[0].toUpperCase(),
    creado: new Date().toISOString(),
    clave: e.clave,
    empresa: e.nombre,
    provincia: e.provincia,
    hoja: e.hoja,
    productos: JSON.stringify(productos),
    precio_cent,
    arancel_cent,
    rep_nombre,
    rep_nif,
    rep_email,
    motivo: limpio(entrada.motivo, 400) || null,
    estado: 'nuevo',
    nota: null,
  }

  await migrar(pedidosDb)
  const cols = Object.keys(p)
  await pedidosDb.execute({
    sql: `INSERT INTO pedido (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    args: cols.map((k) => p[k]),
  })
  return { ...p, productos, presupuestar: falta }
}

export async function listar (db, estado) {
  await migrar(db)
  const r = estado
    ? await db.execute({ sql: 'SELECT * FROM pedido WHERE estado = ? ORDER BY creado DESC', args: [estado] })
    : await db.execute('SELECT * FROM pedido ORDER BY creado DESC')
  return r.rows.map((x) => ({ ...x, productos: JSON.parse(x.productos) }))
}

export async function ver (db, id) {
  await migrar(db)
  const x = (await db.execute({ sql: 'SELECT * FROM pedido WHERE id = ?', args: [String(id || '')] })).rows[0]
  return x ? { ...x, productos: JSON.parse(x.productos) } : null
}

export async function cambiarEstado (db, id, estado, nota) {
  if (!ESTADOS.includes(estado)) throw new Error(`estado desconocido: ${estado}. Son ${ESTADOS.join(', ')}`)
  await migrar(db)
  const r = await db.execute({
    sql: 'UPDATE pedido SET estado = ?, nota = COALESCE(?, nota) WHERE id = ?',
    args: [estado, nota || null, String(id || '')],
  })
  if (!r.rowsAffected) throw new Error(`no existe el pedido ${id}`)
  return ver(db, id)
}

// ---------------------------------------------------------------------------
// Going to get the document.
//
// Two drivers behind one call, because WHICH door we use is a licensing fact
// and not an engineering one:
//
//   manual  §4.5 of the sede terms bans "software, script, bot, robot,
//           scraper, crawler o cualquier otro sistema automatizado", with
//           cancellation of the account as the remedy. A human placing the
//           order is allowed. So this driver requests nothing: it prints the
//           brief for the human and returns.
//   api     The CORPME API is the only legal way to request automatically.
//           They answered on 2026-10-22 that it exists, that por cuenta ajena
//           is a field of their input and that the price is the arancel with
//           no minimum, but they prioritise subscribers with "antigüedad
//           suficiente y un historial relevante de solicitudes". Ours is one
//           day old with one purchase, so the driver is written as a wall
//           rather than as a guess at their payload: every manual order below
//           is what buys the history that opens it.
//
// The switch is an env var so turning the API on changes nothing else.
export const MOTOR = process.env.COARCHIVE_REGISTRO || 'manual'

export async function tramitar (db, id) {
  const p = await ver(db, id)
  if (!p) throw new Error(`no existe el pedido ${id}`)
  if (p.estado === 'anulado') throw new Error(`el pedido ${id} está anulado`)
  if (p.precio_cent === null) throw new Error(`el pedido ${id} lleva "otro documento" y no tiene precio todavía`)
  if (p.estado === 'nuevo') throw new Error(`el pedido ${id} no está pagado. El cliente paga primero.`)

  if (MOTOR === 'api') {
    // Deliberately not implemented. Writing a speculative request against an
    // API we have never seen a response from would look like working code and
    // would fail on the first real order.
    throw new Error('COARCHIVE_REGISTRO=api, pero el expediente del CORPME no está abierto todavía.')
  }

  return {
    via: 'manual',
    pedido: p,
    pasos: [
      'Entrar en sede.registradores.org con el abonado de Joblanders Talent SL.',
      `Buscar ${p.empresa} por provincia ${p.provincia} y hoja ${p.hoja}.`,
      ...p.productos.map((x) => `Pedir: ${CATALOGO.find((c) => c.id === x).nombre}.`),
      // §4.2 again: this is the part that cannot be skipped or guessed.
      `Marcar que se pide por cuenta ajena y declarar al representado: ${p.rep_nombre}, NIF ${p.rep_nif}.`,
      `Cuando llegue, enviar el documento a ${p.rep_email} como adjunto, nunca como enlace.`,
      `Cerrar con: node pedidos.mjs estado ${p.id} entregado`,
    ],
  }
}

// ---------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, a, b, ...resto] = process.argv.slice(2)
  const db = pedidosClient()
  const out = (s) => process.stdout.write(s + '\n')

  if (cmd === 'listar') {
    const rows = await listar(db, a)
    if (!rows.length) out('sin pedidos')
    for (const p of rows) {
      out(`${p.id}  ${p.creado.slice(0, 16).replace('T', ' ')}  ${p.estado.padEnd(10)} ${euros(p.precio_cent).padStart(12)}  ${p.empresa}`)
      out(`        para ${p.rep_nombre} (${p.rep_nif}) · ${p.rep_email} · ${p.productos.join(', ')}`)
    }
  } else if (cmd === 'ver') {
    out(JSON.stringify(await ver(db, a), null, 2))
  } else if (cmd === 'estado') {
    const p = await cambiarEstado(db, a, b, resto.join(' '))
    out(`${p.id} -> ${p.estado}`)
  } else if (cmd === 'tramitar') {
    const t = await tramitar(db, a)
    out(`pedido ${t.pedido.id} · ${euros(t.pedido.precio_cent)} · vía ${t.via}`)
    t.pasos.forEach((s, i) => out(`  ${i + 1}. ${s}`))
  } else {
    out('node pedidos.mjs listar [estado] | ver <id> | tramitar <id> | estado <id> <estado> [nota]')
    out(`estados: ${ESTADOS.join(', ')}`)
    out(CATALOGO.map((c) => `  ${c.id}: ${euros(c.precio_cent)}  ${c.nombre}`).join('\n'))
  }
}
