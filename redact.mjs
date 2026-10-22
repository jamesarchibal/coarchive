// ─────────────────────────────────────────────────────────────────────────────
// PRIVACY. BORME section A names the people behind every act: administrators,
// attorneys, liquidators, auditors, the sole shareholder, the judge, the
// insolvency administrator. This file is the only place that decides what we
// keep, and the rule is:
//
//   a natural person becomes [persona]  ·  a company keeps its name
//
// A company is not personal data, and "who administers whom" is the whole point
// of a company register. Do not widen this to natural persons without a
// legitimate interest assessment signed by counsel.
//
// Three measurements, all on 2026-10-21 against the raw bulletin cache, shaped
// the design. Each one killed an approach:
//
// 1. Cutting the value at the first period turned "ISFA GESTION S.L." into
//    "ISFA GESTION S", so 708.557 of 1.182.206 acts came out redacted and only
//    8.178 company names survived. Pure loss, no privacy gained.
//
// 2. A list of cargo labels cannot be enumerated. 40 sampled days leaked 22
//    names through labels no sample had shown: Co.De.Ma.So, Soc.Prof.,
//    SecreNoConsj, VsecrNoConsj, R.L.C.Perma., D. Gerente.
//
// 3. Vetoing names that contain a business word leaks too, because business
//    words are also surnames: MORENO VENTAS, BAS MARCO, GIMENEZ ARTES. The
//    veto list below is therefore limited to words that cannot be a surname.
//
// 4. Reading only the FIRST colon of a sentence leaks. "Otros conceptos" and
//    "Fe de erratas" write the cargo again inside their own paragraph, so the
//    name sits after the second colon, and 1.182.206 acts went in with 8.279
//    distinct people still in them. Hence: split on every colon, and never skip
//    a sentence because its first label looked harmless.
//
// So the test is positive and the default is to redact: anything shaped like a
// personal name goes, whatever label it sits under. What is NOT achievable with
// this approach, and is accepted: a name written inside a free-text paragraph
// in mixed case. Those are incidental mentions, not a list of administrators.
//
// How to check a change. Both harnesses read the raw bulletin cache, classify
// with a test INDEPENDENT of this file, and must stay at zero:
//   · every appointee item after a cargo label (10.505 people in 40 days)
//   · every person-shaped run of capitals ANYWHERE in the output, not just
//     after a label. This is the one that found measurement 4.
// A reported survivor is not automatically a leak: read its context first,
// because the harness misjudges companies (PROMOTORA ... EMPRESARIALES) and a
// street name under Domicilio is not a person.
// ─────────────────────────────────────────────────────────────────────────────

// A company name ends in its legal form. Anchored at the end on purpose: a
// personal name does not end in SL or SOCIEDAD LIMITADA. The bare two-letter
// foreign forms (OY, AG, NV, AB, SE, AS) are deliberately left out, because
// they could be a surname and a false positive here publishes a person.
const SOCIEDAD = new RegExp(
  '(?:^|[\\s.&,)])(?:' + [
    'S\\.?L\\.?(?:[UPNE]\\.?){0,3}',
    'S\\.?A\\.?[USP]?\\.?',
    'SOCIEDAD(?: [A-Z]+){0,3}',
    'S\\.?COOP\\.?(?: [A-Z]+){0,3}',
    'COOPERATIVA(?: [A-Z]+){0,3}',
    'SCCL', 'S\\.?G\\.?E\\.?I\\.?C\\.?', 'A\\.?I\\.?E\\.?', 'S\\.?C\\.?P\\.?',
    'S\\.?A\\.?R\\.?L\\.?', 'S\\.?R\\.?L\\.?', 'S\\.?P\\.?A\\.?',
    'LDA', 'B\\.?V\\.?', 'GMBH', 'LTD', 'LIMITED', 'PLC', 'INC', 'CORP',
    'FUNDACI[OÓ]N', 'ASOCIACI[OÓ]N', 'AYUNTAMIENTO', 'MUTUA', 'CONSORCIO',
    'UNIPERSONAL',
  ].join('|') + ')\\.?$',
  'i',
)

// BORME prints appointees in capitals, surnames first: "MARTINEZ FORNET
// VICENTE". So the person test is a short run of capitals with no digit. A
// token carries its own periods, because that is what makes
// "A. B. Z. AUDILAN S.L.P." one name and not four. It does NOT carry commas: a
// comma let a run run on into the next field, and "RUBEM GOMES GALVAO, NIF
// portugués ..." survived because the word NIF is on the veto list.
const TOKEN = "[A-ZÁÉÍÓÚÜÑÇ][A-ZÁÉÍÓÚÜÑÇ'·\\-.]*"
const NOMBRE = new RegExp(`^${TOKEN}(?:\\s+${TOKEN}){1,6}$`)
const RUN = new RegExp(`${TOKEN}(?:\\s+${TOKEN}){1,6}`, 'g')

