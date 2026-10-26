// mercantil · the industry classification, in one place.
//
// WHY A WHOLE FILE FOR 21 LINES
// BORME prints the activity as a bare CNAE number ("CNAE 6201"), sometimes with
// four digits and sometimes with two. A number is not a filter: nobody browses
// a list of 889 codes. The official grouping above the code is the SECTION, 21
// of them, lettered A to U, and that is a list a person can read.
//
// SOURCE, verbatim, both the letters and the names:
//   Real Decreto 475/2007, de 13 de abril, CNAE-2009
//   https://www.boe.es/buscar/act.php?id=BOE-A-2007-8824
// Cross-checked against https://www.cnae.com.es/lista-actividades.php on
// 2026-10-22: same 21 sections, same boundaries.
//
// `desde` is the first division of the section. The last one is NOT written
// down: a code belongs to the last section whose `desde` is not above it. That
// way the table cannot contradict itself, and the gaps in the official ranges
// (04, 34, 40, 44, 48, 54, 57, 67, 83, 89) fall into the section before them,
// which is where a mistyped code would belong anyway.
//
// ⚠️ CNAE-2025 exists and replaces CNAE-2009 for new filings. A bulletin from
// 2027 may carry codes that mean something else here. Re-read this comment
// before loading any year after 2026.
export const SECCIONES = [
  ['A', 1, 'Agricultura, ganadería, silvicultura y pesca'],
  ['B', 5, 'Industrias extractivas'],
  ['C', 10, 'Industria manufacturera'],
  ['D', 35, 'Suministro de energía eléctrica, gas, vapor y aire acondicionado'],
  ['E', 36, 'Suministro de agua, saneamiento y gestión de residuos'],
  ['F', 41, 'Construcción'],
  ['G', 45, 'Comercio al por mayor y al por menor'],
  ['H', 49, 'Transporte y almacenamiento'],
  ['I', 55, 'Hostelería'],
  ['J', 58, 'Información y comunicaciones'],
  ['K', 64, 'Actividades financieras y de seguros'],
  ['L', 68, 'Actividades inmobiliarias'],
  ['M', 69, 'Actividades profesionales, científicas y técnicas'],
  ['N', 77, 'Actividades administrativas y servicios auxiliares'],
  ['O', 84, 'Administración Pública y defensa'],
  ['P', 85, 'Educación'],
  ['Q', 86, 'Actividades sanitarias y de servicios sociales'],
  ['R', 90, 'Actividades artísticas, recreativas y de entretenimiento'],
  ['S', 94, 'Otros servicios'],
  ['T', 97, 'Actividades de los hogares como empleadores'],
  ['U', 99, 'Actividades de organizaciones extraterritoriales'],
]

export const NOMBRE_SECCION = Object.fromEntries(SECCIONES.map(([l, , n]) => [l, n]))

// The letter for a CNAE code as BORME prints it, or null. A code outside 01-99
// returns null rather than being clamped into section A or U: a wrong code must
// disappear from the filter, not pollute a real section.
export function seccion (cnae) {
  const n = Number(String(cnae || '').slice(0, 2))
  if (!Number.isInteger(n) || n < 1 || n > 99) return null
  let out = null
  for (const [letra, desde] of SECCIONES) if (n >= desde) out = letra
  return out
}
