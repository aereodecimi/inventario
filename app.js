/* Inventario v1 — nessuna dipendenza esterna */
const DB_NAME = 'inventario-pwa';
const DB_VERSION = 1;
const app = document.querySelector('#app');
const adminButton = document.querySelector('#admin-button');
const toastEl = document.querySelector('#toast');
let db;
let isAdmin = false;
let scanBuffer = '';
let scanTimer;
let driveAccessToken = '';
let driveTokenExpiresAt = 0;
let driveSyncTimer;
let driveSyncRunning = false;
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
let firebaseAppInstance;
let firebaseAuth;
let firebaseDb;
let firebaseUser;
let firebaseUnsubscribe;
let firebaseSyncTimer;
let firebaseSyncRunning = false;

const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const money = value => new Intl.NumberFormat('it-IT', {style:'currency', currency:'EUR'}).format(Number(value || 0));
const dateTime = value => new Intl.DateTimeFormat('it-IT', {dateStyle:'short', timeStyle:'short'}).format(new Date(value));
const id = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const DEFAULT_ADMIN_PASSWORD_HASH = '631cd7b31358c28c7b5fd3ca7d6dbac65d9f438b0fb64e1c098a83a28f0d2a61';

function toast(message) { toastEl.textContent = message; toastEl.classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => toastEl.classList.remove('visible'), 2600); }
function driveStatus(message, isError = false) { const element=document.querySelector('#drive-status'); if (!element) return; element.textContent=message; element.classList.toggle('error',isError); }
function firebaseStatus(message, isError = false) { const element=document.querySelector('#firebase-status'); if (!element) return; element.textContent=message; element.classList.toggle('error',isError); }

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const products = database.createObjectStore('products', {keyPath:'id'});
      products.createIndex('ean', 'ean', {unique:true});
      products.createIndex('name', 'name');
      const moves = database.createObjectStore('movements', {keyPath:'id'});
      moves.createIndex('productId', 'productId');
      moves.createIndex('date', 'date');
      database.createObjectStore('settings', {keyPath:'key'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function store(name, mode = 'readonly') { return db.transaction(name, mode).objectStore(name); }
function req(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
const getSetting = async key => (await req(store('settings').get(key)))?.value;
const putSetting = async (key, value) => req(store('settings','readwrite').put({key,value}));
const allProducts = () => req(store('products').getAll());
const getProduct = productId => req(store('products').get(productId));
const allMoves = () => req(store('movements').getAll());
async function lowStockThreshold() {
  const value = Number(await getSetting('lowStockThreshold'));
  return Number.isInteger(value) && value >= 0 ? value : 3;
}

function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  const existing=document.querySelector('script[data-google-identity]');
  if (existing) return new Promise((resolve,reject)=>{ existing.addEventListener('load',resolve,{once:true}); existing.addEventListener('error',()=>reject(new Error('Impossibile caricare Google Identity Services.')),{once:true}); });
  return new Promise((resolve,reject)=>{ const script=document.createElement('script'); script.src='https://accounts.google.com/gsi/client'; script.async=true; script.defer=true; script.dataset.googleIdentity='true'; script.onload=resolve; script.onerror=()=>reject(new Error('Impossibile caricare Google Identity Services.')); document.head.append(script); });
}
async function authorizeDrive(interactive) {
  const clientId=await getSetting('driveClientId');
  if (!clientId) throw new Error('Inserisci il Client ID Google.');
  if (driveAccessToken && Date.now() < driveTokenExpiresAt - 60000) return driveAccessToken;
  await loadGoogleIdentity();
  return new Promise((resolve,reject)=>{
    const client=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:DRIVE_SCOPE,callback:response=>{
      if (response.error || !response.access_token) { reject(new Error(response.error_description || 'Autorizzazione Google non completata.')); return; }
      driveAccessToken=response.access_token; driveTokenExpiresAt=Date.now()+Number(response.expires_in||3600)*1000; resolve(driveAccessToken);
    }});
    client.requestAccessToken({prompt:interactive ? 'consent' : ''});
  });
}
async function driveFetch(url, options = {}) {
  if (!driveAccessToken || Date.now() >= driveTokenExpiresAt - 60000) throw new Error('Collega di nuovo Google Drive per continuare la sincronizzazione.');
  const response=await fetch(url,{...options,headers:{Authorization:`Bearer ${driveAccessToken}`,...(options.headers||{})}});
  if (!response.ok) throw new Error(`Google Drive: ${response.status} ${await response.text()}`);
  return response;
}
async function driveFolderId() {
  const saved=await getSetting('driveFolderId');
  if (saved) return saved;
  const query=encodeURIComponent("name = 'Inventario PWA' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
  const found=await (await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,name)`)).json();
  let folderId=found.files?.[0]?.id;
  if (!folderId) { const created=await (await driveFetch('https://www.googleapis.com/drive/v3/files',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Inventario PWA',mimeType:'application/vnd.google-apps.folder'})})).json(); folderId=created.id; }
  await putSetting('driveFolderId',folderId); return folderId;
}
async function driveBackupFileId() {
  const saved=await getSetting('driveBackupFileId');
  if (saved) return saved;
  const folderId=await driveFolderId();
  const query=encodeURIComponent(`name = 'inventario-backup.json' and '${folderId}' in parents and trashed = false`);
  const found=await (await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,modifiedTime)`)).json();
  const fileId=found.files?.[0]?.id || '';
  if (fileId) await putSetting('driveBackupFileId',fileId);
  return fileId;
}
async function backupPayload() { return {version:1,exportedAt:new Date().toISOString(),products:await allProducts(),movements:await allMoves(),settings:await req(store('settings').getAll())}; }
async function syncDriveNow() {
  if (driveSyncRunning) return;
  driveSyncRunning=true;
  try {
    const folderId=await driveFolderId(); let fileId=await driveBackupFileId(); const backup=await backupPayload(); const boundary=`inventario-${id()}`;
    const metadata={name:'inventario-backup.json',mimeType:'application/json',parents:[folderId]};
    const body=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,JSON.stringify(backup),`\r\n--${boundary}--`],{type:`multipart/related; boundary=${boundary}`});
    const url=fileId?`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`:'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime';
    const saved=await (await driveFetch(url,{method:fileId?'PATCH':'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body})).json();
    fileId=saved.id; await putSetting('driveBackupFileId',fileId); await putSetting('driveLastSyncAt',backup.exportedAt); driveStatus(`Sincronizzato su Google Drive alle ${dateTime(backup.exportedAt)}.`); return saved;
  } catch (error) { driveStatus(error.message || 'Sincronizzazione non riuscita.',true); throw error; }
  finally { driveSyncRunning=false; }
}
function queueDriveSync() { clearTimeout(driveSyncTimer); if (!driveAccessToken || Date.now() >= driveTokenExpiresAt - 60000) return; driveSyncTimer=setTimeout(()=>syncDriveNow().catch(()=>{}),500); }
async function latestLocalDate() { const products=await allProducts(); const moves=await allMoves(); return Math.max(0,...products.map(product=>Date.parse(product.updatedAt||product.createdAt||0)||0),...moves.map(move=>Date.parse(move.date||0)||0)); }
async function restoreBackupData(backup) { if (!Array.isArray(backup.products)||!Array.isArray(backup.movements)||!Array.isArray(backup.settings)) throw new Error('Il file non sembra un backup valido.'); const tx=db.transaction(['products','movements','settings'],'readwrite'); ['products','movements','settings'].forEach(name=>tx.objectStore(name).clear()); backup.products.forEach(product=>tx.objectStore('products').put(product)); backup.movements.forEach(move=>tx.objectStore('movements').put(move)); backup.settings.forEach(setting=>tx.objectStore('settings').put(setting)); await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)}); }
async function pullDriveBackupIfNewer() {
  const fileId=await driveBackupFileId(); if (!fileId) return false;
  const backup=await (await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`)).json();
  if (!backup.exportedAt || Date.parse(backup.exportedAt) <= await latestLocalDate()) return false;
  await restoreBackupData(backup); driveStatus(`Dati aggiornati dal cloud (${dateTime(backup.exportedAt)}).`); return true;
}
async function connectDrive(clientId) {
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Il Client ID Google non è valido.');
  await putSetting('driveClientId',clientId); driveStatus('Connessione a Google Drive…'); await authorizeDrive(true); await putSetting('driveSyncEnabled',true); const downloaded=await pullDriveBackupIfNewer(); await syncDriveNow(); return downloaded;
}

function parseFirebaseConfig(text) {
  let config={};
  const start=text.indexOf('{'); const end=text.lastIndexOf('}');
  const objectText=start >= 0 && end > start ? text.slice(start,end+1) : text.trim();
  const cleaned=objectText.replace(/([,{]\s*)([A-Za-z_$][\w$]*)(\s*:)/g,'$1"$2"$3');
  try { config=JSON.parse(cleaned); } catch {
    ['apiKey','authDomain','projectId','storageBucket','messagingSenderId','appId','measurementId'].forEach(key => {
      const match=objectText.match(new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`));
      if (match) config[key]=match[1];
    });
  }
  if (!config.apiKey || !config.authDomain || !config.projectId || !config.appId) throw new Error('Configurazione Firebase incompleta: copia tutto il blocco firebaseConfig dalla console.');
  return config;
}
async function startFirebase(config) {
  if (!window.firebase) throw new Error('Firebase non è disponibile. Verifica la connessione internet.');
  if (!firebaseAppInstance) {
    firebaseAppInstance=firebase.initializeApp(config);
    firebaseAuth=firebase.auth(); firebaseDb=firebase.firestore();
    try { await firebaseDb.enablePersistence({synchronizeTabs:true}); } catch { /* la copia locale IndexedDB resta disponibile */ }
  }
  return firebaseAppInstance;
}
function firebaseDocument() { return firebaseDb.collection('inventories').doc(firebaseUser.uid); }
async function syncFirebaseNow() {
  if (!firebaseUser || firebaseSyncRunning) return;
  firebaseSyncRunning=true;
  try { const backup=await backupPayload(); await firebaseDocument().set({backup,updatedAt:firebase.firestore.FieldValue.serverTimestamp()}); await putSetting('firebaseLastSyncAt',backup.exportedAt); firebaseStatus(`Sincronizzato nel cloud alle ${dateTime(backup.exportedAt)}.`); }
  catch (error) { firebaseStatus(error.message || 'Sincronizzazione Firebase non riuscita.',true); throw error; }
  finally { firebaseSyncRunning=false; }
}
function queueFirebaseSync() { clearTimeout(firebaseSyncTimer); if (!firebaseUser) return; firebaseSyncTimer=setTimeout(()=>syncFirebaseNow().catch(()=>{}),450); }
async function subscribeFirebase() {
  firebaseUnsubscribe?.();
  firebaseUnsubscribe=firebaseDocument().onSnapshot(async snapshot => {
    const remote=snapshot.data()?.backup;
    if (!remote?.exportedAt || Date.parse(remote.exportedAt) <= await latestLocalDate()) return;
    await restoreBackupData(remote); firebaseStatus(`Dati cloud aggiornati (${dateTime(remote.exportedAt)}).`); render();
  }, error => firebaseStatus(error.message || 'Aggiornamento cloud non riuscito.',true));
}
async function connectFirebase(configText) {
  const config=parseFirebaseConfig(configText); await putSetting('firebaseConfig',config);
  await startFirebase(config); const provider=new firebase.auth.GoogleAuthProvider(); provider.setCustomParameters({prompt:'select_account'});
  const result=await firebaseAuth.signInWithPopup(provider); firebaseUser=result.user; await putSetting('firebaseEnabled',true); await putSetting('firebaseUserEmail',firebaseUser.email || '');
  const remote=await firebaseDocument().get(); const backup=remote.data()?.backup;
  const downloaded=backup?.exportedAt && Date.parse(backup.exportedAt) > await latestLocalDate(); if (downloaded) await restoreBackupData(backup);
  await subscribeFirebase(); await syncFirebaseNow(); return {downloaded,email:firebaseUser.email || ''};
}
async function resumeFirebase() {
  const config=await getSetting('firebaseConfig'); if (!config) return;
  try { await startFirebase(config); firebaseAuth.onAuthStateChanged(async user => { if (!user) return; firebaseUser=user; await subscribeFirebase(); firebaseStatus(`Cloud collegato: ${user.email || 'account Google'}.`); }); } catch { /* l'app resta disponibile offline */ }
}

