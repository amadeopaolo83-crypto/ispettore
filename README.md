# PitIspettore

Un **browser per sviluppatori in cloud**, pensato per il telefono. Serve quando un
sito di live timing nuovo va "insegnato" al ponte (PitPonte): si incolla
l'indirizzo della pagina e un Chrome senza schermo la apre, la lascia girare e
mostra quello che carica, come la scheda *Rete* degli strumenti da sviluppatore.

Cosa ricevi:
- il **testo visibile** sulla pagina e quante righe di tabella ha (anche quando la
  tabella è riempita dopo da JavaScript);
- i **candidati dati**: le richieste che sembrano portare la classifica, con
  quante volte vengono ripetute, ogni quanti secondi e l'inizio della risposta;
- i **websocket** con i primi messaggi, gli indirizzi trovati negli script,
  l'elenco di tutte le richieste e un'immagine della pagina;
- un pulsante **Copia il rapporto per Claude**: un unico testo da incollare in chat.

## 1. Pubblicare (tutto dal telefono)

Conviene un **repository nuovo** (per esempio `ispettore`, anche pubblico: il
token non è nel codice), così "Upload files" carica tutto nella radice.

1. Su GitHub crea il repository e carica **tutti i file** con *Add file → Upload files*:
   `package.json`, `server.js`, `ispezione.js`, `cdp.js`, `sicurezza.js`,
   `pagina.html`, `README.md`.
2. Su Render: **New + → Web Service**, scegli il repository.
   **Runtime** `Node`, **Build Command** `npm install`, **Start Command** `npm start`.
3. In **Environment** aggiungi:
   - `ISPETTORE_TOKEN` = una parola d'ordine (anche la stessa del ponte: se non
     la imposti, il servizio usa `BRIDGE_TOKEN`);
   - `NODE_VERSION` = `22`.
4. Attendi *Live*. L'indirizzo è del tipo `https://ispettore-xxxx.onrender.com`.

**Non** impostare mai `ISPETTORE_PROVA_LOCALE` e `CHROME_PATH` su Render: servono
solo per le prove sul proprio computer.

## 2. Usarlo

1. Sveglia il servizio aprendo `/api/salute` (può servire fino a un minuto).
2. Apri la pagina principale, scrivi il **token** (viene ricordato), incolla
   l'indirizzo del live timing e premi **Ispeziona**.
3. Lascialo girare 15–25 secondi: serve a vedere le richieste che la pagina ripete.
4. **Copia il rapporto per Claude** e incollalo in chat.

Suggerimenti: se i candidati sono vuoti prova **Telefono** al posto di
**Computer** nella vista, oppure aumenta i secondi.

## 3. Sicurezza

- Senza token lo strumento è spento.
- Rifiuta indirizzi privati o interni (anche se un nome pubblico punta a uno
  interno) sia per la pagina sia per ogni richiesta che la pagina fa. Un
  websocket verso una rete interna ferma l'ispezione.
- Un'ispezione alla volta, tempo massimo 75 secondi, poi Chrome viene spento.
- Dal rapporto sono esclusi cookie e intestazioni di autorizzazione.

## 4. Piano gratuito di Render

Chrome è pesante: il piano gratuito ha poca memoria e il servizio può andare in
errore su pagine molto grandi. Per l'uso di preparazione di una gara di solito
basta; se serve, si passa per qualche ora a un piano a pagamento e poi si torna
indietro. **Va provato in anticipo**, non il giorno della gara.

| Problema | Cosa controllare |
|---|---|
| `token mancante o errato` | Il token nella pagina è diverso da `ISPETTORE_TOKEN` (o da `BRIDGE_TOKEN`). |
| `strumento spento` | Su Render manca `ISPETTORE_TOKEN` (e `BRIDGE_TOKEN`). |
| `Chrome non si è avviato` / `non risponde` | Guarda i *Logs* su Render: di solito è memoria o il pacchetto `@sparticuz/chromium` non installato. Mandami le ultime righe. |
| `indirizzo non consentito` | L'indirizzo è interno o non esiste. |
| `un'altra ispezione è in corso` | Aspetta qualche secondo e riprova. |