// Words that cannot be a surname. This is the whole list on purpose: every
// business word that could also be a surname was removed after measurement 3.
// A company name that gets no protection here is merely lost, not leaked.
// COMPANY and JUZGADO were on this list and had to come off after measurement
// 4: both are real Valencian surnames and they kept six people in the base
// (COMPANY BONNIN MARTIN, SANCHIS COMPANY MARIA DOLORES, FERNANDO GARCIA
// JUZGADO). The boilerplate words at the end of the list are not business words
// at all: they are the fixed prose of "Otros conceptos", and they are here so
// that splitting that paragraph does not turn the sentence that says what
// happened into a row of [persona].
const NO_ES_NOMBRE = new RegExp('\\b(?:' + [
  'SOCIEDAD', 'LIMITADA', 'ANONIMA', 'COOPERATIVA', 'UNIPERSONAL', 'PROFESIONAL',
  'HOLDING', 'GROUP', 'GRUPO', 'CORPORACION', 'GMBH', 'LTD', 'LIMITED',
  'INCORPORATED', 'FUNDACION', 'ASOCIACION', 'AYUNTAMIENTO', 'UNIVERSIDAD',
  'CONSORCIO', 'SUCURSAL', 'MERCANTIL', 'REGISTRO', 'REGISTRAL',
  'ESTATUTOS', 'TRLC', 'CONSEJO', 'JUNTA', 'ADMINISTRACION', 'ADMINISTRADOR\\w*',
  'INVERSIONES', 'EMPRESARIAL\\w*', 'TECNOLOGIAS', 'EUROS', 'PTAS', 'NIF', 'CIF',
  'DECLARACION', 'DECLARADA', 'CAMBIO', 'SIENDO', 'CONDICION',
  'CARACTER', 'PARTICIPACIONES', 'SOCIALES', 'ACUERDO', 'ESCRITURA', 'AMPLIACION',
  'REDUCCION', 'DISOLUCION', 'LIQUIDACION', 'TRASLADO', 'DOMICILIO', 'CAPITAL',
  'DEBE', 'LEERSE', 'DONDE', 'OMITIO', 'ERRATAS', 'SUSCRITO', 'DESEMBOLSADO',
  'CONCURSO', 'CONCURSAL', 'VOLUNTARIO', 'NECESARIO', 'INSOLVENCIA',
].join('|') + ')\\b', 'i')

// Labels whose value is never a person. Everything else is treated as if it
// could be one, which is the point: the list of cargos is open, this one is not.
// Domicilio is here because a street name is not the person who lives there,
// and Juzgado because a court is not a person either.
//
// "Fe de erratas" and "Resoluciones" were on this list and had to come off
// after measurement 4. An errata restates the cargo inside its own paragraph
// ("DONDE SE LEE: ADM.CONJUNTO: HUSSAIN MUNAWAR, DEBE LEERSE: ..."), and a
// court resolution can name the insolvency administrator. Skipping the sentence
// skipped the name with it.
const NO_PERSONA = /^(?:Objeto(?:\s+social)?|Otras\s+actividades|Domicilio(?:\s+social)?(?:\s+y\s+web\s+corporativa)?|Juzgado|Comienzo\s+de\s+operaciones|Capital(?:\s+social)?|CNAE|Datos\s+registrales)$/i

// A person has at most seven words in their name. That, not a character count,
// is the reason a long run is left alone: it is a sentence, not a name. The
// rule used to be "longer than 70 characters" and that was an arbitrary number
// that leaked, because the boilerplate of "Otros conceptos" is longer than 70
// characters and it carries the name of the sole shareholder at its end.
function clasifica (run) {
  if (SOCIEDAD.test(run)) return run
  if (run.trim().split(/\s+/).length > 7) return run
  if (NO_ES_NOMBRE.test(run)) return run
  return '[persona]'
}

function porItem (s) {
  const t = s.trim()
  if (!t) return s
  const bare = t.replace(/\.$/, '')
  // One appointee, printed in capitals. This is the case that matters, because
  // it is the one that would build a searchable list of administrators.
  if (NOMBRE.test(bare)) {
    if (clasifica(bare) !== '[persona]') return s
    return s.replace(t, t === bare ? '[persona]' : '[persona].')
  }
  // Free text. Only here do we hunt capitalised runs inside the item, and only
  // because the paragraphs of "Otros conceptos" name people in passing.
  if (/[a-záéíóúüñ]/.test(t)) return s.replace(RUN, clasifica)
  // Capitals that the name test could not read because of an & or a stray
  // hyphen: "ERNST & YOUNG SL", but also "FRIGGE -NACIDO KARSTENS- STEFAN". It
  // has to prove it is a company to stay. Anything with a digit is exempt, or
  // this eats the registry tail "S 8 , H VI 20991, I/A 4 (27.01.25)".
  if (/\d/.test(bare) || !/\s/.test(bare)) return s
  const out = clasifica(bare)
  if (out !== '[persona]') return s
  return s.replace(t, t === bare ? '[persona]' : '[persona].')
}

// A DNI or an NIE identifies one person. A CIF identifies a company, so it
// stays: it is the one identifier BORME otherwise never gives us.
const DNI = /\b(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/g

export function redact (texto) {
  // Sentences, separators kept, so the join is lossless. A company name with
  // internal periods gets split across sentences, which is harmless: each piece
  // is judged on its own and a piece that is not a name is left alone.
  const parts = texto.split(/((?<=\.)\s+)/)
  for (let i = 0; i < parts.length; i += 2) {
    const frase = parts[i]
    const colon = frase.indexOf(':')
    if (colon > 0 && NO_PERSONA.test(frase.slice(0, colon).trim())) continue
    // Split on EVERY colon, not just the first. Measurement 4: "Otros
    // conceptos" writes the cargo again inside its own paragraph, so the name
    // sits after the second colon ("Otros conceptos: SOCIEDAD
    // UNIPERSONAL.SOCIO UNICO:ARIADNA ..."). Reading only the first colon left
    // those names in the base. The first piece is the label and is never
    // touched; every piece after a colon is a value and is judged.
    const trozos = frase.split(':')
    for (let j = 1; j < trozos.length; j++) {
      trozos[j] = trozos[j].split(';').map(porItem).join(';')
    }
    parts[i] = trozos.join(':')
  }
  return parts.join('').replace(DNI, '[dni]')
}