async function hashPassword(password) {
  const bytes = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2,'0')).join('');
}
function route() { return location.hash || '#home'; }
function navigate(path) { location.hash = path; }
function activeProducts(products) { return products.filter(product => !product.archived).sort((a,b) => a.name.localeCompare(b.name,'it')); }
function productList(products, empty = 'Nessun prodotto trovato.') {
  return products.length ? `<ul class="list">${products.map(p => `<li><a href="#product/${p.id}"><div class="row"><strong>${esc(p.name)}</strong><span class="quantity">${p.quantity}</span></div><span class="small muted">${esc(p.brand || '—')} · ${esc(p.ean)}</span></a></li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`;
}

async function home() {
  const products = activeProducts(await allProducts());
  const threshold = await lowStockThreshold();
  const lowStock = products.filter(product => product.quantity <= threshold);
  app.innerHTML = `<h1>Inventario</h1><p class="muted">Cerca un prodotto o scansiona il barcode: la scelta tra vendita e utilizzo si apre subito.</p>
    <input id="product-search" class="search" type="search" autocomplete="off" placeholder="Nome, marca o codice EAN" autofocus>
    <div id="search-results">${productList(products, 'Non ci sono ancora prodotti. L’Admin può aggiungerli.')}</div>
    ${lowStock.length ? `<div class="card notice"><strong>Scorte basse: ${lowStock.length}</strong><p class="small">Quantità uguale o inferiore a ${threshold}.</p>${productList(lowStock)}</div>` : ''}
    <div class="card"><strong>Operatore</strong><p class="muted small">Puoi registrare vendite e utilizzi, senza modificare o eliminare prodotti.</p><a class="button full" href="#movements">Movimenti recenti</a></div>`;
  const input = document.querySelector('#product-search');
  input.addEventListener('input', () => {
    const query = input.value.trim().toLocaleLowerCase('it');
    const found = !query ? products : products.filter(p => [p.ean,p.name,p.brand].some(value => String(value || '').toLocaleLowerCase('it').includes(query)));
    document.querySelector('#search-results').innerHTML = productList(found);
  });
  // Gli scanner HID digitano l'EAN come una tastiera e, di norma, terminano con Invio.
  // Il campo è già selezionato all'apertura, quindi questa è la normale via di scansione.
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const code = input.value.trim();
    const product = products.find(item => item.ean === code);
    if (product) navigate(`#product/${product.id}`);
    else toast(code ? `EAN ${code} non trovato.` : 'Scansiona o inserisci un codice EAN.');
  });
}

