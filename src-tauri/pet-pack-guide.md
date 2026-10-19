# Pacchetto personaggio per ZuGit

Questo zip è il Tiny King, il personaggio che ZuGit mostra in modalità meme.
Usalo come riferimento per crearne uno tuo, poi caricalo da
**Impostazioni → Fun → Load character…**. Per tornare al Tiny King c'è
**Back to Tiny King**.

Il pacchetto resta solo sul tuo computer: per darlo a un collega, passagli lo zip.

## Cosa contiene

- `manifest.json`: il nome del personaggio, la dimensione delle celle e, per ogni
  animazione (clip), lo sheet e la durata di ogni frame.
- Gli sheet, PNG o WebP, con sfondo trasparente: i frame di una clip affiancati in una
  griglia, letti da sinistra a destra e poi riga per riga.

Lo zip può avere `manifest.json` in cima oppure dentro un'unica cartella.
Sono ammessi PNG e WebP non animati; massimo 64 MB in tutto e 16 MB per immagine.
Il Tiny King usa WebP lossy (qualità 100): pesa circa un terzo dei PNG e la
differenza non si vede.

## manifest.json

```json
{
  "format": "zugit-pet",
  "version": 1,
  "name": "Tiny King",
  "cell": { "width": 288, "height": 384 },
  "columns": 4,
  "walk": { "step": 6, "hidden": 264 },
  "clips": {
    "idle": { "sheet": "idle.webp", "durations": [900, 160, 180, 70, 110, 80, 160, 400] }
  }
}
```

- `cell`: la dimensione di un frame in pixel, da 16 a 1024. Sullo schermo il
  personaggio è alto 184 px, e la larghezza segue le proporzioni della cella.
- `columns`: quanti frame per riga negli sheet.
- `durations`: un numero per frame, in millisecondi, da 10 a 10000.
- `walk` (facoltativo):
  - `step`: di quanti pixel della cella avanza a ogni frame di camminata. È lo
    scorrimento del piede d'appoggio tra un frame e l'altro: con il valore
    giusto i piedi non scivolano. Senza `step`, vale 1/48 della larghezza
    della cella.
  - `hidden`: di quanti pixel va spostato a destra perché nessuna parte del
    personaggio resti visibile. Senza `hidden`, vale la larghezza della cella.

## Le clip

Obbligatorie:

| Clip | Cosa fa |
|---|---|
| `idle` | Respiro da fermo, frontale |
| `pr_merged` | Festeggia (PR mergiata) |
| `ci_failed` | Si dispera (CI rossa, modifiche richieste) |
| `review_wait` | Bussa (review da fare, nuovi commenti, promemoria) |
| `walk_neutral_left` | Camminata sul posto verso sinistra, in loop |
| `walk_stop_neutral_left` | Si ferma: dal frame centrale della camminata alla posa di riposo |
| `walk_start_neutral` | Riparte verso destra: dalla posa di riposo al frame che precede il primo della camminata |
| `walk_neutral` | Camminata sul posto verso destra, in loop |

Facoltative, per ogni umore (`angry`, `impatient`, `happy`):

| Clip | Cosa fa |
|---|---|
| `change_neutral_to_<umore>_left` | All'arrivo, la faccia passa da neutra all'umore |
| `walk_start_<umore>`, `walk_<umore>` | Esce verso destra con quell'umore |

Se mancano, il personaggio resta neutro. Gli umori: merge → `happy`,
CI rossa e modifiche richieste → `angry`, review e commenti → `impatient`.

## Regole perché i passaggi siano fluidi

1. `idle`, `pr_merged`, `ci_failed` e `review_wait` iniziano e finiscono sullo
   stesso frame frontale, così si possono concatenare.
2. Le camminate sono sul posto: il personaggio non si sposta dentro la cella,
   lo sposta ZuGit.
3. `walk_stop_neutral_left` inizia con lo stesso frame della camminata a metà
   ciclo (il frame 4 di 8), cioè un appoggio.
4. `walk_start_*` finisce sul frame che precede il frame 0 della sua camminata.
5. I piedi poggiano sempre alla stessa altezza in tutte le clip.
6. Tra la posa di profilo e quella frontale ZuGit fa una breve dissolvenza,
   quindi le due pose non devono coincidere.

## Un prompt per farselo generare

Allega questo zip e una tua foto, poi chiedi a Codex o ChatGPT qualcosa come:

> Crea un pacchetto personaggio per ZuGit con lo stesso formato e le stesse
> clip del Tiny King allegato (leggi GUIDE.md e manifest.json). Il personaggio
> è una versione cartoon in stile giocattolo 3D della persona nella foto
> allegata: riconoscibile da forme e tratti, mai con la foto incollata.
> Celle 288 × 384 trasparenti, piedi sempre alla stessa altezza, stesso numero
> di frame e stessi tempi del Tiny King. Rispetta le regole sui passaggi: frame
> di inizio e fine identici dove indicato, camminate sul posto. Consegna uno
> zip con manifest.json e gli sheet (PNG o WebP), verificando che ogni sheet abbia le
> dimensioni dichiarate.
