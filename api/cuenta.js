// /api/cuenta · the client area, behind a token and nothing else.
//
//   GET  ?t=<token>                  -> receipts, documents, watch list
//   POST {t, clave}                  -> watch that company
//   POST {t, clave, quitar: true}    -> stop watching it
//   POST {t, salir: true}            -> end the session, deleting the token
//
// Two methods in one function on purpose: it is one surface with one way in,
// and splitting it would mean validating the token in two places.
//
// WHAT IS NOT HERE, and it is the important part: no registry document and no
// field out of one. See DIAS_ENTREGA in pedidos.mjs for the clause that decides
// that. This endpoint answers with receipts and with a BORME watch list.

import { cuenta, desvigilar, pedidosClient, salir, vigilar } from '../pedidos.mjs'
import { db, fail } from './_db.js'

let pedidos

export default async function handler (req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  // ⚠️ The token is in the query string, so this answer must never be cached by
  // the edge or by a proxy, and must never be indexed. The page also strips the
  // token out of the address bar as soon as it has read it, so it does not leak
  // through the Referer header or over someone's shoulder.
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')

  try {
    if (!pedidos) pedidos = pedidosClient()

    if (req.method === 'GET') {
      const c = await cuenta(pedidos, new URL(req.url, 'http://x').searchParams.get('t') || '')
      // A dead or unknown token gets the same answer, and it is a 404 rather
      // than a 403: there is nothing to retry and nothing to guess at.
      if (!c) return res.status(404).send(JSON.stringify({ error: 'Ese enlace ya no vale. Pídenos uno nuevo.' }))
      return res.status(200).send(JSON.stringify(c))
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
      if (body.salir) {
        await salir(pedidos, body.t)
        return res.status(200).send(JSON.stringify({ fuera: true }))
      }
      const lista = body.quitar
        ? await desvigilar(pedidos, body.t, body.clave)
        : await vigilar(pedidos, db(), body.t, body.clave)
      return res.status(200).send(JSON.stringify({ vigilancias: lista }))
    }

    res.status(405).send(JSON.stringify({ error: 'usa GET o POST' }))
  } catch (err) {
    if (err?.cliente) return res.status(400).send(JSON.stringify({ error: err.message }))
    fail(res, err)
  }
}
