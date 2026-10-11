# Design Brief — Sprint board

## Perché

Con un team numeroso nessuno ha la vista d'insieme dello sprint: Jira è dispersivo e per capire
"come stiamo" servono molti clic. ZuGit è già aperto tutto il giorno, quindi una scheda **Sprint**
compatta, con i segnali delle PR che Jira non ha e le azioni di tutti i giorni a portata di mano,
evita di aprire Jira per la maggior parte delle cose.

È per tutto il team, non solo per PO/PM.

---

## Cosa c'è

### 1. Board compatta

- Una pillola per storia: **faccina, chiave, punti** e un pallino con lo stato della PR.
  Il titolo è nel tooltip; l'interruttore **Titoli** mostra le pillole come righe con il titolo.
- Le colonne sono quelle della board Jira (configurazione della board: stati raggruppati come in Jira).
- Due viste:
  - **Stato** — una colonna per colonna Jira;
  - **Persone** — una riga per persona, con il carico in punti ancora aperti.
- Intestazione: board e sprint (selettore quando ce n'è più di uno), giorno dello sprint,
  avanzamento in punti con una tacca su "dove dovremmo essere oggi", filtro per persona
  (le faccine), ricerca.
- Le mie storie hanno il bordo viola.
- **Flag di Jira**: si vede come informazione (flag azzurro), mai come "bloccata": ogni team lo usa a
  modo suo (es. "in test"). Il nome si sceglie per board — "Flag", "In test" o un altro — dal menu
  della board/sprint in alto, dal campo Flag del dettaglio o col tasto destro su una card col flag.
- **Barra di avanzamento**: verde = punti chiusi sul totale; tacca = dove saremmo oggi a ritmo
  costante (giorni lavorativi passati; il giorno in corso conta metà, a sprint finito è tutto).
- Pallino PR, dai dati già caricati da ZuGit: verde approvata, giallo modifiche richieste o in
  attesa da più di due giorni, rosso CI fallita.

### 2. Dettaglio della storia

Pannello laterale a destra, la board resta visibile.

- Titolo, **stato** (menu con le transizioni del workflow), **assegnatario**, **punti**,
  **categoria**; in sola lettura epic, fix version, priorità, etichette.
- **Pull request** collegate (review, CI, diff): un clic apre il diff in ZuGit.
- **Checklist** (la stessa che ZuGit già legge e scrive per le draft PR).
- **Descrizione** formattata: l'ADF di Jira è convertito in HTML da ZuGit (niente HTML di Jira
  iniettato), i link si aprono nel browser. Le **immagini** si vedono nel testo e nei commenti: il
  backend le scarica con il token (il webview non può) e il pannello le mostra; un clic le apre a
  schermo intero, con ← / → tra le immagini della storia.
- **Allegati**: le immagini in griglia, gli altri file (PDF, HEIC…) in elenco, apribili nel browser.
- **Sottotask**, **commenti** e nuovo commento.
- ↑/↓ (o j/k) passa alla storia precedente/successiva, Esc chiude, "Apri in Jira" per il resto.
- **Larghezza regolabile**: si trascina il bordo sinistro (doppio clic per tornare a quella standard).
  La larghezza resta in memoria; il pannello non supera mai il 90% della finestra, così passando a
  uno schermo più piccolo non esce dai bordi e tornando su quello grande ritrova la sua misura.

### 3. Drag & drop

- Implementato con pointer events, non con il drag & drop HTML5 (su Windows la finestra Tauri
  intercetta i drop per i file).
- Vista **Stato**: trascinare tra colonne esegue la transizione. Appena si inizia a trascinare,
  ZuGit legge le transizioni della storia e spegne le colonne non raggiungibili dal workflow.
- Vista **Persone**: in orizzontale cambia lo stato, in verticale l'assegnatario.
- Più transizioni verso la stessa colonna: un menu per scegliere. Una transizione che chiede
  campi (es. risoluzione) non si esegue da ZuGit: lo dice e offre "Apri in Jira".
- Ottimistico, con **Annulla** per qualche secondo. Se Jira rifiuta, la storia torna al suo
  posto e il messaggio spiega perché.
- Trascinare una storia selezionata sposta tutta la selezione.

### 4. Selezione e categorie

- ⌘-clic (Ctrl-clic su Windows) seleziona; una barra in basso offre **Categoria**,
  **Assegna**, **Stato**.
- **Categorie personali** (es. "Attività ricorrenti"): nome, colore e storie, salvate in locale
  (`sprint-categories.json` nella cartella dati di ZuGit). Sono legate alla chiave della storia,
  quindi restano valide sprint dopo sprint.
- Le storie in una categoria **spariscono dalla board, dai totali e dal riepilogo**. Il chip della
  categoria nell'intestazione apre il pannello con l'elenco; lo stato non conta.
