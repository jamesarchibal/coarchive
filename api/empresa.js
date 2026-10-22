import { empresa } from '../queries.mjs'
import { db, json, fail } from './_db.js'

export default async function handler (req, res) {
  try {
    const e = await empresa(db(), req.query.clave || '')
    if (!e) return res.status(404).send('no existe')
    json(res, e)
  } catch (err) {
    fail(res, err)
  }
}
