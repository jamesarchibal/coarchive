// /api/entrar · the door to the client area.
//
//   POST {email}            -> sends six digits to that address
//   POST {email, codigo}    -> answers { t } , the token the page already uses
//
// One endpoint and two steps, because they are one conversation and the email
// has to be validated the same way in both. The code logic, and the reason an
// unknown address gets the same answer as a client, are in pedidos.mjs next to
// pedirCodigo().
//
// ⚠️ The second answer carries a bearer credential, so it can never be cached
// and never be indexed, the same as /api/cuenta.

import { canjear, pedirCodigo, pedidosClient } from '../pedidos.mjs'
import { fail } from './_db.js'

let pedidos

export default async function handler (req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')

  if (req.method !== 'POST') return res.status(405).send(JSON.stringify({ error: 'usa POST' }))

  try {
    if (!pedidos) pedidos = pedidosClient()
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})

    if (body.codigo) {
      const a = await canjear(pedidos, body.email, body.codigo)
      return res.status(200).send(JSON.stringify({ t: a.token, email: a.email }))
    }

    const r = await pedirCodigo(pedidos, body.email)
    // `conocido` is deliberately NOT sent to the browser: it is the answer to
    // "is this address a client of yours", and the whole point of the generic
    // reply is not to answer that.
    return res.status(200).send(JSON.stringify({ enviado: r.enviado }))
  } catch (err) {
    if (err?.cliente) return res.status(400).send(JSON.stringify({ error: err.message }))
    fail(res, err)
  }
}