- Una storia che esce dallo sprint **resta ricordata ma non si vede**: le ricorrenti passano da uno
  sprint all'altro, e appena rientrano tornano nella categoria senza rifare niente. In fondo
  all'elenco una riga chiusa ("N ricordate, fuori da questo sprint") le mostra; da lì si tolgono una
  per una o con "Togli le N chiuse" (concluse su Jira o non più trovate).
- Il pulsante **Categorie** nell'intestazione c'è sempre (anche prima della prima categoria): spiega a
  cosa servono, ne crea una e la apre.
- Si aggiunge una storia a una categoria dalla barra di selezione, dal dettaglio, col tasto destro
  sulla card o trascinandola sul chip. Dal pannello si rinomina, si cambia colore, si elimina, si
  riporta una storia sulla board.

### 5. Riepilogo standup

Una striscia sopra la board: *Da ieri 8:00 · 3 chiuse · 2 avanzate · 1 riassegnata | Da sbloccare ·
2 CI rossa*, espandibile. L'orario dello standup si cambia dalla striscia (vale per persona).

- **Cosa è cambiato** (cronologia Jira delle storie dello sprint): chiuse, avanzate, tornate
  indietro, entrate nello sprint, con flag, riassegnate, stime cambiate — al netto: una storia andata
  e tornata non è una novità.
- **Da sbloccare** (stato attuale delle PR): CI fallita, modifiche richieste, review in attesa.
- "Da" = standup del giorno lavorativo precedente (il lunedì vale venerdì).
- **Evidenzia sulla board**: le storie cambiate restano in evidenza e dicono cosa è successo, le altre
  si attenuano; nella vista Persone diventa la scaletta dello standup, persona per persona.

---

## Dati (Rust, `sprint.rs`)

| Cosa | Endpoint |
|---|---|
| Board dei progetti configurati | `GET /rest/agile/1.0/board?projectKeyOrId=` |
| Colonne e campo di stima | `GET /rest/agile/1.0/board/{id}/configuration` |
| Sprint attivi | `GET /rest/agile/1.0/board/{id}/sprint?state=active` |
| Storie dello sprint (filtro della board, senza sottotask) | `GET /rest/agile/1.0/board/{id}/sprint/{id}/issue` |
| Categoria degli stati | `GET /rest/api/3/status` |
| Transizioni | `GET`/`POST /rest/api/3/issue/{key}/transitions` |
| Assegnatario / persone assegnabili | `PUT /rest/api/3/issue/{key}/assignee`, `GET /rest/api/3/user/assignable/search` |
| Punti | `PUT /rest/api/3/issue/{key}` |
| Dettaglio, commenti | `GET /rest/api/3/issue/{key}`, `POST …/comment` |
| Permessi | `GET /rest/api/3/mypermissions` |
| Riepilogo | `GET /rest/api/3/search/jql?expand=changelog` (storie aggiornate da allora) |

- **Permessi**: la board si adatta. Senza "Transition issues" non si trascina tra colonne, senza
  "Assign issues" non si riassegna, senza "Edit issues" i punti sono in sola lettura, senza
  "Add comments" niente commento.
- **Token**: bastano gli scope classici già consigliati nelle Settings (`read:jira-work`,
  `write:jira-work`, `read:jira-user`); solo con gli scope granulari servirebbero anche
  `read:board-scope:jira-software` e `read:sprint:jira-software`.
- **Faccine**: gli avatar Jira arrivano da `secure.gravatar.com` / `*.atl-paas.net`, aggiunti alla
  CSP solo per le immagini; se non si caricano, restano le iniziali.

---

## Fasi

1. Board in lettura: viste, filtri, segnali PR.
2. Categorie e selezione multipla.
3. Pannello di dettaglio.
4. Drag & drop e azioni rapide.
5. Riepilogo standup.

Dopo: strumenti MCP (`sprint_get_board`, `sprint_get_standup`), lo sprint successivo per il
planning, categorie esportabili/condivise.

## Decisioni prese

- **Categorie locali**: i dev non hanno per forza il permesso di modificare le storie. Se un giorno
  si vorranno condivise (proprietà nascosta della issue o label), lo store è isolato in un punto.
- **Riassegnare trascinando** tra le righe della vista Persone, con Annulla.
- **Dettaglio**: lettura completa più azioni rapide; il resto con "Apri in Jira".
- Nessun riordino (rank) dentro una colonna: l'ordine è quello di Jira.
- I sottotask non sono pillole: si vedono nel dettaglio.

## Da decidere insieme

- Colonna Done compressa di default?
- Nome e posizione della scheda (ora "Sprint", dopo "List").
