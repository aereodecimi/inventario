# Inventario — PWA locale

Prima versione statica dell’inventario: funziona offline dopo la prima apertura, conserva i dati nel browser tramite IndexedDB ed è pensata per un catalogo di circa 200 prodotti.

## Cosa fa

- Apertura diretta in modalità **Operatore**, senza password.
- Ricerca per nome, marca o EAN e lettura di scanner barcode HID: nella schermata principale basta scansionare; il codice seguito da Invio apre automaticamente la schermata che permette di scegliere **Vendita** o **Utilizzo banco**.
- Movimenti: Vendita, Utilizzo banco, Carico e Rettifica. Vendita e utilizzo diminuiscono la quantità; carico la aumenta; rettifica imposta la quantità desiderata.
- Avvisi di scorta bassa nella home Operatore. La soglia è configurabile dall’Admin e parte da 3 pezzi.
- Area **Admin** protetta da password: al primo accesso imposta la password. Permette di inserire, modificare e archiviare prodotti, consultare i movimenti, esportare CSV e backup JSON, e ripristinare un backup.
- Riepilogo Admin con prodotti attivi, pezzi disponibili, valore di acquisto/pubblico e lista dei prodotti da riordinare.
- Importazione CSV: accetta il CSV esportato dall’app. Se un EAN esiste già, aggiorna quel prodotto e conserva lo storico dei movimenti.
- Campi: EAN, nome, marca, prezzo pubblico, prezzo acquisto, dosaggio, quantità e note. L’EAN non può essere duplicato.

I dati non vengono inviati a un server. La password serve a evitare modifiche involontarie sul dispositivo: non è una protezione equivalente a un sistema con account su server. Conserva backup regolari, soprattutto prima di aggiornare o cancellare i dati del browser.

## Prova locale

Un service worker non funziona aprendo direttamente `index.html`: avvia un piccolo server nella cartella del progetto, ad esempio:

```bash
python3 -m http.server 8080
```

Poi visita [http://localhost:8080](http://localhost:8080). Per verificare l’offline, apri la pagina una volta, quindi disattiva la rete e ricarica.

## Pubblicazione su GitHub Pages

1. Crea un repository GitHub e carica tutti i file di questa cartella nella radice del repository.
2. In GitHub vai in **Settings → Pages**.
3. In “Build and deployment”, seleziona **Deploy from a branch**, poi il branch `main` e la cartella `/(root)`, quindi salva.
4. Apri l’indirizzo mostrato da GitHub Pages. Da quel momento l’app può essere installata dal browser su telefono o computer.

Il progetto usa percorsi relativi (`./`), quindi è compatibile anche con il tipico indirizzo `https://utente.github.io/nome-repository/`.

## Sincronizzazione automatica con Google Drive

La sincronizzazione è privata: l’Admin sceglie il proprio account Google nel consenso di Google. L’app richiede il solo permesso `drive.file`, quindi può gestire i file che crea; crea e aggiorna un backup chiamato `inventario-backup.json` nella cartella privata `Inventario PWA`.

### Configurazione iniziale

1. Apri [Google Cloud Console](https://console.cloud.google.com/) con il tuo account Google e crea un nuovo progetto, ad esempio `Inventario`.
2. In **API e servizi → Libreria**, cerca e abilita **Google Drive API**.
3. In **Google Auth platform**, configura la schermata di consenso. Seleziona **External** e, mentre l’app è in test, aggiungi come test user soltanto il tuo indirizzo Gmail.
4. In **Client**, crea un Client ID OAuth 2.0 di tipo **Web application**.
5. In **Authorized JavaScript origins**, aggiungi gli indirizzi da cui aprirai l’app, per esempio:

   ```text
   http://localhost:8080
   https://TUO-NOME-UTENTE.github.io
   ```

   Il secondo indirizzo non deve includere il nome del repository. Se usi una porta locale diversa, sostituisci `8080` con la tua.
6. Copia il **Client ID** (termina con `.apps.googleusercontent.com`). Non inserire né creare un client secret nel sito.
7. Nell’app vai in **Admin → Dati**, incolla il Client ID e premi **Collega Google Drive**. Nel popup scegli esclusivamente il tuo account Google e autorizza l’accesso.

Da quel momento ogni modifica a prodotti, movimenti, soglia o importazione CSV aggiorna automaticamente il backup cloud. La prima connessione su un altro dispositivo recupera il backup più recente.

Google rilascia token di accesso temporanei alle app eseguite nel browser. Se l’app resta chiusa a lungo o il token scade, in **Admin → Dati** apparirà “Da ricollegare in questa sessione”: premi **Ricollega Google Drive**. Dopo la riconnessione, le modifiche tornano a essere automatiche.

Non modificare contemporaneamente l’inventario su più dispositivi quando sono offline: il dispositivo con la modifica più recente può sostituire il backup cloud alla sincronizzazione successiva.