async function productPage(productId) {
  const product = await getProduct(productId);
  const threshold = await lowStockThreshold();
  if (!product || product.archived) { toast('Prodotto non disponibile.'); navigate('#home'); return; }
  app.innerHTML = `<a class="small" href="#home">← Cerca prodotti</a><div class="card"><div class="row"><div><h1>${esc(product.name)}</h1><p class="muted">${esc(product.brand || 'Marca non indicata')}</p></div><span class="badge">EAN ${esc(product.ean)}</span></div>
    <dl class="detail"><dt>Disponibili</dt><dd class="quantity">${product.quantity}</dd><dt>Dosaggio</dt><dd>${esc(product.dosage || '—')}</dd>${product.notes ? `<dt>Note</dt><dd>${esc(product.notes)}</dd>` : ''}</dl>${product.quantity <= threshold ? `<p class="notice small">Scorta bassa: soglia impostata a ${threshold}.</p>` : ''}</div>
    <div class="actions"><button class="button" data-move="sale">Vendita</button><button class="button secondary" data-move="counter_use">Utilizzo banco</button></div>
    <p class="muted small">Ogni operazione registra un movimento e aggiorna la disponibilità.</p>`;
  document.querySelectorAll('[data-move]').forEach(button => button.addEventListener('click', () => movementDialog(product, button.dataset.move)));
}

