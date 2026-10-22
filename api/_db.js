// One libSQL client per warm function instance. Turso counts row reads, not
// connections, so reusing the client across invocations is free and saves the
// handshake.

import { createClient } from '@libsql/client'

let client

export function db () {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL
    if (!url) throw new Error('TURSO_DATABASE_URL is not set')
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
  }
  return client
}

// The data is BORME, which is open data, so the answers can be cached hard at
// the edge. The base only changes when build.mjs runs.
export function json (res, data, seconds = 3600) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', `public, s-maxage=${seconds}, stale-while-revalidate=86400`)
  res.status(200).send(JSON.stringify(data))
}

export function fail (res, err) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.status(500).send(JSON.stringify({ error: String(err?.message || err) }))
}
