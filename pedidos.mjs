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
//   node pedidos.mjs acceso <correo>      -> the client's link to /?t=...
//   node pedidos.mjs vigilancias          -> who to warn, and about what
//   node pedidos.mjs avisado <correo> <clave> <fecha>

import { createClient } from '@libsql/client'
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

// The free base, for the two things that have to read it: the name of a company
// being put under watch, and the acts that a watch has to report. Imported from
// queries.mjs and never from publish.mjs, which imports this file.
import { localClient } from './queries.mjs'
import { enviar } from './correo.mjs'

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

// How long a delivered document stays available in the client area. The number
// is copied from the sede rather than invented: the publicidad it hands over is
// "accesible 30 días" and then it is gone, which is why the client is sent the
// file and never a link.
//
// ⚠️ THIS CLOCK IS WHAT KEEPS THE CLIENT AREA A BUZON AND NOT AN ARCHIVE, and
// the difference is the whole licence. §4.4 of the sede terms forbids
// incorporating the contents of the document into "bases o ficheros
// informatizados que puedan ser susceptibles de consulta individualizada", and
// §6 counts even our own employees as third parties for that purpose. So what
// survives these 30 days is the receipt (date, reference, amount, who it was
// issued to), never the document and never a field out of it.
//
// What may be kept forever, and is a different thing, is the AGGREGATE: a
// histogram by CNAE, provincia, tramo and ejercicio is an aggregate by
// construction, so it is not susceptible of individual consultation. The
// Colegio wrote that exception itself in its convenio with the Banco de España
// (BOE-A-2024-24833): "se excluye aquellos supuestos en los que la publicación
// (...) se haga de forma agregada y con finalidad estadística". That clause is
// in their contract with the BdE and not in ours, so it is an argument and not
// a right, but it is where the reports product lives.
export const DIAS_ENTREGA = 30

// A client cannot watch an unlimited number of companies. The endpoint that
// adds one is public and holding a token is the only requirement, so this is a
// boundary and not a product limit: far above what a real client asks for, far
// below what is worth abusing.
const TOPE_VIGILANCIA = 200

