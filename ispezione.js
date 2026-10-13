// L'ispezione: apre una pagina in un Chrome senza schermo, la lascia girare
// qualche secondo e registra tutto quello che fa (richieste, risposte,
// websocket, errori), come la scheda "Rete" degli strumenti da sviluppatore.
// Ne ricava un rapporto con in testa i "candidati dati": le richieste che
// sembrano portare la classifica (ripetute a intervalli, con risposte che
// sembrano dati).

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Cdp } = require("./cdp");
const { hostPubblico } = require("./sicurezza");

const ARGS_BASE = [
  "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
  "--disable-extensions", "--mute-audio", "--disable-background-networking",
];

const TIPI_CON_CORPO = new Set(["XHR", "Fetch", "Document", "EventSource", "Other"]);
const MAX_CORPO = 2500;        // caratteri tenuti di ogni risposta
const MAX_CORPO_SCRIPT = 400000; // byte di uno script letti per cercarvi indirizzi
const MAX_SCRIPT_LETTI = 15;
const INTESTAZIONI_UTILI = ["referer", "origin", "x-requested-with", "content-type", "accept"];

// ---------- avvio di Chrome ----------

async function trovaChrome() {
  if (process.env.CHROME_PATH) {
    return { eseguibile: process.env.CHROME_PATH, args: [...ARGS_BASE, "--headless=new"] };
  }
  // Su Render il Chrome arriva dal pacchetto @sparticuz/chromium (pensato per
  // ambienti senza librerie di sistema). Si importa solo qui, cosi' il resto del
  // servizio parte anche se il pacchetto manca.
  const mod = await import("@sparticuz/chromium");
  const chromium = mod.default || mod;
  const eseguibile = await chromium.executablePath();
  const args = (chromium.args || []).filter((a) => !/^--(remote-debugging|user-data-dir)/.test(a));
  return { eseguibile, args: [...new Set([...ARGS_BASE, ...args])] };
}

async function aspetta(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function avviaChrome() {
  const { eseguibile, args } = await trovaChrome();
  const porta = 20000 + Math.floor(Math.random() * 20000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isp-"));
  const proc = spawn(
    eseguibile,
    [...args, `--remote-debugging-port=${porta}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${dir}`, "about:blank"],
    { stdio: "ignore" },
  );
  let uscito = false;
  proc.on("exit", () => { uscito = true; });
  proc.on("error", () => { uscito = true; });
  const ferma = () => {
    try { proc.kill("SIGKILL"); } catch (e) { /* gia' chiuso */ }
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* pazienza */ } }, 500);
  };
  // si aspetta che Chrome risponda sulla porta di controllo
  for (let i = 0; i < 60; i++) {
    if (uscito) { ferma(); throw new Error("Chrome non si e' avviato"); }
    try {
      const r = await fetch(`http://127.0.0.1:${porta}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return { porta, ferma, versione: await r.json() };
    } catch (e) { /* non ancora pronto */ }
    await aspetta(250);
  }
  ferma();
  throw new Error("Chrome non risponde");
}

async function paginaDiLavoro(porta) {
  const elenco = await (await fetch(`http://127.0.0.1:${porta}/json/list`)).json();
  let p = elenco.find((x) => x.type === "page");
  if (!p) {
    const r = await fetch(`http://127.0.0.1:${porta}/json/new?about:blank`, { method: "PUT" });
    p = await r.json();
  }
  return p;
}

// ---------- utilita' ----------

const taglia = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n) + `… (+${t.length - n})` : t;
};

function chiaveRichiesta(r) {
  // Gli indirizzi che cambiano solo per un numero casuale o l'orario contano
  // come la stessa richiesta: si guardano i NOMI dei parametri, non i valori.
  try {
    const u = new URL(r.url);
    const nomi = [...u.searchParams.keys()].filter((k) => !/^(_|t|ts|time|timestamp|nocache|rand|random|cb|v)$/i.test(k)).sort();
    return `${r.metodo} ${u.origin}${u.pathname}${nomi.length ? "?" + nomi.join("&") : ""}`;
  } catch (e) {
    return `${r.metodo} ${r.url}`;
  }
}

