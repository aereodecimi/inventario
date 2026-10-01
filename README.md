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

## Sincronizzazione automatica con Firebase

Firebase salva l’inventario in un database cloud privato e lo aggiorna automaticamente su tutti i dispositivi autorizzati con il tuo account Google. La configurazione Firebase è pubblica per definizione e non concede accesso ai dati: la privacy è garantita dalle regole Firestore e dal login con Google.

### Configurazione iniziale

1. Apri [Firebase Console](https://console.firebase.google.com/) e crea un progetto `Inventario` con il piano gratuito Spark.
2. Nel progetto, premi l’icona **Web** (`</>`) e registra una nuova app web. Copia l’oggetto `firebaseConfig` proposto da Firebase.
3. Apri **Build → Authentication → Sign-in method**, abilita **Google** e salva.
4. Apri **Build → Firestore Database**, crea il database in modalità Production e scegli una regione europea.
5. In **Firestore Database → Rules**, sostituisci le regole con queste e pubblicale:

   ```text
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /inventories/{userId} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```

6. In **Authentication → Settings → Authorized domains**, aggiungi il dominio del sito GitHub Pages, ad esempio `tuo-nome-utente.github.io`.
7. Apri l’app, vai in **Admin → Dati**, incolla l’intero oggetto `firebaseConfig` e premi **Collega Firebase**. Nel popup scegli il tuo account Google.

L’account Google viene memorizzato dal browser del dispositivo: dopo il primo collegamento, l’Operatore non deve accedere ogni giorno. Su un nuovo dispositivo l’Admin collega una sola volta il proprio account Google; da allora i dati si sincronizzano in tempo reale. Mantieni comunque un backup JSON periodico.
