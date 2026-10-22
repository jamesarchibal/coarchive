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

import { buscar, empresa } from './queries.mjs'
import { crear, pedidosClient } from './pedidos.mjs'
import { localClient, plantilla } from './publish.mjs'

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8806
const db = localClient()
const pedidos = pedidosClient()

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
    if (url.pathname === '/api/buscar') {
      return json(res, await buscar(db, {
        q: p.get('q') || '',
        provincia: p.get('provincia') || '',
        forma: p.get('forma') || '',
        estado: p.get('estado') || '',
        page: Number(p.get('page')) || 1,
      }))
    }
    if (url.pathname === '/api/empresa') {
      const e = await empresa(db, p.get('clave') || '')
      if (!e) { res.writeHead(404); return res.end('no existe') }
      return json(res, e)
    }
    const { html } = await plantilla(db)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err.message || err) }))
  }
}).listen(PORT, () => {
  process.stdout.write(`mercantil  http://localhost:${PORT}\n`)
})
