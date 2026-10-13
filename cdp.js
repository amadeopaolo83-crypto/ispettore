// Un piccolo client per il protocollo di controllo di Chrome (CDP), senza
// librerie esterne: usa il WebSocket integrato in Node 22. Serve a pilotare
// un Chrome senza schermo e a ricevere gli eventi di rete della pagina.

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.attese = new Map();
    this.ascoltatori = new Map();
    this.chiuso = false;
  }

  connetti(timeoutMs = 8000) {
    return new Promise((ok, no) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const t = setTimeout(() => no(new Error("Chrome non risponde")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); ok(); });
      ws.addEventListener("error", () => { clearTimeout(t); no(new Error("collegamento a Chrome non riuscito")); });
      ws.addEventListener("close", () => {
        this.chiuso = true;
        for (const [, a] of this.attese) a.no(new Error("Chrome si e' chiuso"));
        this.attese.clear();
      });
      ws.addEventListener("message", (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch (e) { return; }
        if (m.id && this.attese.has(m.id)) {
          const a = this.attese.get(m.id);
          this.attese.delete(m.id);
          if (m.error) a.no(new Error(`${a.metodo}: ${m.error.message}`));
          else a.ok(m.result || {});
        } else if (m.method) {
          const l = this.ascoltatori.get(m.method);
          if (l) for (const f of l) { try { f(m.params || {}); } catch (e) { /* un ascoltatore non deve fermare gli altri */ } }
        }
      });
    });
  }

  send(metodo, params = {}, timeoutMs = 15000) {
    if (this.chiuso) return Promise.reject(new Error("Chrome si e' chiuso"));
    const id = ++this.id;
    return new Promise((ok, no) => {
      const t = setTimeout(() => { this.attese.delete(id); no(new Error(`${metodo}: nessuna risposta`)); }, timeoutMs);
      this.attese.set(id, { ok: (r) => { clearTimeout(t); ok(r); }, no: (e) => { clearTimeout(t); no(e); }, metodo });
      this.ws.send(JSON.stringify({ id, method: metodo, params }));
    });
  }

  on(metodo, f) {
    if (!this.ascoltatori.has(metodo)) this.ascoltatori.set(metodo, []);
    this.ascoltatori.get(metodo).push(f);
  }

  chiudi() {
    try { this.ws.close(); } catch (e) { /* gia' chiuso */ }
  }
}

module.exports = { Cdp };