const ahora = () => new Date().toISOString()
const mas = (dias) => new Date(Date.now() + dias * 86400000).toISOString()

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

    // Who can open the client area. One row per emailed link, and that is the
    // whole authentication: no accounts and no passwords, because a password is
    // one more thing to lose for a shop that sells by hand, and because the
    // email is already the field the order had to carry anyway.
    `CREATE TABLE IF NOT EXISTS acceso (
       token TEXT PRIMARY KEY,
       email TEXT NOT NULL,
       creado TEXT NOT NULL,
       expira TEXT NOT NULL,
       visto TEXT
     )`,
    'CREATE INDEX IF NOT EXISTS acceso_email ON acceso(email)',

    // What a client asked us to watch. This one is ours to keep without any
    // argument: it holds a BORME clave and an email, and BORME is open data, so
    // there is no registry publicity in this table at all. It is also the piece
    // that turns a one-off purchase into a reason to come back.
    `CREATE TABLE IF NOT EXISTS vigilancia (
       id TEXT PRIMARY KEY,
       email TEXT NOT NULL,
       clave TEXT NOT NULL,
       empresa TEXT NOT NULL,
       creado TEXT NOT NULL,
       avisado TEXT
     )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS vigilancia_una ON vigilancia(email, clave)',

    // The six digits that let a client in from the page instead of from a link
    // we sent by hand. One row per email, replaced on every request, so asking
    // again cancels the previous code. The code is stored HASHED: this table
    // sits in the same database as the orders, and a code in the clear would be
    // a password in the clear.
    `CREATE TABLE IF NOT EXISTS codigo (
       email TEXT PRIMARY KEY,
       hash TEXT NOT NULL,
       creado TEXT NOT NULL,
       expira TEXT NOT NULL,
       intentos INTEGER NOT NULL DEFAULT 0
     )`,
  ], 'write')

  // Added on 2026-10-23, when the table was already live in production, so they
  // cannot go into the CREATE above: that one is IF NOT EXISTS and is skipped.
  // SQLite has no ALTER ... IF NOT EXISTS, so the second run throws "duplicate
  // column name" and that throw IS the success case.
  for (const col of ['entregado TEXT', 'caduca TEXT']) {
    try {
      await db.execute(`ALTER TABLE pedido ADD COLUMN ${col}`)
    } catch (err) {
      if (!/duplicate column/i.test(String(err?.message || err))) throw err
    }
  }
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

  // The purpose is mandatory, and the reason is a sentence the CORPME wrote to
  // us on 2026-10-23: "No es necesario acreditar al representado. En cualquier
  // caso, el receptor de la información deberá cumplir la normativa de
  // protección de datos y las condiciones de utilización de la publicidad
  // registral." They ask for no proof, so the only record that a request had a
  // legitimate interest behind it is the one we keep. An empty field would
  // leave us declaring an interest we cannot show, which is worse than a lost
  // sale. 12 characters is not a quality bar, it only stops a single keystroke.
  const motivo = limpio(entrada.motivo, 400)
  if (motivo.length < 12) throw mal('Dinos para qué lo necesitas. El registro exige un interés legítimo y es el dato que tenemos que poder justificar.')

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
    motivo,
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
  // Marking an order delivered starts the clock. The two dates are written
  // here, by the one command a human runs when the document leaves, so the
  // expiry cannot be forgotten: there is no path to "entregado" that does not
  // set a day on which the document stops being available.
  const entregado = estado === 'entregado' ? ahora() : null
  const r = await db.execute({
    sql: `UPDATE pedido SET estado = ?, nota = COALESCE(?, nota),
                 entregado = COALESCE(?, entregado), caduca = COALESCE(?, caduca)
          WHERE id = ?`,
    args: [estado, nota || null, entregado, entregado ? mas(DIAS_ENTREGA) : null, String(id || '')],
  })
  if (!r.rowsAffected) throw new Error(`no existe el pedido ${id}`)
  return ver(db, id)
}

// ---------------------------------------------------------------------------
// The client area.
//
// What it holds is decided by the licence and not by what would be nice:
//
//   receipts     forever. What you ordered, of which company, when, how much,
//                and who it was issued to. Ours, and the only proof the client
//                has that the purchase happened.
//   documents    30 days, then the row says it expired. See DIAS_ENTREGA.
//   watch lists  forever. BORME only, so there is nothing to argue about.
//   reports      ours, derived, no arancel in them. Not built yet: James
//                deferred the product on 2026-10-23 ("informe luego lo
//                hablamos en detalle"), so there is no half-invented table for
//                it here.
//
// Access is an emailed link and nothing else. The token is random, long, and
// scoped to one email address, which is the address the order already had to
// carry under §4.2.

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const TOKEN = /^[0-9a-f]{48}$/
const correo = (s) => limpio(s, 160).toLowerCase()

// ⚠️ A SESSION DOES NOT EXPIRE ON ITS OWN. James, 2026-10-23: "no quiero que
// caduquen las sesiones sino que puedas entrar y salir".
//
// The 90 day clock made sense while the only door was a link mailed by hand and
// there was no way to end a session on purpose. Both halves changed the same
// day: you get in with a code mailed to you (pedirCodigo) and you get out with
// Salir, which DELETES the row and not only the copy in the browser. A clock
// that throws a client out while they are using the thing is not security, it
// is an interruption; the button is the real control.
//
// "Never" is a date and not a NULL because `expira` is declared NOT NULL and the
// table is already live in production, where SQLite cannot drop that constraint
// without rebuilding the table. Every check is a string comparison against
// ahora(), so a date past any plausible life of this project behaves exactly
// like "no expiry" and needs no change anywhere else.
const SIN_CADUCIDAD = '9999-12-31T23:59:59.999Z'

// Rows minted before today keep their real date and still expire. That is
// correct and not an oversight: they were handed out under the old promise, and
// they are the ones nobody can revoke from the page.
export async function crearAcceso (db, email) {
  const e = correo(email)
  if (!EMAIL.test(e)) throw mal('El correo no es válido.')
  await migrar(db)
  const a = { token: randomBytes(24).toString('hex'), email: e, creado: ahora(), expira: SIN_CADUCIDAD }
  await db.execute({
    sql: 'INSERT INTO acceso (token, email, creado, expira, visto) VALUES (?, ?, ?, ?, NULL)',
    args: [a.token, a.email, a.creado, a.expira],
  })
  return a
}

// Leaving, really. Deleting the row is the whole point: a session that never
// expires has to be endable, or the token in a browser we walked away from is
// good forever. Unknown or already dead tokens are not an error, because the
// client pressing Salir twice has done nothing wrong.
export async function salir (db, token) {
  const t = limpio(token, 64).toLowerCase()
  if (!TOKEN.test(t)) return false
  await migrar(db)
  const r = await db.execute({ sql: 'DELETE FROM acceso WHERE token = ?', args: [t] })
  return r.rowsAffected > 0
}

// ---------------------------------------------------------------------------
// Entering by code, which is what makes it an account and not a link.
//
// James, 2026-10-23: "i should have an account linked to my name inside
// coarchive". The emailed link worked but it was not an account: it could not
// be reached from the page, so if the mail was lost the client was locked out.
//
// So: type your email, get six digits, type them, and you are in. There is
// still no password, because a password is a thing to lose and to store, and
// the email is already the field §4.2 forces every order to carry. The code
// only converts into the same 48-hex token the page already understood, so
// nothing downstream changed.
//
// ⚠️ ONLY AN EMAIL WE ALREADY KNOW GETS A CODE. An email with no order and no
// previous access is not a client, and minting access for it would hand a
// stranger a logged-in page. The page says this out loud ("si ese correo tiene
// algún pedido"), so the answer being the same either way is not a lie: it is
// the condition stated in advance, and it is what stops this form from being a
// way to ask who our clients are.

const VIDA_CODIGO = 15 * 60 * 1000
const TOPE_INTENTOS = 5

// Salted with the email, so two clients who draw the same six digits do not
// store the same hash. Not a password hash and does not need to be: six digits
// that live 15 minutes and die after 5 wrong tries cannot be ground down. What
// the hash is for is that this table sits beside the orders, and a code in the
// clear there would be a live credential at rest.
const picar = (email, codigo) => createHash('sha256').update(`${email}:${codigo}`).digest('hex')

const igual = (a, b) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export async function pedirCodigo (db, email) {
  const e = correo(email)
  if (!EMAIL.test(e)) throw mal('El correo no es válido.')
  await migrar(db)

  const conocido = (await db.execute({
    sql: `SELECT 1 FROM pedido WHERE lower(rep_email) = ?
          UNION ALL SELECT 1 FROM acceso WHERE email = ? LIMIT 1`,
    args: [e, e],
  })).rows.length > 0
  if (!conocido) return { enviado: true, email: e, conocido: false }

  // randomInt is the cryptographic generator. Math.random() would be guessable
  // from a handful of observed codes, and this is the only door.
  const codigo = String(randomInt(0, 1000000)).padStart(6, '0')
  await db.execute({
    sql: `INSERT INTO codigo (email, hash, creado, expira, intentos) VALUES (?, ?, ?, ?, 0)
          ON CONFLICT(email) DO UPDATE SET hash = excluded.hash,
            creado = excluded.creado, expira = excluded.expira, intentos = 0`,
    args: [e, picar(e, codigo), ahora(), new Date(Date.now() + VIDA_CODIGO).toISOString()],
  })

  await enviar({
    para: e,
    asunto: `Tu código de Coarchive: ${codigo}`,
    texto: [
      `${codigo}`,
      '',
      'Escribe ese código en Coarchive para entrar en tu cuenta.',
      'Vale 15 minutos y solo una vez.',
      '',
      'Si no has pedido entrar, ignora este correo: sin el código no se abre nada.',
    ].join('\n'),
  })
  return { enviado: true, email: e, conocido: true }
}

export async function canjear (db, email, codigo) {
  const e = correo(email)
  const c = limpio(codigo, 8).replace(/\D/g, '')
  if (!EMAIL.test(e) || c.length !== 6) throw mal('Escribe tu correo y los seis dígitos del código.')
  await migrar(db)

  const row = (await db.execute({
    sql: 'SELECT hash, expira, intentos FROM codigo WHERE email = ?',
    args: [e],
  })).rows[0]
  // Expired, already spent, or never asked for: all the same sentence, because
  // telling them apart tells a stranger which of the three it was.
  if (!row || row.expira <= ahora() || row.intentos >= TOPE_INTENTOS) {
    throw mal('Ese código ya no vale. Pide uno nuevo.')
  }

  if (!igual(row.hash, picar(e, c))) {
    await db.execute({ sql: 'UPDATE codigo SET intentos = intentos + 1 WHERE email = ?', args: [e] })
    throw mal('El código no es correcto.')
  }

  // Spent the moment it works, so the same six digits cannot be replayed from
  // the mail by whoever reads the inbox next.
  await db.execute({ sql: 'DELETE FROM codigo WHERE email = ?', args: [e] })
  return crearAcceso(db, e)
}

// The email behind a token, or null. ISO strings compare as dates when they
// are all UTC with the same precision, which is what ahora() guarantees, so
// expiry is a string comparison and not a parse.
async function deToken (db, token) {
  const t = limpio(token, 64).toLowerCase()
  if (!TOKEN.test(t)) return null
  await migrar(db)
  const a = (await db.execute({ sql: 'SELECT email, expira FROM acceso WHERE token = ?', args: [t] })).rows[0]
  if (!a || a.expira <= ahora()) return null
  return { token: t, email: a.email }
}

async function listaVigilancia (db, email) {
  const r = await db.execute({
    sql: 'SELECT clave, empresa, creado FROM vigilancia WHERE email = ? ORDER BY empresa',
    args: [email],
  })
  return r.rows.map((v) => ({ ...v }))
}

export async function cuenta (db, token) {
  const a = await deToken(db, token)
  if (!a) return null
  await db.execute({ sql: 'UPDATE acceso SET visto = ? WHERE token = ?', args: [ahora(), a.token] })

  const rows = (await db.execute({
    sql: 'SELECT * FROM pedido WHERE lower(rep_email) = ? ORDER BY creado DESC',
    args: [a.email],
  })).rows

  const hoy = ahora()
  return {
    email: a.email,
    // The name is the one on the most recent order, not a profile field. There
    // is no profile: everything shown here was declared when buying.
    nombre: rows[0]?.rep_nombre || null,
    dias_entrega: DIAS_ENTREGA,
    pedidos: rows.map((p) => ({
      id: p.id,
      creado: p.creado,
      empresa: p.empresa,
      provincia: p.provincia,
      hoja: p.hoja,
      productos: JSON.parse(p.productos),
      precio_cent: p.precio_cent,
      estado: p.estado,
      motivo: p.motivo,
      rep_nombre: p.rep_nombre,
      rep_nif: p.rep_nif,
      entregado: p.entregado,
      caduca: p.caduca,
      // Computed here and not in the page, because the page would be comparing
      // the visitor's clock against our dates.
      disponible: Boolean(p.caduca && p.caduca > hoy),
    })),
    vigilancias: await listaVigilancia(db, a.email),
  }
}

export async function vigilar (db, baseDb, token, clave) {
  const a = await deToken(db, token)
  if (!a) throw mal('Ese enlace ya no vale. Pídenos uno nuevo.')

  // The company name comes from the base, never from the request. Same rule as
  // crear(): a name that arrives from a browser is a name the browser chose.
  const e = (await baseDb.execute({
    sql: 'SELECT clave, nombre FROM empresa WHERE clave = ?',
    args: [limpio(clave, 64)],
  })).rows[0]
  if (!e) throw mal('Esa empresa no está en la base.')

  const n = (await db.execute({ sql: 'SELECT count(*) n FROM vigilancia WHERE email = ?', args: [a.email] })).rows[0].n
  if (n >= TOPE_VIGILANCIA) throw mal(`No puedes vigilar más de ${TOPE_VIGILANCIA} empresas.`)

  await db.execute({
    // Asking twice for the same company is not an error, it is the same wish.
    sql: `INSERT INTO vigilancia (id, email, clave, empresa, creado, avisado)
          VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT (email, clave) DO NOTHING`,
    args: [randomUUID().split('-')[0].toUpperCase(), a.email, e.clave, e.nombre, ahora()],
  })
  return listaVigilancia(db, a.email)
}

export async function desvigilar (db, token, clave) {
  const a = await deToken(db, token)
  if (!a) throw mal('Ese enlace ya no vale. Pídenos uno nuevo.')
  await db.execute({
    sql: 'DELETE FROM vigilancia WHERE email = ? AND clave = ?',
    args: [a.email, limpio(clave, 64)],
  })
  return listaVigilancia(db, a.email)
}

// What to tell each client that we have not told them yet.
//
// This is run BY HAND after a load of the bulletin, for the same reason the
// order notice leaves from the browser: there is no mailer on this project. It
// prints who to write to and what to say, and `avisado` is only stamped once
// the mail has actually gone out, so a crash in the middle cannot swallow a
// notice. The watch list is only worth having if this gets run.
export async function pendientes (db, baseDb) {
  await migrar(db)
  const vs = (await db.execute('SELECT * FROM vigilancia ORDER BY email, empresa')).rows
  const out = []
  for (const v of vs) {
    const desde = v.avisado || v.creado.slice(0, 10)
    const actos = (await baseDb.execute({
      sql: 'SELECT fecha, etiquetas, texto FROM acto WHERE clave = ? AND fecha > ? ORDER BY fecha',
      args: [v.clave, desde],
    })).rows
    if (actos.length) out.push({ ...v, desde, actos: actos.map((a) => ({ ...a })) })
  }
  return out
}

export async function marcarAvisado (db, email, clave, hasta) {
  await migrar(db)
  const r = await db.execute({
    sql: 'UPDATE vigilancia SET avisado = ? WHERE email = ? AND clave = ?',
    args: [String(hasta), correo(email), limpio(clave, 64)],
  })
  if (!r.rowsAffected) throw new Error(`no existe la vigilancia de ${email} sobre ${clave}`)
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
      `Darle su enlace de cuenta: node pedidos.mjs acceso ${p.rep_email}`,
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
  } else if (cmd === 'acceso') {
    const x = await crearAcceso(db, a)
    // The host is a variable because the page lives at two addresses: the
    // Vercel one and joblanders.ai/coarchive, which is the one a client sees.
    const base = process.env.COARCHIVE_URL || 'https://www.joblanders.ai/coarchive'
    out(`${base}?t=${x.token}`)
    out(`para ${x.email} · no caduca, se cierra con Salir de la cuenta`)
  } else if (cmd === 'vigilancias') {
    const ps = await pendientes(db, localClient())
    if (!ps.length) out('nada que avisar')
    for (const v of ps) {
      out(`${v.email}  ${v.empresa}  (desde ${v.desde})`)
      for (const x of v.actos) out(`     ${x.fecha}  ${x.texto.slice(0, 110)}`)
      // The clave is quoted because it holds a space and a pipe ("A CORUÑA|SC31225"),
      // so an unquoted line pasted into a shell would try to pipe into SC31225.
      out(`     cerrar: node pedidos.mjs avisado ${v.email} '${v.clave}' ${v.actos.at(-1).fecha}`)
    }
  } else if (cmd === 'avisado') {
    await marcarAvisado(db, a, b, resto[0])
    out(`${a} · ${b} avisado hasta ${resto[0]}`)
  } else {
    out('node pedidos.mjs listar [estado] | ver <id> | tramitar <id> | estado <id> <estado> [nota]')
    out('                 acceso <correo> | vigilancias | avisado <correo> <clave> <fecha>')
    out(`estados: ${ESTADOS.join(', ')}`)
    out(CATALOGO.map((c) => `  ${c.id}: ${euros(c.precio_cent)}  ${c.nombre}`).join('\n'))
  }
}