function movementDialog(product, type) {
  const names = {sale:'Vendita', counter_use:'Utilizzo banco', load:'Carico', correction:'Rettifica'};
  const correction = type === 'correction';
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<form class="dialog-body" method="dialog"><h2>${names[type]}</h2><p>${esc(product.name)}</p><label class="field">${correction ? 'Nuova quantità' : 'Quantità'}<input name="quantity" type="number" min="${correction ? 0 : 1}" step="1" value="${correction ? product.quantity : 1}" required autofocus></label><label class="field">Nota (facoltativa)<input name="note" maxlength="300" placeholder="Es. vendita cliente"></label><p class="error hidden"></p><div class="actions"><button class="button secondary" value="cancel">Annulla</button><button class="button" value="confirm">Conferma</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue === 'confirm') {
      const form = dialog.querySelector('form'); const quantity = Number(new FormData(form).get('quantity'));
      if (!Number.isInteger(quantity) || quantity < 0 || (!correction && quantity < 1)) { toast('Inserisci una quantità valida.'); dialog.remove(); return; }
      if ((type === 'sale' || type === 'counter_use') && quantity > product.quantity) { toast('Quantità non disponibile.'); dialog.remove(); return; }
      await recordMovement(product, type, quantity, new FormData(form).get('note'));
    }
    dialog.remove();
  });
}

async function recordMovement(product, type, quantity, note = '') {
  const oldQuantity = Number(product.quantity);
  const newQuantity = type === 'correction' ? quantity : oldQuantity + (type === 'load' ? quantity : -quantity);
  const movement = {id:id(), productId:product.id, productName:product.name, type, quantity, previousQuantity:oldQuantity, newQuantity, note:note.trim(), date:new Date().toISOString()};
  const transaction = db.transaction(['products','movements'], 'readwrite');
  transaction.objectStore('products').put({...product, quantity:newQuantity, updatedAt:new Date().toISOString()});
  transaction.objectStore('movements').put(movement);
  await new Promise((resolve,reject) => { transaction.oncomplete=resolve; transaction.onerror=() => reject(transaction.error); });
  queueFirebaseSync();
  toast('Movimento registrato.'); navigate(`#product/${product.id}`); render();
}

async function movements() {
  const moves = (await allMoves()).sort((a,b) => b.date.localeCompare(a.date)).slice(0,100);
  const labels = {sale:'Vendita',counter_use:'Utilizzo banco',load:'Carico',correction:'Rettifica'};
  app.innerHTML = `<a class="small" href="#home">← Home</a><h1>Movimenti recenti</h1>${moves.length ? `<ul class="list">${moves.map(m => `<li><a href="#product/${m.productId}"><div class="row"><strong>${labels[m.type]}</strong><span class="quantity">${m.type === 'sale' || m.type === 'counter_use' ? '−' : ''}${m.quantity}</span></div><span>${esc(m.productName)}</span><br><span class="small muted">${dateTime(m.date)}${m.note ? ` · ${esc(m.note)}` : ''}</span></a></li>`).join('')}</ul>` : '<p class="muted">Non sono stati ancora registrati movimenti.</p>'}`;
}

async function adminLogin() {
  const storedHash = await getSetting('adminPasswordHash');
  const savedHash = storedHash || DEFAULT_ADMIN_PASSWORD_HASH;
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<form class="dialog-body" method="dialog"><h2>Accesso Admin</h2><p class="muted small">Inserisci la password per gestire prodotti e dati.</p><label class="field">Password<input name="password" type="password" minlength="6" required autofocus></label><p id="login-error" class="error hidden"></p><div class="actions"><button class="button secondary" value="cancel">Annulla</button><button id="login-submit" class="button" value="confirm">Accedi</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const password = data.get('password'); const error = dialog.querySelector('#login-error');
    const hashed = await hashPassword(password);
    if (hashed !== savedHash) { error.textContent='Password non corretta.'; error.classList.remove('hidden'); return; }
    if (!storedHash) await putSetting('adminPasswordHash', savedHash);
    isAdmin = true; dialog.close('confirm'); dialog.remove(); navigate('#admin/products');
  });
  dialog.addEventListener('close', () => dialog.remove());
}

