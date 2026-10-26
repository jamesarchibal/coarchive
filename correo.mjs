// mercantil · the only place that sends mail.
//
// One function, one provider, one address. Everything that leaves this project
// by mail goes through enviar(): the code that lets a client in, and later the
// order notice, the delivery and the BORME watch warnings, which are all done
// by hand today.
//
// WHY RESEND AND NOT THE OTHER TWO DOORS WE ALREADY HAD, because this was
// decided twice and the reasons should not have to be rediscovered:
//   - Web3Forms is what the public pages use, and it answers 403 to a call made
//     from a server unless the account is Pro. It is a browser form relay, not
//     a mailer.
//   - The Google service account cannot send either: `gmail.send` is not in its
//     domain-wide delegation, and adding it is a Workspace admin change.
//
// ⚠️ IT FAILS LOUD IN PRODUCTION AND PRINTS IN DEVELOPMENT. Without the key, a
// deployed function throws, because a login code that is silently not sent is
// worse than an error: the client waits for a mail that will never come. On
// this machine there is no key and none is wanted, so the mail is written to
// the terminal and development needs no account.

const DESDE = process.env.COARCHIVE_DESDE || 'Coarchive <coarchive@joblanders.ai>'
const CLAVE = () => process.env.RESEND_API_KEY || ''

export const hayCorreo = () => Boolean(CLAVE())

export async function enviar ({ para, asunto, texto }) {
  if (!CLAVE()) {
    if (process.env.VERCEL) throw new Error('RESEND_API_KEY no está puesta, no puedo enviar correo')
    process.stdout.write(`\n--- correo para ${para} ---\n${asunto}\n\n${texto}\n---\n\n`)
    return { simulado: true }
  }

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CLAVE()}`, 'Content-Type': 'application/json' },
    // Plain text on purpose. A six digit code does not need a layout, and a
    // mail with no HTML and no images is the one least likely to be filed as
    // junk, which for the only way into the account is the whole point.
    body: JSON.stringify({ from: DESDE, to: [para], subject: asunto, text: texto }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Resend ${r.status}: ${data.message || data.name || 'sin detalle'}`)
  return data
}
