// PitIspettore - un browser per sviluppatori in cloud, pensato per il telefono.
//
// Il telefono non ha gli strumenti da sviluppatore. Qui si incolla l'indirizzo
// di una pagina (per esempio una classifica di live timing): un Chrome senza
// schermo la apre, la lascia girare qualche secondo e rimanda un rapporto con le
// richieste di rete, i websocket, un'immagine della pagina e i "candidati dati",
// cioe' le richieste che sembrano portare la classifica.
//
//   GET /                         la pagina per il telefono
//   GET /api/ispeziona?url=       l'ispezione (richiede il token)
//   GET /api/salute               risponde sempre: serve a svegliarlo
//
// Il token e' ISPETTORE_TOKEN, oppure BRIDGE_TOKEN se si vuole usare la stessa
// parola d'ordine del ponte. Senza token lo strumento resta spento.
// CHROME_PATH (facoltativa) indica un Chrome gia' presente, per le prove in locale.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ispeziona } = require("./ispezione");

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.ISPETTORE_TOKEN || process.env.BRIDGE_TOKEN || "";
const AVVIO = Date.now();
const LIMITE_MS = 75000; // oltre questo tempo l'ispezione si interrompe

function rispondi(res, stato, tipo, corpo) {
  const buf = Buffer.from(corpo, "utf8");
  res.writeHead(stato, { "Content-Type": tipo, "Content-Length": buf.length, "Cache-Control": "no-store" });
  res.end(buf);
}
const json = (res, stato, obj) => rispondi(res, stato, "application/json; charset=utf-8", JSON.stringify(obj));
const testo = (res, stato, t) => rispondi(res, stato, "text/plain; charset=utf-8", t);

function autorizzato(req) {
  const atteso = Buffer.from("Bearer " + TOKEN);
  const ricevuto = Buffer.from(String(req.headers.authorization || ""));
  return ricevuto.length === atteso.length && crypto.timingSafeEqual(ricevuto, atteso);
}

const PAGINA = fs.readFileSync(path.join(__dirname, "pagina.html"), "utf8");
let occupato = false; // un'ispezione alla volta: Chrome e' pesante

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch (e) { return testo(res, 400, "richiesta non valida"); }
  if (req.method !== "GET" && req.method !== "HEAD") return testo(res, 405, "metodo non consentito");

  if (url.pathname === "/") return rispondi(res, 200, "text/html; charset=utf-8", PAGINA);
  if (url.pathname === "/api/salute") {
    return json(res, 200, { ok: true, attivoDa: Math.round((Date.now() - AVVIO) / 1000), occupato, strumentoAttivo: !!TOKEN });
  }

  if (url.pathname === "/api/ispeziona") {
    if (!TOKEN) return json(res, 403, { ok: false, messaggio: "strumento spento: imposta ISPETTORE_TOKEN (o BRIDGE_TOKEN) sul servizio" });
    if (!autorizzato(req)) return json(res, 401, { ok: false, messaggio: "token mancante o errato" });
    if (occupato) return json(res, 429, { ok: false, messaggio: "un'altra ispezione e' in corso: riprova fra qualche secondo" });
    occupato = true;
    try {
      const rapporto = await Promise.race([
        ispeziona(url.searchParams.get("url") || "", {
          secondi: url.searchParams.get("secondi"),
          vista: url.searchParams.get("vista") === "mobile" ? "mobile" : "desktop",
          immagine: url.searchParams.get("immagine") !== "0",
        }),
        new Promise((_, no) => setTimeout(() => no(new Error("tempo scaduto")), LIMITE_MS)),
      ]);
      return json(res, 200, rapporto);
    } catch (e) {
      return json(res, 200, { ok: false, messaggio: e.message || String(e) });
    } finally {
      occupato = false;
    }
  }

  return testo(res, 404, "non trovato");
});

server.listen(PORT, () => console.log(`PitIspettore in ascolto sulla porta ${PORT}${TOKEN ? "" : " (ATTENZIONE: nessun token impostato, lo strumento e' spento)"}`));