function adminTabs(tab) { return `<div class="admin-nav"><a class="button ${tab==='summary'?'active':''}" href="#admin/summary">Riepilogo</a><a class="button ${tab==='products'?'active':''}" href="#admin/products">Prodotti</a><a class="button ${tab==='movements'?'active':''}" href="#admin/movements">Movimenti</a><a class="button ${tab==='data'?'active':''}" href="#admin/data">Dati</a><button id="logout" class="button secondary">Esci</button></div>`; }
function addLogout() { document.querySelector('#logout').onclick = () => { isAdmin=false; toast('Sei uscito dall’area Admin.'); navigate('#home'); }; }
async function adminSummary() {
  const products = activeProducts(await allProducts());
  const threshold = await lowStockThreshold();
  const lowStock = products.filter(product => product.quantity <= threshold);
  const totalUnits = products.reduce((sum, product) => sum + Number(product.quantity), 0);
  const purchaseValue = products.reduce((sum, product) => sum + Number(product.quantity) * Number(product.purchasePrice), 0);
  const publicValue = products.reduce((sum, product) => sum + Number(product.quantity) * Number(product.publicPrice), 0);
  app.innerHTML = `<h1>Riepilogo inventario</h1>${adminTabs('summary')}<div class="actions"><div class="card"><strong>${products.length}</strong><br><span class="small muted">Prodotti attivi</span></div><div class="card"><strong>${totalUnits}</strong><br><span class="small muted">Pezzi disponibili</span></div></div><div class="card"><dl class="detail"><dt>Valore di acquisto</dt><dd>${money(purchaseValue)}</dd><dt>Valore al pubblico</dt><dd>${money(publicValue)}</dd><dt>Scorte basse</dt><dd>${lowStock.length}</dd></dl></div><div class="card"><div class="row"><h2>Da riordinare</h2><span class="badge">Soglia ${threshold}</span></div>${productList(lowStock, 'Nessun prodotto sotto la soglia.')}</div>`;
  addLogout();
}
async function adminProducts() {
  const products = (await allProducts()).sort((a,b) => a.name.localeCompare(b.name,'it'));
  app.innerHTML = `<h1>Area Admin</h1>${adminTabs('products')}<div class="actions"><a class="button full" href="#admin/new">+ Aggiungi prodotto</a></div><input id="admin-search" class="search" type="search" placeholder="Cerca prodotti, inclusi archiviati"><div id="admin-products">${adminProductList(products)}</div>`;
  addLogout();
  document.querySelector('#admin-search').oninput = event => { const q=event.target.value.toLowerCase(); document.querySelector('#admin-products').innerHTML=adminProductList(products.filter(p => `${p.name} ${p.brand} ${p.ean}`.toLowerCase().includes(q))); };
}
function adminProductList(products) { return products.length ? `<ul class="list">${products.map(p => `<li><a href="#admin/edit/${p.id}"><div class="row"><strong>${esc(p.name)}</strong><span class="quantity">${p.quantity}</span></div><span class="small muted">${p.archived ? 'Archiviato · ' : ''}${esc(p.brand || '—')} · ${esc(p.ean)}</span></a></li>`).join('')}</ul>` : '<p class="muted">Nessun prodotto.</p>'; }
function productForm(product = {}) { const value = (key, fallback='') => esc(product[key] ?? fallback); return `<form id="product-form" class="form-grid"><label class="field">Codice EAN *<input name="ean" inputmode="numeric" pattern="[0-9]+" maxlength="20" value="${value('ean')}" required></label><label class="field">Nome prodotto *<input name="name" maxlength="120" value="${value('name')}" required></label><label class="field">Marca<input name="brand" maxlength="100" value="${value('brand')}"></label><div class="two"><label class="field">Prezzo pubblico (€)<input name="publicPrice" type="number" min="0" step="0.01" value="${value('publicPrice','0')}"></label><label class="field">Prezzo acquisto (€)<input name="purchasePrice" type="number" min="0" step="0.01" value="${value('purchasePrice','0')}"></label></div><div class="two"><label class="field">Dosaggio<input name="dosage" maxlength="80" value="${value('dosage')}"></label><label class="field">Quantità *<input name="quantity" type="number" min="0" step="1" value="${value('quantity','0')}" required></label></div><label class="field">Note<textarea name="notes" maxlength="1000">${value('notes')}</textarea></label><p id="form-error" class="error hidden"></p><button class="button full" type="submit">Salva prodotto</button></form>`; }
async function editProduct(productId) {
  const existing = productId ? await getProduct(productId) : null;
  if (productId && !existing) { navigate('#admin/products'); return; }
  app.innerHTML = `<a class="small" href="#admin/products">← Prodotti</a><h1>${existing ? 'Modifica prodotto' : 'Nuovo prodotto'}</h1>${productForm(existing || {})}${existing ? `<div class="card"><strong>${existing.archived ? 'Prodotto archiviato' : 'Archivia prodotto'}</strong><p class="muted small">L’archiviazione lo rimuove dalle schermate Operatore senza perdere lo storico.</p><button id="archive" class="button ${existing.archived ? 'secondary' : 'danger'} full">${existing.archived ? 'Riattiva prodotto' : 'Archivia prodotto'}</button></div>` : ''}`;
  document.querySelector('#product-form').onsubmit = event => saveProduct(event, existing);
  if (existing) document.querySelector('#archive').onclick = async () => { const next={...existing,archived:!existing.archived,updatedAt:new Date().toISOString()}; await req(store('products','readwrite').put(next)); queueFirebaseSync(); toast(next.archived ? 'Prodotto archiviato.' : 'Prodotto riattivato.'); navigate('#admin/products'); };
}
async function saveProduct(event, existing) {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); const error = document.querySelector('#form-error'); const ean=data.ean.trim(); const quantity=Number(data.quantity); const publicPrice=Number(data.publicPrice || 0); const purchasePrice=Number(data.purchasePrice || 0);
  if (!/^\d+$/.test(ean) || !Number.isInteger(quantity) || quantity < 0 || publicPrice < 0 || purchasePrice < 0) { error.textContent='Verifica EAN, quantità e prezzi.'; error.classList.remove('hidden'); return; }
  const duplicate = await req(store('products').index('ean').get(ean)); if (duplicate && duplicate.id !== existing?.id) { error.textContent='Esiste già un prodotto con questo EAN.'; error.classList.remove('hidden'); return; }
  const now = new Date().toISOString(); const product = {...existing, id:existing?.id || id(), ean, name:data.name.trim(), brand:data.brand.trim(), publicPrice, purchasePrice, dosage:data.dosage.trim(), quantity, notes:data.notes.trim(), archived:existing?.archived || false, createdAt:existing?.createdAt || now, updatedAt:now};
  await req(store('products','readwrite').put(product)); queueFirebaseSync(); toast(existing ? 'Prodotto aggiornato.' : 'Prodotto creato.'); navigate('#admin/products');
}

