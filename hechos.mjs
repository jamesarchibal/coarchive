// mercantil · what can happen to a company, in one place.
//
// This file is the whole vocabulary: the id stored in the database, the name
// the page prints, and the pattern that recognises the event in a BORME act
// label. build.mjs reads the patterns, queries.mjs reads the names, and both
// read the ORDER, because the order is the number.
//
// ⚠️ THE ORDER IS LOAD BEARING. Each event is one bit of empresa.hechos, bit i
// for the event at position i, so moving a line rewrites the meaning of every
// row already in the database. Add new events at the END, and if an event has
// to disappear, leave its line in place and rebuild. A rebuild takes four
// minutes, but a silent reshuffle gives wrong answers that look right.
//
// The eleven were chosen by counting all 61.358 distinct labels in the base on
// 2026-10-22, so every one of them is known to return rows. The counts are the
// companies each label appears on, before de-duplication:
//   constitucion 261.400 · unipersonal 141.372 · domicilio 95.046
//   extincion 68.182 · estatutos 67.198 · disolucion 58.690
//   ampliacion 57.204 · objeto 34.339 · denominacion 18.159
//   reduccion 14.332
// Deliberately NOT included: Nombramientos (734.000) and Ceses/Dimisiones
// (217.000). They are a person moving, not the company moving, and a filter
// that matches most of the base tells you nothing.
export const HECHOS = [
  ['constitucion', 'Se constituyó', /^Constituci[oó]n/i],
  ['ampliacion', 'Amplió capital', /Ampliaci[oó]n\s+de\s+capital/i],
  ['reduccion', 'Redujo capital', /Reducci[oó]n\s+de\s+capital/i],
  ['domicilio', 'Cambió de domicilio', /Cambio\s+de\s+domicilio/i],
  ['objeto', 'Cambió de objeto social', /(?:Cambio|Ampliaci[oó]n|Modificaci[oó]n)\s+(?:de|del)\s+objeto\s+social/i],
  ['denominacion', 'Cambió de nombre', /Cambio\s+de\s+denominaci[oó]n/i],
  ['estatutos', 'Modificó estatutos', /Modificaci[oó]n(?:es)?\s+estatutaria/i],
  ['unipersonal', 'Declaró unipersonalidad', /unipersonalidad/i],
  ['disolucion', 'Se disolvió', /^Disoluci[oó]n/i],
  ['extincion', 'Se extinguió', /^(?:Extinci[oó]n|Cancelaci[oó]n\s+de\s+oficio)/i],
  ['concurso', 'Entró en concurso', /concurs/i],
]

// ⚠️ 32 is the ceiling. SQLite integers are 64 bit, but JavaScript's `<<`
// works on 32 bit signed values, so the twelfth event is safe and the
// thirty-second is not. There are eleven today.
export const BIT = Object.fromEntries(HECHOS.map(([id], i) => [id, 1 << i]))

// The labels of every act of one company, turned into the one integer that is
// stored on the company row.
export function mascara (labels) {
  let m = 0
  for (const l of labels) for (const [id, , re] of HECHOS) if (re.test(l)) m |= BIT[id]
  return m
}

// And back, for the ficha.
export function listaHechos (mascara) {
  return HECHOS.filter(([id]) => (Number(mascara) || 0) & BIT[id]).map(([id]) => id)
}