function sembraDato(r) {
  const c = String(r.corpo || "").trim();
  if (!c) return false;
  if (/json/i.test(r.mime || "") || /^[\[{]/.test(c)) return true;
  if (/(xml|csv|plain)/i.test(r.mime || "")) return true;
  return false;
}

const RE_INDIRIZZI = /(?:wss?:\/\/[^\s"'`<>\\)]+|["'`](?:\/|https?:\/\/)[^\s"'`<>\\]*(?:api|\.php|\.json|\.aspx|ajax|socket|stream|live|data|timing|classifica|ranking|result)[^\s"'`<>\\]*["'`])/gi;

function trovaIndirizzi(testo, trovati) {
  let m;
  RE_INDIRIZZI.lastIndex = 0;
  while ((m = RE_INDIRIZZI.exec(testo)) && trovati.size < 60) {
    const v = m[0].replace(/^["'`]|["'`]$/g, "");
    if (v.length < 200) trovati.add(v);
  }
}

// ---------- l'ispezione vera e propria ----------

async function ispeziona(urlTesto, { secondi = 15, vista = "desktop", immagine = true } = {}) {
  let url;
  try { url = new URL(urlTesto); } catch (e) { throw new Error("indirizzo non valido"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("sono ammessi solo indirizzi http e https");
  if (!(await hostPubblico(url.hostname))) throw new Error("indirizzo non consentito");
  secondi = Math.max(5, Math.min(40, Number(secondi) || 15));

  const inizio = Date.now();
  const chrome = await avviaChrome();
  const cdp = new Cdp((await paginaDiLavoro(chrome.porta)).webSocketDebuggerUrl);

  const reqs = new Map();   // requestId -> richiesta
  const ordine = [];        // le richieste, nell'ordine in cui compaiono
  const sockets = new Map();
  const sse = [];
  const consoleRighe = [];
  const indirizziScript = new Set();
  let scriptLetti = 0;
  let bloccate = 0;
  let nuoveVolte = 0;
  let abortito = false;
  let coda = Promise.resolve();
  const accoda = (f) => { coda = coda.then(f).catch(() => {}); };

  try {
    await cdp.connetti();
    const ua = String((chrome.versione && chrome.versione["User-Agent"]) || "").replace("HeadlessChrome", "Chrome");

    cdp.on("Network.requestWillBeSent", (p) => {
      const id = p.requestId;
      if (/^(data|blob):/i.test(p.request.url)) return; // immagini incorporate: rumore
      if (p.redirectResponse && reqs.has(id)) reqs.get(id).stato = p.redirectResponse.status;
      const chiave = reqs.has(id) ? `${id}#${++nuoveVolte}` : id;
      const intest = {};
      for (const [k, v] of Object.entries(p.request.headers || {})) {
        if (INTESTAZIONI_UTILI.includes(k.toLowerCase())) intest[k.toLowerCase()] = v;
      }
      const r = {
        id: chiave, rid: id, tipo: p.type || "Other", metodo: p.request.method, url: p.request.url,
        t0: Date.now() - inizio, stato: null, mime: "", dimensione: null, corpo: null,
        postData: p.request.postData ? taglia(p.request.postData, 400) : null, intestazioni: intest,
      };
      reqs.set(id, r);
      ordine.push(r);
    });
    cdp.on("Network.responseReceived", (p) => {
      const r = reqs.get(p.requestId);
      if (!r) return;
      r.stato = p.response.status;
      r.mime = p.response.mimeType || "";
      if (p.type) r.tipo = p.type;
    });
    cdp.on("Network.loadingFailed", (p) => {
      const r = reqs.get(p.requestId);
      if (r) r.errore = p.blockedReason || p.errorText || "fallita";
    });
    cdp.on("Network.loadingFinished", (p) => {
      const r = reqs.get(p.requestId);
      if (!r) return;
      r.dimensione = p.encodedDataLength;
      r.ms = Date.now() - inizio - r.t0;
      const daLeggere = TIPI_CON_CORPO.has(r.tipo) && (r.dimensione == null || r.dimensione < 3000000);
      const script = r.tipo === "Script" && scriptLetti < MAX_SCRIPT_LETTI;
      if (script) scriptLetti++;
      if (!daLeggere && !script) return;
      accoda(async () => {
        const b = await cdp.send("Network.getResponseBody", { requestId: p.requestId }, 8000);
        if (script) {
          if (!b.base64Encoded) trovaIndirizzi(String(b.body).slice(0, MAX_CORPO_SCRIPT), indirizziScript);
          return;
        }
        r.corpo = b.base64Encoded ? "(binario)" : taglia(b.body, MAX_CORPO);
      });
    });

    // websocket e eventi dal server
    cdp.on("Network.webSocketCreated", (p) => {
      sockets.set(p.requestId, { url: p.url, t0: Date.now() - inizio, ricevuti: 0, inviati: 0, frame: [], chiuso: false });
      try {
        const u = new URL(p.url.replace(/^ws/, "http"));
        hostPubblico(u.hostname).then((ok) => { if (!ok) { bloccate++; abortito = true; } });
      } catch (e) { /* indirizzo strano: lo si vede nel rapporto */ }
    });
    const frame = (dir) => (p) => {
      const s = sockets.get(p.requestId);
      if (!s) return;
      if (dir === "<") s.ricevuti++; else s.inviati++;
      if (s.frame.length < 12) s.frame.push({ dir, t: Date.now() - inizio, dati: taglia(p.response.payloadData, 400) });
    };
    cdp.on("Network.webSocketFrameReceived", frame("<"));
    cdp.on("Network.webSocketFrameSent", frame(">"));
    cdp.on("Network.webSocketClosed", (p) => { const s = sockets.get(p.requestId); if (s) s.chiuso = true; });
    cdp.on("Network.eventSourceMessageReceived", (p) => {
      if (sse.length < 12) sse.push({ evento: p.eventName, dati: taglia(p.data, 400) });
    });

    // console e errori della pagina
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (consoleRighe.length >= 30) return;
      if (!["error", "warning", "log"].includes(p.type)) return;
      const testo = (p.args || []).map((a) => (a.value !== undefined ? a.value : a.description || "")).join(" ");
      consoleRighe.push(`[${p.type}] ${taglia(testo, 240)}`);
    });
    cdp.on("Runtime.exceptionThrown", (p) => {
      if (consoleRighe.length < 30) consoleRighe.push("[eccezione] " + taglia((p.exceptionDetails && (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text)) || "", 240));
    });

    // ogni richiesta controllata: niente reti interne
    cdp.on("Fetch.requestPaused", async (p) => {
      let ok = true;
      try {
        const u = new URL(p.request.url);
        if (u.protocol === "http:" || u.protocol === "https:") ok = await hostPubblico(u.hostname);
      } catch (e) { ok = true; }
      try {
        if (ok) await cdp.send("Fetch.continueRequest", { requestId: p.requestId });
        else { bloccate++; await cdp.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }); }
      } catch (e) { /* la pagina potrebbe essere gia' passata oltre */ }
    });

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    if (vista === "mobile") {
      await cdp.send("Network.setUserAgentOverride", {
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    } else {
      if (ua) await cdp.send("Network.setUserAgentOverride", { userAgent: ua });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    }
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
    });

    let caricata = false;
    cdp.on("Page.loadEventFired", () => { caricata = true; });
    await cdp.send("Page.navigate", { url: url.href }, 20000);
    // si lascia girare la pagina: serve a vedere le richieste che ripete nel tempo
    const fine = Date.now() + secondi * 1000;
    while (Date.now() < fine && !cdp.chiuso && !abortito) await aspetta(250);
    if (abortito) throw new Error("la pagina ha provato a collegarsi a un indirizzo interno: ispezione fermata per sicurezza");
    await Promise.race([coda, aspetta(6000)]);

    // cosa si vede sulla pagina
    let vis = { u: url.href, t: "", testo: "", righeTabella: 0 };
    try {
      const r = await cdp.send("Runtime.evaluate", {
        expression: "JSON.stringify({u:location.href,t:document.title,testo:(document.body?document.body.innerText:'').replace(/[ \\t]+/g,' ').replace(/\\n{2,}/g,'\\n').slice(0,1500),righeTabella:document.querySelectorAll('table tr').length})",
        returnByValue: true,
      }, 8000);
      vis = JSON.parse(r.result.value);
    } catch (e) { /* si va avanti con quello che c'e' */ }

    let schermata = null;
    if (immagine) {
      try {
        const s = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 45 }, 8000);
        if (s.data && s.data.length < 700000) schermata = s.data;
      } catch (e) { /* senza immagine si puo' vivere */ }
    }

    return costruisciRapporto({
      richiesto: url.href, vista, secondi, caricata, bloccate, vis, ordine, sockets, sse, consoleRighe,
      indirizziScript: [...indirizziScript], schermata, durataMs: Date.now() - inizio,
    });
  } finally {
    cdp.chiudi();
    chrome.ferma();
  }
}

// ---------- il rapporto ----------

function costruisciRapporto(d) {
  const tutte = d.ordine;
  const STATICI = new Set(["Image", "Stylesheet", "Font", "Media", "Script", "Ping", "Manifest"]);
  const principale = tutte.find((r) => r.tipo === "Document");
  const dati = tutte.filter((r) => !STATICI.has(r.tipo) && r !== principale);

  // raggruppa le richieste uguali
  const gruppi = new Map();
  for (const r of dati) {
    const k = chiaveRichiesta(r);
    if (!gruppi.has(k)) gruppi.set(k, []);
    gruppi.get(k).push(r);
  }
  const candidati = [];
  for (const [k, lista] of gruppi) {
    const ultima = [...lista].reverse().find((r) => r.corpo) || lista[lista.length - 1];
    let ogni = null;
    if (lista.length >= 3) {
      const t = lista.map((r) => r.t0).sort((a, b) => a - b);
      ogni = Math.round((t[t.length - 1] - t[0]) / (t.length - 1)) / 1000;
    }
    let punti = 0;
    if (lista.length >= 3) punti += 3;
    if (sembraDato(ultima)) punti += 3;
    if (/json|xml|csv/i.test(ultima.mime || "")) punti += 1;
    if (/api|\.php|ajax|\.json|data|live|timing|class|rank|result/i.test(ultima.url)) punti += 1;
    if (["XHR", "Fetch"].includes(ultima.tipo)) punti += 1;
    if (ultima.stato && ultima.stato >= 400) punti -= 2;
    candidati.push({ chiave: k, volte: lista.length, ogniSecondi: ogni, punti, esempio: ultima });
  }
  candidati.sort((a, b) => b.punti - a.punti || b.volte - a.volte);
  const migliori = candidati.filter((c) => c.punti >= 3).slice(0, 8);

  const socketLista = [...d.sockets.values()];
  const rapporto = {
    ok: true,
    pagina: { richiesta: d.richiesto, finale: d.vis.u, titolo: d.vis.t, caricata: d.caricata },
    vista: d.vista, secondi: d.secondi, durataMs: d.durataMs,
    testoVisibile: d.vis.testo, righeTabella: d.vis.righeTabella,
    candidati: migliori.map((c) => ({
      richiesta: c.chiave, volte: c.volte, ogniSecondi: c.ogniSecondi, punti: c.punti,
      url: c.esempio.url, metodo: c.esempio.metodo, stato: c.esempio.stato, mime: c.esempio.mime,
      dimensione: c.esempio.dimensione, postData: c.esempio.postData, intestazioni: c.esempio.intestazioni,
      esempio: c.esempio.corpo,
    })),
    websocket: socketLista,
    eventiServer: d.sse,
    indirizziNeiScript: d.indirizziScript.slice(0, 40),
    richieste: tutte.slice(0, 150).map((r) => ({
      tipo: r.tipo, metodo: r.metodo, url: r.url, stato: r.stato, mime: r.mime, dimensione: r.dimensione,
      t0: r.t0, errore: r.errore || null,
    })),
    totaleRichieste: tutte.length,
    bloccate: d.bloccate,
    console: d.consoleRighe,
    schermata: d.schermata,
  };
  rapporto.testo = rapportoInTesto(rapporto);
  return rapporto;
}

/** Il rapporto in forma di testo breve, da copiare e incollare in chat. */
function rapportoInTesto(r) {
  const L = [];
  L.push(`== ISPEZIONE (${r.vista}, ${r.secondi}s) ==`);
  L.push(`pagina: ${r.pagina.finale}`);
  L.push(`titolo: ${r.pagina.titolo || "(nessuno)"}${r.pagina.caricata ? "" : "  [la pagina non ha finito di caricare]"}`);
  L.push(`richieste totali: ${r.totaleRichieste}${r.bloccate ? ` · bloccate per sicurezza: ${r.bloccate}` : ""}`);
  L.push("");
  L.push(`== TESTO VISIBILE (righe di tabella: ${r.righeTabella}) ==`);
  L.push(taglia(r.testoVisibile || "(vuota)", 900));
  L.push("");
  L.push("== CANDIDATI DATI (richieste che sembrano portare la classifica) ==");
  if (!r.candidati.length) L.push("(nessuno trovato)");
  r.candidati.forEach((c, i) => {
    L.push(`[${i + 1}] ${c.richiesta}`);
    L.push(`    ${c.volte} volte${c.ogniSecondi != null ? `, ogni ~${c.ogniSecondi}s` : ""} · stato ${c.stato} · ${c.mime || "?"} · ${c.dimensione != null ? c.dimensione + " byte" : "?"}`);
    L.push(`    url esempio: ${c.url}`);
    const ih = Object.entries(c.intestazioni || {}).map(([k, v]) => `${k}: ${v}`).join(" | ");
    if (ih) L.push(`    intestazioni: ${taglia(ih, 300)}`);
    if (c.postData) L.push(`    corpo inviato: ${c.postData}`);
    if (c.esempio) L.push(`    risposta (inizio): ${taglia(c.esempio, 700)}`);
  });
  L.push("");
  L.push("== WEBSOCKET ==");
  if (!r.websocket.length) L.push("(nessuno)");
  r.websocket.forEach((s, i) => {
    L.push(`[${i + 1}] ${s.url} · ricevuti ${s.ricevuti}, inviati ${s.inviati}${s.chiuso ? " · chiuso" : ""}`);
    s.frame.slice(0, 6).forEach((f) => L.push(`    ${f.dir} ${taglia(f.dati, 300)}`));
  });
  if (r.eventiServer.length) {
    L.push("");
    L.push("== EVENTI DAL SERVER (SSE) ==");
    r.eventiServer.slice(0, 5).forEach((e) => L.push(`    ${e.evento || ""} ${taglia(e.dati, 300)}`));
  }
  L.push("");
  L.push("== INDIRIZZI TROVATI NEI FILE SCRIPT ==");
  L.push(r.indirizziNeiScript.length ? r.indirizziNeiScript.join("\n") : "(nessuno)");
  L.push("");
  L.push("== ALTRE RICHIESTE (le prime 50) ==");
  r.richieste.filter((q) => !["Image", "Stylesheet", "Font", "Media"].includes(q.tipo)).slice(0, 50)
    .forEach((q) => L.push(`${q.metodo} ${q.tipo} ${q.stato == null ? "-" : q.stato} ${taglia(q.url, 160)}${q.errore ? " [" + q.errore + "]" : ""}`));
  if (r.console.length) {
    L.push("");
    L.push("== CONSOLE ==");
    L.push(r.console.slice(0, 15).join("\n"));
  }
  return taglia(L.join("\n"), 26000);
}

module.exports = { ispeziona, rapportoInTesto, _test: { chiaveRichiesta, sembraDato, trovaIndirizzi } };