async function adminMovements() { const moves=(await allMoves()).sort((a,b)=>b.date.localeCompare(a.date)); const labels={sale:'Vendita',counter_use:'Utilizzo banco',load:'Carico',correction:'Rettifica'}; app.innerHTML=`<h1>Area Admin</h1>${adminTabs('movements')}<h2>Registra movimento</h2><div class="card"><label class="field">Prodotto<select id="move-product">${activeProducts(await allProducts()).map(p=>`<option value="${p.id}">${esc(p.name)} (${p.quantity})</option>`).join('')}</select></label><div class="actions three"><button class="button" data-admin-move="load">Carico</button><button class="button secondary" data-admin-move="correction">Rettifica</button><button class="button secondary" data-admin-move="sale">Vendita</button></div></div><h2>Storico</h2>${moves.length ? `<ul class="list">${moves.map(m=>`<li><div class="row"><strong>${labels[m.type]}</strong><span>${m.previousQuantity} → ${m.newQuantity}</span></div><span>${esc(m.productName)}</span><br><span class="small muted">${dateTime(m.date)}${m.note?` · ${esc(m.note)}`:''}</span></li>`).join('')}</ul>`:'<p class="muted">Nessun movimento.</p>'}`; document.querySelector('#logout').onclick=()=>{isAdmin=false;navigate('#home')}; document.querySelectorAll('[data-admin-move]').forEach(button=>button.onclick=async()=>{const product=await getProduct(document.querySelector('#move-product').value); movementDialog(product,button.dataset.adminMove);}); }

