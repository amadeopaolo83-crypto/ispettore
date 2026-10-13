// Controlli per non trasformare l'ispettore in un modo di raggiungere la rete
// interna del server: si rifiutano gli indirizzi privati, anche quando un nome
// pubblico punta a un indirizzo privato.

const dns = require("dns").promises;
const net = require("net");

function ipPrivato(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::1" || x === "::") return true;
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x)) return true;
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return ipPrivato(m[1]);
    return false;
  }
  return true;
}

const memo = new Map(); // nome host -> { t, ok }
const MEMO_MS = 60 * 1000;

// SOLO per le prove sul proprio computer: consente 127.0.0.1. Non va mai
// impostata su Render.
const PROVA_LOCALE = process.env.ISPETTORE_PROVA_LOCALE === "1";

/** Vero se l'host e' raggiungibile e pubblico; falso se privato o non risolvibile. */
async function hostPubblico(hostname) {
  const nome = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!nome) return false;
  if (PROVA_LOCALE && nome === "127.0.0.1") return true;
  if (net.isIP(nome)) return !ipPrivato(nome);
  if (nome === "localhost" || nome.endsWith(".local") || nome.endsWith(".internal")) return false;
  const c = memo.get(nome);
  if (c && Date.now() - c.t < MEMO_MS) return c.ok;
  let ok = false;
  try {
    const indirizzi = await dns.lookup(nome, { all: true });
    ok = indirizzi.length > 0 && !indirizzi.some((i) => ipPrivato(i.address));
  } catch (e) {
    ok = false;
  }
  memo.set(nome, { t: Date.now(), ok });
  return ok;
}

module.exports = { ipPrivato, hostPubblico };
