// POST /api/pedir · the only endpoint that writes.
//
// It takes an order for a paid registry document and nothing else: no document
// is fetched here and no paid field is ever stored. See pedidos.mjs for why
// the orders live in their own database and why the represented party is
// mandatory.

import { crear, pedidosClient } from '../pedidos.mjs'
import { db, fail } from './_db.js'

let pedidos

export default async function handler (req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  // An order is never cached, at any layer.
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    return res.status(405).send(JSON.stringify({ error: 'usa POST' }))
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    if (!pedidos) pedidos = pedidosClient()
    const p = await crear(pedidos, db(), body)
    res.status(201).send(JSON.stringify({
      id: p.id,
      empresa: p.empresa,
      precio_cent: p.precio_cent,
      presupuestar: p.presupuestar,
    }))
  } catch (err) {
    // crear() marks the errors the person can fix. Those go back as a 400 and
    // are shown as they are; anything else is ours and is a 500, because
    // showing "el NIF no tiene una forma válida" as a server error, or a stack
    // trace as advice, are both lies.
    if (err?.cliente) return res.status(400).send(JSON.stringify({ error: err.message }))
    fail(res, err)
  }
}