function download(filename, type, content) { const blob = new Blob([content], {type}); const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=filename; link.click(); setTimeout(()=>URL.revokeObjectURL(url),500); }
async function adminDriveData() { /* Integrazione Drive sostituita da Firebase. */ }
async function adminData() { const threshold=await lowStockThreshold(); const config=await getSetting('firebaseConfig'); const configText=config ? JSON.stringify(config,null,2) : ''; app.innerHTML=`<h1>Area Admin</h1>${adminTabs('data')}<div class="card"><h2>Sincronizzazione Firebase</h2><p class="muted small">I dati sono privati nel tuo account Firebase e si aggiornano automaticamente su tutti i dispositivi autorizzati.</p><label class="field">Configurazione Firebase<textarea id="firebase-config" placeholder='Incolla qui il firebaseConfig ricevuto da Firebase'>${esc(configText)}</textarea></label><div class="actions"><button id="firebase-connect" class="button">${firebaseUser ? 'Ricollega account Google' : 'Collega Firebase'}</button><button id="firebase-sync" class="button secondary" ${firebaseUser ? '' : 'disabled'}>Sincronizza ora</button></div><p id="firebase-status" class="small">${firebaseUser ? `Cloud collegato: ${esc(firebaseUser.email || 'account Google')}.` : (config ? 'Configurato: accedi con il tuo Google per sincronizzare.' : 'Non ancora configurato.')}</p></div><div class="card"><h2>Avvisi scorte basse</h2><form id="threshold-form" class="form-grid"><label class="field">Avvisa quando la quantità è uguale o inferiore a<input name="threshold" type="number" min="0" step="1" value="${threshold}" required></label><button class="button full">Salva soglia</button></form></div><div class="card"><h2>Importa prodotti CSV</h2><p class="muted small">Usa il CSV esportato da questa app. Per gli EAN già presenti, i dati del prodotto vengono aggiornati; lo storico dei movimenti resta invariato.</p><input id="import-file" type="file" accept=".csv,text/csv"><button id="import" class="button full" disabled>Importa prodotti</button><p id="import-result" class="small" aria-live="polite"></p></div><div class="card"><h2>Esporta prodotti CSV</h2><p class="muted small">File compatibile con Excel e fogli di calcolo.</p><button id="csv" class="button full">Scarica CSV</button></div><div class="card"><h2>Backup completo</h2><p class="muted small">Mantieni anche un backup locale periodico.</p><button id="backup" class="button full">Scarica backup JSON</button></div><div class="card"><h2>Ripristina backup</h2><p class="notice small">Il ripristino sostituisce tutti i dati presenti su questo dispositivo.</p><input id="restore-file" type="file" accept="application/json,.json"><button id="restore" class="button danger full" disabled>Ripristina backup</button></div>`; addLogout(); document.querySelector('#firebase-connect').onclick=async()=>{try { const result=await connectFirebase(document.querySelector('#firebase-config').value.trim()); document.querySelector('#firebase-sync').disabled=false; toast(result.downloaded ? 'Dati cloud recuperati.' : 'Firebase collegato e sincronizzato.'); render(); } catch(error) { firebaseStatus(error.message || 'Impossibile collegare Firebase.',true); }}; document.querySelector('#firebase-sync').onclick=()=>syncFirebaseNow().then(()=>toast('Sincronizzazione completata.')).catch(()=>{}); document.querySelector('#threshold-form').onsubmit=saveThreshold; document.querySelector('#csv').onclick=exportCsv; document.querySelector('#backup').onclick=exportBackup; const importFile=document.querySelector('#import-file'); document.querySelector('#import').onclick=()=>importCsv(importFile.files[0]); importFile.onchange=()=>document.querySelector('#import').disabled=!importFile.files.length; const file=document.querySelector('#restore-file'); document.querySelector('#restore').onclick=()=>restoreBackup(file.files[0]); file.onchange=()=>document.querySelector('#restore').disabled=!file.files.length; }
async function saveThreshold(event) { event.preventDefault(); const value=Number(new FormData(event.currentTarget).get('threshold')); if (!Number.isInteger(value) || value < 0) { toast('Inserisci una soglia intera uguale o superiore a zero.'); return; } await putSetting('lowStockThreshold', value); queueFirebaseSync(); toast('Soglia salvata.'); }
async function exportCsv() { const fields=[['EAN','Nome prodotto','Marca','Prezzo pubblico','Prezzo acquisto','Dosaggio','Quantità','Note','Archiviato']]; (await allProducts()).forEach(p=>fields.push([p.ean,p.name,p.brand,p.publicPrice,p.purchasePrice,p.dosage,p.quantity,p.notes,p.archived?'Sì':'No'])); download(`prodotti-${new Date().toISOString().slice(0,10)}.csv`, 'text/csv;charset=utf-8', '\ufeff'+fields.map(row=>row.map(value=>`"${String(value ?? '').replaceAll('"','""')}"`).join(';')).join('\n')); }
function parseCsv(text) { const delimiter = (text.split(/\r?\n/, 1)[0].match(/;/g) || []).length >= (text.split(/\r?\n/, 1)[0].match(/,/g) || []).length ? ';' : ','; const rows=[]; let row=[], cell='', quoted=false; for (let index=0; index<text.length; index+=1) { const char=text[index]; if (char==='"') { if (quoted && text[index+1]==='"') { cell+='"'; index+=1; } else quoted=!quoted; } else if (char===delimiter && !quoted) { row.push(cell); cell=''; } else if ((char==='\n' || char==='\r') && !quoted) { if (char==='\r' && text[index+1]==='\n') index+=1; row.push(cell); if (row.some(value=>value.trim())) rows.push(row); row=[]; cell=''; } else cell+=char; } row.push(cell); if (row.some(value=>value.trim())) rows.push(row); return rows; }
function csvNumber(value) { const raw=String(value ?? '').trim().replace(/\s/g,''); if (!raw) return 0; const comma=raw.lastIndexOf(','); const dot=raw.lastIndexOf('.'); const normalized=comma > dot ? raw.replaceAll('.','').replace(',','.') : raw.replaceAll(',',''); return Number(normalized); }
function csvCell(row, headers, ...names) { const index=names.map(name=>headers.indexOf(name)).find(value=>value>=0); return index === undefined ? '' : row[index] ?? ''; }
async function importCsv(file) { const result=document.querySelector('#import-result'); if (!file) return; try { const rows=parseCsv(await file.text()); if (rows.length < 2) throw new Error('Il file non contiene prodotti.'); const headers=rows[0].map(header=>header.replace(/^\uFEFF/,'').trim().toLocaleLowerCase('it')); const eanIndex=headers.findIndex(header=>header==='ean'||header==='codice ean'); const nameIndex=headers.findIndex(header=>header==='nome prodotto'||header==='nome'); if (eanIndex<0 || nameIndex<0) throw new Error('Intestazioni mancanti: servono EAN e Nome prodotto.'); const existing=(await allProducts()).reduce((map,product)=>(map.set(product.ean,product),map),new Map()); const products=new Map(); const invalid=[]; const now=new Date().toISOString(); rows.slice(1).forEach((row, index) => { const ean=String(row[eanIndex] ?? '').trim(); const name=String(row[nameIndex] ?? '').trim(); const quantity=csvNumber(csvCell(row,headers,'quantità','quantita')); const publicPrice=csvNumber(csvCell(row,headers,'prezzo pubblico')); const purchasePrice=csvNumber(csvCell(row,headers,'prezzo acquisto')); if (!/^\d+$/.test(ean) || !name || !Number.isInteger(quantity) || quantity<0 || !Number.isFinite(publicPrice) || publicPrice<0 || !Number.isFinite(purchasePrice) || purchasePrice<0) { invalid.push(index+2); return; } const previous=products.get(ean)||existing.get(ean); const archivedValue=String(csvCell(row,headers,'archiviato')).trim().toLocaleLowerCase('it'); products.set(ean,{...previous,id:previous?.id||id(),ean,name,brand:String(csvCell(row,headers,'marca')).trim(),publicPrice,purchasePrice,dosage:String(csvCell(row,headers,'dosaggio')).trim(),quantity,notes:String(csvCell(row,headers,'note')).trim(),archived:['sì','si','true','1'].includes(archivedValue),createdAt:previous?.createdAt||now,updatedAt:now}); }); if (!products.size) throw new Error('Nessuna riga valida da importare.'); const tx=db.transaction('products','readwrite'); products.forEach(product=>tx.objectStore('products').put(product)); await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)}); queueFirebaseSync(); result.classList.remove('error'); result.textContent=`Importati o aggiornati ${products.size} prodotti.${invalid.length ? ` Righe ignorate: ${invalid.join(', ')}.` : ''}`; toast('Importazione completata.'); } catch (error) { result.textContent=error.message || 'Impossibile importare il file.'; result.classList.add('error'); } }
async function exportBackup() { const backup=await backupPayload(); download(`backup-inventario-${new Date().toISOString().slice(0,10)}.json`, 'application/json', JSON.stringify(backup,null,2)); }
async function restoreBackup(file) { if (!file || !confirm('Vuoi sostituire tutti i dati locali con questo backup?')) return; try { await restoreBackupData(JSON.parse(await file.text())); queueFirebaseSync(); toast('Backup ripristinato.'); navigate('#admin/products'); } catch { toast('Il file non sembra un backup valido.'); } }

