#!/usr/bin/env node
//
// mercantil · local server for the free company base.
//
//   node serve.mjs            -> http://localhost:8806
//   node serve.mjs --port 90  -> another port
//
// This is development only. In production the page is a static file on Vercel
// and the two endpoints are serverless functions in api/, but all three share
// queries.mjs and publish.mjs, so what you see here is what ships.
//
// Everything served comes from BORME, which is open data, so this page can be
// published. The paid part (NIF, cuentas anuales) is NOT here and is never
// stored: it is bought per request and handed to the client.
//
// The template is rebuilt on every request, so editing index.html and
// reloading is enough. The database handle is opened once.

import { createServer } from 'node:http'

import { buscar, empresa, entrada, localClient } from './queries.mjs'
import { canjear, crear, cuenta, desvigilar, pedidosClient, pedirCodigo, salir, vigilar } from './pedidos.mjs'
import { plantilla } from './publish.mjs'

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8806
const db = localClient()
const pedidos = pedidosClient()
let resumenCache

const cuerpo = (req) => new Promise((resolve, reject) => {
  let s = ''
  // 64 kB is far more than the form can hold and stops a stuck request from
  // eating memory.
  req.on('data', (c) => { s += c; if (s.length > 65536) reject(new Error('cuerpo demasiado grande')) })
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch (e) { reject(e) } })
  req.on('error', reject)
})

const json = (res, data) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const p = url.searchParams
  try {
    // The one endpoint that writes. It mirrors api/pedir.js, including the 400
    // for what the person can fix, so a form that works here works deployed.
    if (url.pathname === '/api/pedir') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('usa POST') }
      try {
        const p = await crear(pedidos, db, await cuerpo(req))
        return json(res, { id: p.id, empresa: p.empresa, precio_cent: p.precio_cent, presupuestar: p.presupuestar })
      } catch (err) {
        if (!err?.cliente) throw err
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ error: err.message }))
      }
    }
    // Mirrors api/entrar.js. Here the code is not mailed anywhere: correo.mjs
    // prints it in this terminal when there is no RESEND_API_KEY, which is how
    // the whole circuit is testable on this machine without an account.
    if (url.pathname === '/api/entrar') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('usa POST') }
      try {
        const b = await cuerpo(req)
        if (b.codigo) {
          const a = await canjear(pedidos, b.email, b.codigo)
          return json(res, { t: a.token, email: a.email })
        }
        const r = await pedirCodigo(pedidos, b.email)
        return json(res, { enviado: r.enviado })
      } catch (err) {
        if (!err?.cliente) throw err
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ error: err.message }))
      }
    }
    // Mirrors api/cuenta.js, both methods, including the 404 for a dead token.
    if (url.pathname === '/api/cuenta') {
      try {
        if (req.method === 'POST') {
          const b = await cuerpo(req)
          if (b.salir) { await salir(pedidos, b.t); return json(res, { fuera: true }) }
          const vigilancias = b.quitar
            ? await desvigilar(pedidos, b.t, b.clave)
            : await vigilar(pedidos, db, b.t, b.clave)
          return json(res, { vigilancias })
        }
        const c = await cuenta(pedidos, p.get('t') || '')
        if (!c) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ error: 'Ese enlace ya no vale. Pídenos uno nuevo.' }))
        }
        return json(res, c)
      } catch (err) {
        if (!err?.cliente) throw err
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ error: err.message }))
      }
    }
    if (url.pathname === '/api/buscar') {
      return json(res, await buscar(db, entrada((k) => p.get(k))))
    }
    if (url.pathname === '/api/empresa') {
      const e = await empresa(db, p.get('clave') || '')
      if (!e) { res.writeHead(404); return res.end('no existe') }
      return json(res, e)
    }
    // The resumen is counted once per process, the HTML is rebuilt every time.
    // See plantilla() for why that is safe. ⚠️ The consequence: a change to
    // queries.mjs, to build.mjs or to the database file needs a restart, while
    // a change to index.html does not.
    if (!resumenCache) resumenCache = (await plantilla(db)).resumen
    const { html } = await plantilla(db, resumenCache)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err.message || err) }))
  }
}).listen(PORT, () => {
  process.stdout.write(`mercantil  http://localhost:${PORT}\n`)
})
