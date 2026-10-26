// Throwaway check of the new filter columns against a real two-day build.
//   node comprobar-filtros.mjs prueba-filtros.db
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { NOMBRE_SECCION } from './cnae.mjs'
import { HECHOS, BIT, listaHechos } from './hechos.mjs'

const db = new DatabaseSync(path.join(os.homedir(), 'mercantil-data', process.argv[2]))
const q = (sql) => db.prepare(sql).all()
const n = Number(q('SELECT COUNT(*) n FROM empresa')[0].n)
const pc = (k) => (100 * k / n).toFixed(1) + '%'

console.log('empresas', n)

console.log('\n--- capital_eur: texto frente a numero ---')
for (const r of q(`SELECT capital, capital_eur FROM empresa
    WHERE capital IS NOT NULL ORDER BY RANDOM() LIMIT 10`)) {
  console.log(' ', String(r.capital).padEnd(34), String(r.capital_eur))
}
console.log('con capital texto  ', pc(q('SELECT COUNT(*) n FROM empresa WHERE capital IS NOT NULL')[0].n))
console.log('con capital_eur    ', pc(q('SELECT COUNT(*) n FROM empresa WHERE capital_eur IS NOT NULL')[0].n))
console.log('texto sin numero   ', q('SELECT COUNT(*) n FROM empresa WHERE capital IS NOT NULL AND capital_eur IS NULL')[0].n,
  '(deberian ser solo pesetas)')
for (const r of q(`SELECT capital FROM empresa WHERE capital IS NOT NULL AND capital_eur IS NULL LIMIT 5`)) {
  console.log('   ', r.capital)
}
console.log('min / max          ', q('SELECT MIN(capital_eur) a, MAX(capital_eur) b FROM empresa')[0])

console.log('\n--- tramos de tamano por capital ---')
for (const r of q(`SELECT CASE
      WHEN capital_eur IS NULL THEN 'z sin dato'
      WHEN capital_eur < 3100 THEN 'a <3.100'
      WHEN capital_eur < 10000 THEN 'b 3.100-10k'
      WHEN capital_eur < 60000 THEN 'c 10k-60k'
      WHEN capital_eur < 300000 THEN 'd 60k-300k'
      WHEN capital_eur < 3000000 THEN 'e 300k-3M'
      ELSE 'f 3M+' END b, COUNT(*) n FROM empresa GROUP BY 1 ORDER BY 1`)) {
  console.log(' ', String(r.b).padEnd(14), String(r.n).padStart(6), pc(r.n))
}

console.log('\n--- seccion CNAE ---')
for (const r of q(`SELECT seccion s, COUNT(*) n FROM empresa WHERE seccion IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC`)) {
  console.log(' ', r.s, String(r.n).padStart(5), pc(r.n).padStart(7), NOMBRE_SECCION[r.s])
}
console.log('con cnae    ', pc(q('SELECT COUNT(*) n FROM empresa WHERE cnae IS NOT NULL')[0].n))
console.log('con seccion ', pc(q('SELECT COUNT(*) n FROM empresa WHERE seccion IS NOT NULL')[0].n))
console.log('cnae sin seccion', q('SELECT COUNT(*) n FROM empresa WHERE cnae IS NOT NULL AND seccion IS NULL')[0].n)

console.log('\n--- hechos (un bit cada uno de empresa.hechos) ---')
const porHecho = q(`SELECT ${HECHOS.map(([id]) => `SUM((hechos & ${BIT[id]}) <> 0) "${id}"`).join(', ')}
    FROM empresa`)[0]
for (const [id] of HECHOS) {
  console.log(' ', id.padEnd(14), String(porHecho[id]).padStart(6), pc(porHecho[id]))
}
console.log('empresas con al menos un hecho', pc(q('SELECT COUNT(*) n FROM empresa WHERE hechos <> 0')[0].n))
console.log('empresas con NINGUN hecho     ', q('SELECT COUNT(*) n FROM empresa WHERE hechos = 0')[0].n)

console.log('\n--- un hecho de ejemplo, para leerlo a mano ---')
for (const r of q(`SELECT nombre, capital, capital_eur, cnae, seccion, hechos
    FROM empresa WHERE capital_eur IS NOT NULL AND seccion IS NOT NULL LIMIT 5`)) {
  console.log(' ', r.nombre)
  console.log('    ', r.capital, '->', r.capital_eur, '|', r.cnae, r.seccion, '|',
    listaHechos(r.hechos).join(','))
}