async function render() { const parts=route().slice(1).split('/'); if (parts[0]==='admin') { if (!isAdmin) { adminLogin(); return; } if (parts[1]==='summary') return adminSummary(); if (parts[1]==='new') return editProduct(); if (parts[1]==='edit') return editProduct(parts[2]); if (parts[1]==='movements') return adminMovements(); if (parts[1]==='data') return adminData(); return adminProducts(); } if (parts[0]==='product') return productPage(parts[1]); if (parts[0]==='movements') return movements(); return home(); }
window.addEventListener('hashchange', render);
window.addEventListener('keydown', event => { const tag=document.activeElement?.tagName; if (tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||event.ctrlKey||event.metaKey||event.altKey) return; if (event.key==='Enter' && scanBuffer.length >= 4) { const code=scanBuffer; scanBuffer=''; clearTimeout(scanTimer); navigate(`#home`); setTimeout(async()=>{const product=activeProducts(await allProducts()).find(p=>p.ean===code); if(product) navigate(`#product/${product.id}`); else toast(`EAN ${code} non trovato.`);},0); return; } if (/^[0-9]$/.test(event.key)) { scanBuffer+=event.key; clearTimeout(scanTimer); scanTimer=setTimeout(()=>scanBuffer='',400); } else scanBuffer=''; });
adminButton.addEventListener('click', () => isAdmin ? navigate('#admin/products') : adminLogin());
(async function init(){ db=await openDb(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{}); await resumeFirebase(); render(); })().catch(error=>{console.error(error); app.innerHTML='<h1>Impossibile aprire l’inventario</h1><p>Il browser non consente l’archivio locale richiesto dall’app.</p>';});
