import { buscar, entrada } from '../queries.mjs'
import { db, json, fail } from './_db.js'

export default async function handler (req, res) {
  try {
    json(res, await buscar(db(), entrada((k) => req.query[k])))
  } catch (err) {
    fail(res, err)
  }
}
