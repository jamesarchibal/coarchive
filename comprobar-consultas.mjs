// Throwaway check of queries.mjs against a built database, without a server.
//   node comprobar-consultas.mjs prueba-filtros.db
import { createClient } from '@libsql/client'
import os from 'node:os'
import path from 'node:path'
import { buscar, resumen, entrada } from './queries.mjs'

const db = createClient({ url: `file:${path.join(os.homedir(), 'mercantil-data', process.argv[2])}` })
const r = await resumen(db)

console.log('empresas', r.empresas, '· actos', r.actos, '· provincias', r.provincias)
console.log('cobertura', r.cobertura)
console.log('\nsecciones', r.listaSecciones.map((s) => `${s.s}:${s.n}`).join(' '))
console.log('tramos   ', r.listaTramos.map((t) => `${t.t}:${t.n}`).join(' '))
console.log('hechos   ', r.listaHechos.map((h) => `${h.h}:${h.n}`).join(' '))
console.log('anios    ', r.listaAnios.map((a) => `${a.y}:${a.n}`).join(' '))

// Every option the page can offer must come back with rows. An option that
// cannot return anything is the bug this check exists to catch.
const casos = [
  {},
  { q: 'construcciones' },
  ...r.listaSecciones.map((s) => ({ seccion: s.s })),
  ...r.listaTramos.map((t) => ({ tramo: t.t })),
  ...r.listaHechos.map((h) => ({ hecho: h.h })),
  ...r.listaAnios.map((a) => ({ anio: a.y })),
  { estado: 'concurso' },
  { seccion: 'G', tramo: 'peq', hecho: 'constitucion' },
  // Values a hand-typed query string could carry. None may reach the SQL.
  { seccion: "X' OR 1=1 --" },
  { tramo: 'inventado' },
  { hecho: 'nada' },
  { anio: 'XXXX' },
]

let fallos = 0
for (const c of casos) {
  const out = await buscar(db, entrada((k) => c[k]))
  const etiqueta = JSON.stringify(c)
  const vacio = out.total === 0
  // The four last cases are ignored filters, so they must behave like no
  // filter at all and return the whole base.
  console.log(String(out.total).padStart(6), vacio ? 'VACIO' : '     ', etiqueta)
  if (vacio) fallos++
}
console.log('\nfiltros que no devuelven nada:', fallos)
