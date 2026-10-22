import { buscar } from '../queries.mjs'
import { db, json, fail } from './_db.js'

export default async function handler (req, res) {
  const q = req.query
  try {
    json(res, await buscar(db(), {
      q: q.q || '',
      provincia: q.provincia || '',
      forma: q.forma || '',
      estado: q.estado || '',
      page: Number(q.page) || 1,
    }))
  } catch (err) {
    fail(res, err)
  }
}
