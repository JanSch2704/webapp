'use strict';

/* =====================================================================
   Sales Manager – Web-App (PWA)
   Daten liegen lokal in IndexedDB (Artikel inkl. Fotos) und localStorage
   (Einstellungen). Optional verbindet sich die Browser-Erweiterung über
   window.postMessage, um Formulare auf Vinted/Kleinanzeigen/eBay
   automatisch auszufüllen.
   ===================================================================== */

const APP_VERSION = '1.0.0';
const MAX_IMAGES = 20;
const PHOTO_MAX_SIDE = 2560;
const PHOTO_QUALITY = 0.9;
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_PROMPT = 'Titel suchmaschinenfreundlich aufbauen und Wörter mit Pipes | trennen. Beispiel: Wort 1 | Wort 2 | Wort 3. Artikelbeschreibung nur in kurzen Stichpunkten. Keine Fließtexte. Zuverlässigkeit, schneller Versand und schnelle Antwort im Chat betonen.';
const SETTINGS_KEY = 'sm-settings';

const SITES = {
  vinted:        { label: 'Vinted',        url: 'https://www.vinted.de/items/new' },
  kleinanzeigen: { label: 'Kleinanzeigen', url: 'https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html' },
  ebay:          { label: 'eBay',          url: 'https://www.ebay.de/sl/sell' }
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* Einstellungen                                                       */
/* ------------------------------------------------------------------ */
function getSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) { s = {}; }
  const urls = {};
  Object.keys(SITES).forEach((k) => { urls[k] = (s.siteUrls && s.siteUrls[k]) || SITES[k].url; });
  return {
    apiKey: s.apiKey || '',
    model: s.model || DEFAULT_MODEL,
    generalPrompt: typeof s.generalPrompt === 'string' && s.generalPrompt.trim() ? s.generalPrompt : DEFAULT_PROMPT,
    searchGrounding: s.searchGrounding === true,
    fullResCamera: s.fullResCamera !== false,
    siteUrls: urls
  };
}
function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                           */
/* ------------------------------------------------------------------ */
const DB_NAME = 'sales-manager';
const STORE = 'items';
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function dbRun(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen (Speicher voll?)'));
  });
}
const dbAll = () => dbRun('readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)));
const dbGet = (id) => dbRun('readonly', (s) => s.get(id));
const dbPut = (item) => dbRun('readwrite', (s) => s.put(item));
const dbDelete = (id) => dbRun('readwrite', (s) => s.delete(id));

/* ------------------------------------------------------------------ */
/* Preise: intern immer in Cent, Ausgabe je nach Plattform             */
/* ------------------------------------------------------------------ */
function parsePriceToCents(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : null;
  let s = String(input).replace(/[\s ]/g, '').replace(/€|eur(o)?/gi, '').replace(/[^0-9.,]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot > -1 && lastComma > -1) {
    // "1.234,56" oder "1,234.56" → das zuletzt vorkommende Zeichen ist das Dezimaltrennzeichen
    const dec = lastDot > lastComma ? '.' : ',';
    const thousands = dec === '.' ? ',' : '.';
    s = s.split(thousands).join('').replace(dec, '.');
  } else if (lastComma > -1) {
    const parts = s.split(',');
    s = parts.length > 2 ? parts.join('') : parts[0] + '.' + parts[1];
  } else if (lastDot > -1) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 1.234 = Tausender
    else {
      const parts = s.split('.');
      if (parts.length > 2) s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    }
  }
  if (s.startsWith('.')) s = '0' + s;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
/** Preis so formatieren, wie die jeweilige Plattform ihn erwartet. */
function formatPriceFor(cents, site) {
  if (cents == null) return '';
  if (site === 'kleinanzeigen') return String(Math.round(cents / 100)); // Kleinanzeigen: nur ganze Euro
  return (cents / 100).toFixed(2).replace('.', ',');                      // z.B. 1,00
}
function formatPriceInput(cents) {
  return cents == null ? '' : (cents / 100).toFixed(2).replace('.', ',');
}
function formatPriceDisplay(cents) {
  if (cents == null) return 'kein Preis';
  return (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/* ------------------------------------------------------------------ */
/* Bildverarbeitung                                                    */
/* ------------------------------------------------------------------ */
async function loadImageSource(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (_) { /* Fallback */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { img._url = url; resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden'))), type, quality));
}
/** Skaliert (nur verkleinern), dreht und kodiert ein Bild als JPEG. */
async function processImage(blob, { rotate = 0, maxSide = PHOTO_MAX_SIDE, quality = PHOTO_QUALITY } = {}) {
  const src = await loadImageSource(blob);
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const rot = ((rotate % 360) + 360) % 360;
  const sideways = rot === 90 || rot === 270;
  const canvas = document.createElement('canvas');
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  if (src.close) src.close();
  if (src._url) URL.revokeObjectURL(src._url);
  return canvasToBlob(canvas, 'image/jpeg', quality);
}
/** Liefert das Bild in finaler Ausrichtung (Drehung wird erst beim Export eingerechnet → kein Qualitätsverlust). */
async function exportImageBlob(img) {
  if (!img.rotation) return img.blob;
  return processImage(img.blob, { rotate: img.rotation, maxSide: 4096, quality: 0.92 });
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}
function slugify(s) {
  return String(s || 'artikel').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'artikel';
}

/* ------------------------------------------------------------------ */
/* UI-Helfer                                                           */
/* ------------------------------------------------------------------ */
let toastTimer = null;
function toast(msg, type = 'ok', ms = 3800) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (type === 'err' ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, ms);
}
function busy(on, text = 'Bitte warten …') {
  $('#busy').hidden = !on;
  $('#busy-text').textContent = text;
}
function actionSheet(title, options) {
  return new Promise((resolve) => {
    const sheet = $('#sheet');
    const panel = $('#sheet-panel');
    panel.innerHTML = `<div class="sheet-title">${esc(title)}</div>`;
    const close = (val) => { sheet.hidden = true; sheet.onclick = null; resolve(val); };
    options.forEach((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (o.danger ? ' danger' : '');
      b.textContent = o.label;
      b.onclick = (e) => { e.stopPropagation(); close(o.value); };
      panel.appendChild(b);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.style.justifyContent = 'center';
    cancel.textContent = 'Abbrechen';
    cancel.onclick = (e) => { e.stopPropagation(); close(null); };
    panel.appendChild(cancel);
    sheet.onclick = (e) => { if (e.target === sheet) close(null); };
    sheet.hidden = false;
  });
}
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`${label} kopiert ✓`);
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
const VIEWS = ['list', 'editor', 'publish', 'settings'];
let currentView = null;

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}
function showView(name, title, withBack) {
  VIEWS.forEach((v) => { $('#view-' + v).hidden = v !== name; });
  $('#appbar-title').textContent = title;
  $('#nav-back').hidden = !withBack;
  $('#nav-settings').hidden = name !== 'list';
  if (currentView !== name) window.scrollTo(0, 0);
  currentView = name;
}
let suppressRoute = false;
async function route() {
  if (suppressRoute) { suppressRoute = false; return; }
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const name = parts[0] || '';
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  const targetHash = location.hash;

  // Ungespeicherte Änderungen schützen
  if (currentView === 'editor' && editor.dirty && targetHash !== editor.hash) {
    if (!confirm('Ungespeicherte Änderungen verwerfen?')) {
      suppressRoute = true;
      location.hash = editor.hash;
      return;
    }
    editor.dirty = false;
  }

  if (name === 'new' || name === 'edit') {
    if (editor.hash !== targetHash || !editor.loaded) await openEditor(name === 'edit' ? id : null, targetHash);
    showView('editor', name === 'edit' ? 'Artikel bearbeiten' : 'Neuer Artikel', true);
  } else if (name === 'publish' && id) {
    showView('publish', 'Inserieren', true);
    await renderPublish(id);
  } else if (name === 'settings') {
    loadSettingsForm();
    showView('settings', 'Einstellungen', true);
  } else {
    showView('list', 'Sales Manager', false);
    await renderList();
  }
  if (name !== 'new' && name !== 'edit') editor.loaded = false;
}

/* ------------------------------------------------------------------ */
/* Liste                                                               */
/* ------------------------------------------------------------------ */
let listFilter = 'active';
let listSearch = '';
let listUrls = [];

function coverHtml(item) {
  const img = item.images && item.images[0];
  if (!img) return '<div class="cover">📦</div>';
  const url = URL.createObjectURL(img.blob);
  listUrls.push(url);
  const count = item.images.length > 1 ? `<span class="count">${item.images.length}</span>` : '';
  return `<div class="cover"><img src="${url}" alt="" style="transform:rotate(${img.rotation || 0}deg)">${count}</div>`;
}

async function renderList() {
  listUrls.forEach((u) => URL.revokeObjectURL(u));
  listUrls = [];
  const listEl = $('#list');
  const emptyEl = $('#empty');
  let items = [];
  try { items = await dbAll(); } catch (e) { toast('Datenbank konnte nicht geöffnet werden: ' + e.message, 'err'); }
  const q = listSearch.trim().toLowerCase();
  const filtered = items.filter((i) => {
    if (listFilter === 'active' && i.sold) return false;
    if (listFilter === 'sold' && !i.sold) return false;
    if (q && !((i.name || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q))) return false;
    return true;
  });

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    emptyEl.hidden = false;
    emptyEl.innerHTML = items.length === 0
      ? '<div class="big">📦</div><p><b>Noch keine Artikel</b><br>Tippe auf „Neuer Artikel“, mach ein paar Fotos und lass die KI den Text schreiben.</p>'
      : '<p>Keine Artikel für diesen Filter.</p>';
    return;
  }
  emptyEl.hidden = true;

  filtered.forEach((item) => {
    const el = document.createElement('article');
    el.className = 'item' + (item.sold ? ' sold' : '');
    const posted = item.posted || {};
    const badges = Object.keys(SITES).filter((k) => posted[k]).map((k) => `<span class="badge ${k}">${SITES[k].label}</span>`).join('');
    el.innerHTML = `
      ${coverHtml(item)}
      <div class="item-body">
        <div class="item-title">${esc(item.name || 'Ohne Titel')}</div>
        <div class="item-meta"><b>${esc(formatPriceDisplay(item.priceCents))}</b>${item.condition ? ' · ' + esc(item.condition) : ''}</div>
        <div class="badges">${item.sold ? '<span class="badge sold">Verkauft</span>' : ''}${badges}</div>
      </div>
      <div class="item-actions">
        <button class="btn small" data-a="edit" type="button">✏️ Bearbeiten</button>
        <button class="btn small primary" data-a="publish" type="button">🚀 Inserieren</button>
        <button class="btn small more" data-a="more" type="button" aria-label="Mehr">⋯</button>
      </div>`;
    el.querySelector('.cover').onclick = () => go('#/edit/' + encodeURIComponent(item.id));
    el.querySelector('.item-title').onclick = () => go('#/edit/' + encodeURIComponent(item.id));
    el.querySelector('[data-a=edit]').onclick = () => go('#/edit/' + encodeURIComponent(item.id));
    el.querySelector('[data-a=publish]').onclick = () => go('#/publish/' + encodeURIComponent(item.id));
    el.querySelector('[data-a=more]').onclick = () => itemMenu(item);
    listEl.appendChild(el);
  });
}

async function itemMenu(item) {
  const choice = await actionSheet(item.name || 'Artikel', [
    { label: item.sold ? '↩︎ Wieder als aktiv markieren' : '✅ Als verkauft markieren', value: 'sold' },
    { label: '⧉ Duplizieren', value: 'dup' },
    { label: '🗑 Löschen', value: 'del', danger: true }
  ]);
  if (choice === 'sold') {
    item.sold = !item.sold;
    item.updatedAt = Date.now();
    await dbPut(item);
    toast(item.sold ? 'Als verkauft markiert' : 'Wieder aktiv');
    renderList();
  } else if (choice === 'dup') {
    const copy = { ...item, id: uid(), name: (item.name || '') + ' (Kopie)', posted: {}, sold: false, createdAt: Date.now(), updatedAt: Date.now(),
      images: (item.images || []).map((im) => ({ ...im, id: uid() })) };
    await dbPut(copy);
    toast('Dupliziert');
    renderList();
  } else if (choice === 'del') {
    if (!confirm(`„${item.name || 'Artikel'}“ wirklich löschen?`)) return;
    await dbDelete(item.id);
    toast('Gelöscht');
    renderList();
  }
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */
const editor = { item: null, images: [], dirty: false, hash: null, loaded: false, priceBasis: '' };

function makeImg(blob, rotation = 0, id = uid()) {
  return { id, blob, rotation, url: URL.createObjectURL(blob) };
}

async function openEditor(id, hash) {
  editor.images.forEach((im) => URL.revokeObjectURL(im.url));
  editor.images = [];
  editor.item = null;
  editor.priceBasis = '';
  let item = null;
  if (id) {
    item = await dbGet(id);
    if (!item) { toast('Artikel nicht gefunden', 'err'); editor.loaded = false; go('#/'); return; }
  }
  editor.item = item;
  editor.images = item ? (item.images || []).map((im) => makeImg(im.blob, im.rotation || 0, im.id)) : [];
  editor.priceBasis = item?.priceBasis || '';
  $('#f-name').value = item?.name || '';
  $('#f-price').value = formatPriceInput(item?.priceCents ?? null);
  $('#f-condition').value = item?.condition || '';
  $('#f-hints').value = item?.hints || '';
  $('#f-desc').value = item?.description || '';
  $('#f-query').value = item?.searchQuery || '';
  const info = $('#ai-info');
  if (editor.priceBasis) { info.hidden = false; info.className = 'info'; info.textContent = '💶 ' + editor.priceBasis; }
  else info.hidden = true;
  editor.dirty = false;
  editor.hash = hash;
  editor.loaded = true;
  renderThumbs();
  updateNameCount();
  updateCompareLinks();
}

function markDirty() { editor.dirty = true; }

function renderThumbs() {
  const wrap = $('#thumbs');
  wrap.innerHTML = '';
  const last = editor.images.length - 1;
  editor.images.forEach((im, idx) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = `
      <div class="img-wrap"><img src="${im.url}" alt="" style="transform:rotate(${im.rotation}deg)"></div>
      <span class="n${idx === 0 ? ' cover-tag' : ''}">${idx === 0 ? '★ 1' : idx + 1}</span>
      <div class="tctl">
        <button type="button" data-a="left" ${idx === 0 ? 'disabled' : ''} aria-label="Nach vorne">◀</button>
        <button type="button" data-a="rot" aria-label="Drehen">⟳</button>
        <button type="button" data-a="right" ${idx === last ? 'disabled' : ''} aria-label="Nach hinten">▶</button>
        <button type="button" data-a="del" class="del" aria-label="Entfernen">✕</button>
      </div>`;
    d.querySelector('.img-wrap').onclick = () => openLightbox(idx);
    d.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.a;
        if (a === 'left') moveImage(idx, idx - 1);
        else if (a === 'right') moveImage(idx, idx + 1);
        else if (a === 'rot') rotateImage(idx, 90);
        else if (a === 'del') removeImage(idx);
      };
    });
    wrap.appendChild(d);
  });
  $('#img-count').textContent = `${editor.images.length}/${MAX_IMAGES}`;
}
function moveImage(from, to) {
  if (to < 0 || to >= editor.images.length) return;
  const [im] = editor.images.splice(from, 1);
  editor.images.splice(to, 0, im);
  markDirty();
  renderThumbs();
}
function rotateImage(idx, delta) {
  const im = editor.images[idx];
  if (!im) return;
  im.rotation = (((im.rotation + delta) % 360) + 360) % 360;
  markDirty();
  renderThumbs();
}
function removeImage(idx) {
  const [im] = editor.images.splice(idx, 1);
  if (im) URL.revokeObjectURL(im.url);
  markDirty();
  renderThumbs();
}

async function addImageFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => /^image\//i.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name));
  if (!files.length) return;
  const room = MAX_IMAGES - editor.images.length;
  if (room <= 0) { toast(`Maximal ${MAX_IMAGES} Fotos pro Artikel.`, 'err'); return; }
  const selected = files.slice(0, room);
  let failed = 0;
  busy(true, `Fotos werden verarbeitet (0/${selected.length}) …`);
  for (let i = 0; i < selected.length; i++) {
    busy(true, `Fotos werden verarbeitet (${i + 1}/${selected.length}) …`);
    try {
      const blob = await processImage(selected[i]);
      editor.images.push(makeImg(blob));
    } catch (_) { failed++; }
  }
  busy(false);
  markDirty();
  renderThumbs();
  if (failed) toast(`${failed} Datei(en) konnten nicht gelesen werden (z.B. HEIC).`, 'err');
  else if (files.length > selected.length) toast(`Nur ${selected.length} übernommen – maximal ${MAX_IMAGES} Fotos.`, 'err');
}

function updateNameCount() {
  const n = $('#f-name').value.length;
  $('#name-count').textContent = `${n} Zeichen`;
}

function compareQuery() {
  const q = $('#f-query').value.trim();
  if (q) return q;
  return $('#f-name').value.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
}
function compareLinks(q) {
  const e = encodeURIComponent(q);
  const ka = encodeURIComponent(q.toLowerCase().replace(/\s+/g, '-'));
  return {
    ebay: `https://www.ebay.de/sch/i.html?_nkw=${e}&LH_Sold=1&LH_Complete=1`,
    kleinanzeigen: `https://www.kleinanzeigen.de/s-${ka}/k0`,
    vinted: `https://www.vinted.de/catalog?search_text=${e}`,
    idealo: `https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${e}`
  };
}
function updateCompareLinks() {
  const q = compareQuery();
  const links = compareLinks(q || '');
  $$('#compare-links a').forEach((a) => {
    a.href = q ? links[a.dataset.site] : '#';
    a.classList.toggle('disabled', !q);
    a.onclick = (e) => { if (!q) { e.preventDefault(); toast('Bitte zuerst Titel oder Suchbegriff eingeben.', 'err'); } };
  });
}

async function saveEditor() {
  const name = $('#f-name').value.trim();
  const priceRaw = $('#f-price').value.trim();
  const priceCents = parsePriceToCents(priceRaw);
  if (!name && editor.images.length === 0) { toast('Bitte mindestens einen Titel oder ein Foto hinzufügen.', 'err'); return; }
  if (priceRaw && priceCents == null) { toast('Preis nicht erkannt – bitte z.B. 12,50 eingeben.', 'err'); $('#f-price').focus(); return; }
  const now = Date.now();
  const base = editor.item || { id: uid(), createdAt: now, posted: {}, sold: false };
  const item = {
    ...base,
    name,
    priceCents,
    condition: $('#f-condition').value,
    hints: $('#f-hints').value.trim(),
    description: $('#f-desc').value.trim(),
    searchQuery: $('#f-query').value.trim(),
    priceBasis: editor.priceBasis || '',
    images: editor.images.map((im) => ({ id: im.id, blob: im.blob, rotation: im.rotation })),
    updatedAt: now
  };
  busy(true, 'Speichern …');
  try {
    await dbPut(item);
    editor.item = item;
    editor.dirty = false;
    busy(false);
    toast('Gespeichert ✓');
    editor.loaded = false;
    go('#/');
  } catch (e) {
    busy(false);
    toast('Speichern fehlgeschlagen: ' + (e.message || e), 'err', 6000);
  }
}

/* ------------------------------------------------------------------ */
/* Bild-Ansicht (Lightbox)                                             */
/* ------------------------------------------------------------------ */
let lbIndex = 0;
function openLightbox(idx) {
  lbIndex = idx;
  $('#lightbox').hidden = false;
  renderLightbox();
}
function renderLightbox() {
  const im = editor.images[lbIndex];
  if (!im) { $('#lightbox').hidden = true; return; }
  const img = $('#lb-img');
  img.src = im.url;
  img.style.transform = `rotate(${im.rotation}deg)`;
  img.classList.toggle('sideways', im.rotation === 90 || im.rotation === 270);
  $('#lb-pos').textContent = `Foto ${lbIndex + 1} von ${editor.images.length}${lbIndex === 0 ? ' · Titelbild' : ''}`;
  $('#lb-prev').hidden = lbIndex === 0;
  $('#lb-next').hidden = lbIndex === editor.images.length - 1;
  $('#lb-cover').disabled = lbIndex === 0;
}
function setupLightbox() {
  $('#lb-close').onclick = () => { $('#lightbox').hidden = true; };
  $('#lb-prev').onclick = () => { lbIndex = Math.max(0, lbIndex - 1); renderLightbox(); };
  $('#lb-next').onclick = () => { lbIndex = Math.min(editor.images.length - 1, lbIndex + 1); renderLightbox(); };
  $('#lb-rot-left').onclick = () => { rotateImage(lbIndex, -90); renderLightbox(); };
  $('#lb-rot-right').onclick = () => { rotateImage(lbIndex, 90); renderLightbox(); };
  $('#lb-cover').onclick = () => { moveImage(lbIndex, 0); lbIndex = 0; renderLightbox(); toast('Als Titelbild gesetzt'); };
  $('#lb-delete').onclick = () => {
    removeImage(lbIndex);
    if (!editor.images.length) { $('#lightbox').hidden = true; return; }
    lbIndex = Math.min(lbIndex, editor.images.length - 1);
    renderLightbox();
  };
  // Wischen zum Blättern
  let startX = null;
  const stage = $('.lb-stage');
  stage.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) < 50) return;
    if (dx < 0 && lbIndex < editor.images.length - 1) lbIndex++;
    else if (dx > 0 && lbIndex > 0) lbIndex--;
    renderLightbox();
  });
}

/* ------------------------------------------------------------------ */
/* Kamera – mehrere Fotos am Stück, hohe Auflösung                     */
/* ------------------------------------------------------------------ */
const cam = { stream: null, track: null, imageCapture: null, torch: false, capturing: false, queue: Promise.resolve(), pending: 0, taken: [] };

async function openCamera() {
  if (editor.images.length >= MAX_IMAGES) { toast(`Maximal ${MAX_IMAGES} Fotos pro Artikel.`, 'err'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Dieser Browser unterstützt keinen direkten Kamerazugriff – nutze „Foto-App“.', 'err', 5000);
    return;
  }
  cam.taken = [];
  cam.pending = 0;
  $('#camera').hidden = false;
  $('#cam-error').hidden = true;
  $('#cam-torch').hidden = true;
  $('#cam-torch').classList.remove('on');
  cam.torch = false;
  updateCamUi();
  $('#cam-info').textContent = 'Kamera wird gestartet …';
  try {
    // Hohe Auflösung anfordern – ohne Angabe liefern viele Handys nur 640×480 (Grund für die schlechte Qualität bisher).
    cam.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } }
    });
  } catch (err) {
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    } catch (err2) {
      showCamError('Kamera konnte nicht geöffnet werden. Bitte Kamerazugriff für diese Seite erlauben oder „Foto-App“ verwenden.');
      return;
    }
  }
  cam.track = cam.stream.getVideoTracks()[0];
  const video = $('#cam-video');
  video.srcObject = cam.stream;
  try { await video.play(); } catch (_) { /* autoplay */ }

  // Autofokus / Licht, wenn vom Gerät unterstützt
  let caps = {};
  try { caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {}; } catch (_) { caps = {}; }
  if (caps.focusMode && caps.focusMode.includes('continuous')) {
    cam.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  if (caps.torch) $('#cam-torch').hidden = false;

  cam.imageCapture = null;
  if (getSettings().fullResCamera && 'ImageCapture' in window) {
    try { cam.imageCapture = new ImageCapture(cam.track); } catch (_) { cam.imageCapture = null; }
  }
  await sleep(150);
  const s = cam.track.getSettings ? cam.track.getSettings() : {};
  const res = s.width && s.height ? `${Math.max(s.width, s.height)}×${Math.min(s.width, s.height)}` : '';
  $('#cam-info').textContent = cam.imageCapture ? 'Volle Auflösung' : (res ? `Vorschau ${res}` : '');
}
function showCamError(msg) {
  $('#cam-error').hidden = false;
  $('#cam-error').textContent = msg;
  $('#cam-info').textContent = '';
}
function updateCamUi() {
  const total = editor.images.length + cam.pending;
  $('#cam-count').textContent = `${total}/${MAX_IMAGES}`;
  $('#cam-done').textContent = cam.taken.length || cam.pending ? `Fertig (${cam.taken.length + cam.pending})` : 'Fertig';
  const strip = $('#cam-strip');
  strip.innerHTML = '';
  cam.taken.slice(-8).forEach((im) => {
    const i = document.createElement('img');
    i.src = im.url;
    strip.appendChild(i);
  });
  for (let i = 0; i < cam.pending; i++) {
    const p = document.createElement('div');
    p.className = 'pending';
    strip.appendChild(p);
  }
  strip.scrollLeft = strip.scrollWidth;
}
async function grabFrame() {
  const video = $('#cam-video');
  if (cam.imageCapture) {
    try {
      return await cam.imageCapture.takePhoto();
    } catch (err) {
      console.warn('takePhoto fehlgeschlagen, nutze Videobild', err);
      cam.imageCapture = null;
      $('#cam-info').textContent = 'Videobild-Modus';
    }
  }
  if (!video.videoWidth) throw new Error('Kamera noch nicht bereit');
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', 0.95);
}
async function capturePhoto() {
  if (!cam.stream || cam.capturing) return;
  if (editor.images.length + cam.pending >= MAX_IMAGES) { toast(`Maximal ${MAX_IMAGES} Fotos erreicht.`, 'err'); return; }
  cam.capturing = true;
  $('#cam-shutter').classList.add('busy');
  const flash = $('#cam-flash');
  flash.classList.add('on');
  setTimeout(() => flash.classList.remove('on'), 60);
  if (navigator.vibrate) navigator.vibrate(30);
  let raw;
  try {
    raw = await grabFrame();
  } catch (e) {
    toast('Foto fehlgeschlagen: ' + e.message, 'err');
    cam.capturing = false;
    $('#cam-shutter').classList.remove('busy');
    return;
  }
  cam.capturing = false;
  $('#cam-shutter').classList.remove('busy');
  cam.pending++;
  updateCamUi();
  // Verarbeitung läuft im Hintergrund weiter → sofort nächstes Foto möglich
  cam.queue = cam.queue.then(async () => {
    try {
      const blob = await processImage(raw);
      const im = makeImg(blob);
      editor.images.push(im);
      cam.taken.push(im);
      markDirty();
    } catch (e) {
      toast('Foto konnte nicht gespeichert werden', 'err');
    } finally {
      cam.pending--;
      updateCamUi();
    }
  });
}
async function closeCamera() {
  if (cam.pending) busy(true, 'Fotos werden gespeichert …');
  await cam.queue;
  busy(false);
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  cam.track = null;
  cam.imageCapture = null;
  $('#cam-video').srcObject = null;
  $('#camera').hidden = true;
  renderThumbs();
  if (cam.taken.length) toast(`${cam.taken.length} Foto${cam.taken.length === 1 ? '' : 's'} hinzugefügt`);
}
async function toggleTorch() {
  if (!cam.track) return;
  cam.torch = !cam.torch;
  try {
    await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] });
    $('#cam-torch').classList.toggle('on', cam.torch);
  } catch (_) {
    cam.torch = false;
    toast('Licht wird nicht unterstützt', 'err');
  }
}

/* ------------------------------------------------------------------ */
/* KI (Gemini)                                                         */
/* ------------------------------------------------------------------ */
async function fetchWithTimeout(url, options, ms = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Gemini antwortet zu langsam (Timeout). Bitte erneut versuchen.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}
function parseModelJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) { /* weiter */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* weiter */ } }
  throw new Error('Die KI hat kein gültiges Ergebnis geliefert. Bitte erneut versuchen.');
}

async function callGemini(settings, parts, withSearch) {
  const model = settings.model || DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Suchmaschinenfreundlicher Titel, maximal 60 Zeichen.' },
        description: { type: 'string', description: 'Beschreibung ausschließlich aus kurzen Stichpunkten.' },
        price_eur: { type: 'number', description: 'Realistischer Verkaufspreis in Euro als Zahl, z.B. 12.5' },
        price_basis: { type: 'string', description: 'Kurze Begründung des Preises.' },
        search_query: { type: 'string', description: 'Kurzer Suchbegriff (2–6 Wörter) für Vergleichsangebote: Marke, Modell, wichtigste Eigenschaft.' }
      },
      required: ['title', 'description', 'price_eur', 'price_basis', 'search_query']
    },
    maxOutputTokens: 1200
  };
  if (/^gemini-3/i.test(model)) generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
  const body = { contents: [{ role: 'user', parts }], generationConfig };
  if (withSearch) body.tools = [{ googleSearch: {} }];

  let response;
  for (let attempt = 1; attempt <= 2; attempt++) {
    response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
      body: JSON.stringify(body)
    });
    if (response.status >= 500 && attempt < 2) { await sleep(900); continue; }
    break;
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const err = new Error(`Gemini-Fehler ${response.status}: ${errText.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (!text) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Keine Antwort von der KI (${reason}).` : 'Keine Antwort von der KI erhalten.');
  }
  return parseModelJson(text);
}

async function generateWithAi() {
  const settings = getSettings();
  if (!settings.apiKey) {
    toast('Bitte zuerst den Gemini-API-Key in den Einstellungen eintragen.', 'err', 5000);
    return;
  }
  const hints = $('#f-hints').value.trim();
  const condition = $('#f-condition').value;
  if (!editor.images.length && !hints) { toast('Bitte mindestens ein Foto oder Stichpunkte angeben.', 'err'); return; }
  if (($('#f-name').value.trim() || $('#f-desc').value.trim()) && !confirm('Vorhandenen Titel, Preis und Beschreibung durch den KI-Vorschlag ersetzen?')) return;

  const btn = $('#btn-ai');
  const info = $('#ai-info');
  btn.disabled = true;
  btn.textContent = '✨ KI arbeitet …';
  info.hidden = false;
  info.className = 'info';
  info.textContent = settings.searchGrounding ? 'Recherchiere Preise und schreibe Anzeige …' : 'Schreibe Anzeige …';

  try {
    const parts = [];
    for (const im of editor.images.slice(0, 4)) {
      const small = await processImage(im.blob, { rotate: im.rotation, maxSide: 1024, quality: 0.85 });
      const dataUrl = await blobToDataUrl(small);
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: dataUrl.split(',')[1] } });
    }
    const priceRule = settings.searchGrounding
      ? 'PREIS: Nutze die Google-Suche, um aktuelle vergleichbare Angebote und Verkaufspreise auf dem deutschen Gebrauchtmarkt zu finden. Ignoriere Ausreißer. Nenne in price_basis kurz die Grundlage.'
      : 'PREIS: Schätze anhand deines Wissens einen realistischen, eher vorsichtigen Verkaufspreis für den deutschen Gebrauchtmarkt (Vinted/Kleinanzeigen). Nenne in price_basis kurz die Überlegung (z.B. Neupreis ca. X €, gebraucht üblich Y–Z €).';
    parts.push({ text:
`Erstelle ein ehrliches Second-Hand-Inserat auf Deutsch.

ALLGEMEINE VORGABEN:
${settings.generalPrompt}

ANGABEN ZUM GEGENSTAND:
${hints || 'Keine zusätzlichen Angaben.'}

ZUSTAND:
${condition || 'Nicht angegeben – nur aus den Fotos ableiten, wenn eindeutig.'}

${priceRule}

REGELN:
- Nichts erfinden. Unsichere Merkmale nicht als Fakten darstellen.
- Titel maximal 60 Zeichen, nach den allgemeinen Vorgaben aufgebaut.
- Beschreibung ausschließlich kurze Stichpunkte (jede Zeile beginnt mit "• "), keine Fließtexte.
- Zustand im Text passend nennen.
- price_eur als Zahl in Euro.
- search_query: kurzer Suchbegriff für Vergleichsangebote.` });

    let result;
    let searchNote = '';
    try {
      result = await callGemini(settings, parts, settings.searchGrounding);
    } catch (e) {
      if (settings.searchGrounding && [400, 403, 429].includes(e.status)) {
        searchNote = '⚠️ Google-Suche nicht verfügbar (z.B. kostenloses Kontingent) – Preis ist eine KI-Schätzung.\n';
        result = await callGemini(settings, parts, false);
      } else throw e;
    }
    if (!result.title || !result.description) throw new Error('Die KI hat Titel oder Beschreibung nicht geliefert.');

    $('#f-name').value = String(result.title).trim().slice(0, 80);
    $('#f-desc').value = String(result.description).trim();
    const cents = parsePriceToCents(result.price_eur);
    if (cents != null) $('#f-price').value = formatPriceInput(cents);
    if (result.search_query) $('#f-query').value = String(result.search_query).trim();
    editor.priceBasis = `${cents != null ? formatPriceDisplay(cents) : 'Preis'}${settings.searchGrounding && !searchNote ? ' (recherchiert)' : ' (KI-Schätzung)'} – ${result.price_basis || ''}`.trim();
    info.className = searchNote ? 'info warn' : 'info';
    info.textContent = `${searchNote}💶 ${editor.priceBasis}${settings.searchGrounding && !searchNote ? '' : '\nTipp: Preis über die Vergleichslinks unten kurz prüfen.'}`;
    markDirty();
    updateNameCount();
    updateCompareLinks();
    toast('✨ Anzeige erstellt');
  } catch (e) {
    info.className = 'info warn';
    info.textContent = 'KI-Fehler: ' + (e.message || e);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Titel, Beschreibung & Preis generieren';
  }
}

/* ------------------------------------------------------------------ */
/* Browser-Erweiterung (optional, PC)                                  */
/* ------------------------------------------------------------------ */
const ext = { available: false, version: null, legacyResolve: null };

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__sm !== 'ext') return;
  const d = e.data;
  if (d.type === 'PONG') {
    const wasAvailable = ext.available;
    ext.available = true;
    ext.version = d.version;
    if (!wasAvailable) {
      updateExtStatus();
      if (currentView === 'publish') route();
    }
  } else if (d.type === 'FILL_STARTED') {
    if (!d.ok) toast('Erweiterung: ' + (d.error || 'Start fehlgeschlagen'), 'err', 6000);
  } else if (d.type === 'FILL_RESULT') {
    const r = d.result || {};
    const label = SITES[d.site]?.label || d.site;
    if (r.ok) toast(`${label}: ${r.summary || 'ausgefüllt'}${r.warning ? ' · ' + r.warning : ''}`, r.warning ? 'err' : 'ok', 7000);
    else toast(`${label}: ${r.error || 'Ausfüllen fehlgeschlagen'}`, 'err', 7000);
  } else if (d.type === 'LEGACY_DATA' && ext.legacyResolve) {
    ext.legacyResolve(d);
    ext.legacyResolve = null;
  }
});
function pingExtension() {
  let n = 0;
  const tick = () => {
    if (ext.available || n++ > 10) { updateExtStatus(); return; }
    window.postMessage({ __sm: 'app', type: 'PING' }, location.origin);
    setTimeout(tick, 500);
  };
  tick();
}
function updateExtStatus() {
  const el = $('#ext-status');
  if (!el) return;
  if (ext.available) {
    el.textContent = `✅ Erweiterung verbunden (Version ${ext.version}). Beim Inserieren werden die Formulare automatisch ausgefüllt.`;
    $('#s-legacy-import').hidden = false;
  } else {
    el.textContent = 'Keine Erweiterung erkannt. Am PC kannst du die „Sales Manager“-Erweiterung installieren, dann füllt die App die Formulare automatisch aus. Auf dem Handy nutzt du Kopieren & Teilen.';
    $('#s-legacy-import').hidden = true;
  }
}

/** Wartet kurz auf eine Antwort der Erweiterung (falls sie beim Laden noch nicht erkannt wurde). */
function waitForExtension(ms = 1500) {
  if (ext.available) return Promise.resolve(true);
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (ext.available) return resolve(true);
      if (Date.now() > end) return resolve(false);
      window.postMessage({ __sm: 'app', type: 'PING' }, location.origin);
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** Button „Öffnen“: mit Erweiterung öffnen + ausfüllen, sonst nur die Seite öffnen. */
async function openAndFill(item, site) {
  if (await waitForExtension()) return fillViaExtension(item, site);
  const w = window.open(getSettings().siteUrls[site], '_blank');
  if (w) { try { w.opener = null; } catch (_) { /* ignorieren */ } }
  toast(w === null
    ? 'Seite konnte nicht geöffnet werden (Pop-up-Blocker?).'
    : `${SITES[site].label} geöffnet – Erweiterung nicht erkannt, bitte per Kopieren ausfüllen.`, w === null ? 'err' : 'ok', 6000);
}

async function fillViaExtension(item, site) {
  busy(true, 'Daten werden an die Erweiterung übergeben …');
  try {
    const images = [];
    for (let i = 0; i < (item.images || []).length; i++) {
      const blob = await exportImageBlob(item.images[i]);
      images.push({ filename: `${slugify(item.name)}-${i + 1}.jpg`, dataUrl: await blobToDataUrl(blob) });
    }
    const payload = {
      name: item.name || '',
      description: item.description || '',
      condition: item.condition || '',
      priceCents: item.priceCents ?? null,
      price: formatPriceFor(item.priceCents ?? null, site),
      images
    };
    window.postMessage({ __sm: 'app', type: 'FILL', site, url: getSettings().siteUrls[site], item: payload, requestId: uid() }, location.origin);
    toast(`${SITES[site].label} wird geöffnet und ausgefüllt …`);
  } finally {
    busy(false);
  }
}

async function importLegacy() {
  if (!ext.available) return;
  const data = await new Promise((resolve) => {
    ext.legacyResolve = resolve;
    window.postMessage({ __sm: 'app', type: 'GET_LEGACY' }, location.origin);
    setTimeout(() => { if (ext.legacyResolve) { ext.legacyResolve(null); ext.legacyResolve = null; } }, 4000);
  });
  if (!data) { toast('Keine Antwort von der Erweiterung.', 'err'); return; }
  const legacy = Array.isArray(data.autofillItems) ? data.autofillItems : [];
  const existing = await dbAll();
  const keys = new Set(existing.map((i) => i.legacyKey).filter(Boolean));
  let added = 0;
  busy(true, 'Übernehme Artikel …');
  try {
    for (const old of legacy) {
      const key = `${old.name}|${old.price}|${(old.images || []).length}`;
      if (keys.has(key)) continue;
      const images = [];
      for (const im of old.images || []) {
        try { images.push({ id: uid(), blob: await dataUrlToBlob(im.dataUrl), rotation: 0 }); } catch (_) { /* überspringen */ }
      }
      const now = Date.now() - added;
      await dbPut({ id: uid(), legacyKey: key, createdAt: now, updatedAt: now, name: old.name || '', priceCents: parsePriceToCents(old.price),
        condition: old.condition || '', description: old.description || '', hints: '', searchQuery: '', priceBasis: '', posted: {}, sold: false, images });
      added++;
    }
    const s = getSettings();
    const oldAi = data.aiSettings || {};
    const patch = {};
    if (!s.apiKey && oldAi.apiKey) patch.apiKey = oldAi.apiKey;
    if (oldAi.generalPrompt && s.generalPrompt === DEFAULT_PROMPT) patch.generalPrompt = oldAi.generalPrompt;
    if (Object.keys(patch).length) saveSettings(patch);
  } finally {
    busy(false);
  }
  loadSettingsForm();
  toast(added ? `${added} Artikel übernommen ✓` : 'Keine neuen Artikel gefunden.');
}

/* ------------------------------------------------------------------ */
/* Inserieren                                                          */
/* ------------------------------------------------------------------ */
let publishState = { item: null, files: null, urls: [] };

async function prepareShareFiles(item) {
  const files = [];
  for (let i = 0; i < (item.images || []).length; i++) {
    const blob = await exportImageBlob(item.images[i]);
    files.push(new File([blob], `${slugify(item.name)}-${i + 1}.jpg`, { type: 'image/jpeg' }));
  }
  return files;
}

async function renderPublish(id) {
  publishState.urls.forEach((u) => URL.revokeObjectURL(u));
  publishState = { item: null, files: null, urls: [] };
  const item = await dbGet(id);
  const root = $('#publish-content');
  if (!item) { root.innerHTML = '<div class="empty">Artikel nicht gefunden.</div>'; return; }
  publishState.item = item;
  publishState.files = prepareShareFiles(item); // Promise – vorbereiten, damit „Teilen“ sofort reagiert

  const cover = item.images?.[0];
  let coverHtmlStr = '<div class="cover">📦</div>';
  if (cover) {
    const u = URL.createObjectURL(cover.blob);
    publishState.urls.push(u);
    coverHtmlStr = `<div class="cover"><img src="${u}" alt="" style="transform:rotate(${cover.rotation || 0}deg)"></div>`;
  }
  const canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' })] }));
  const nImg = item.images?.length || 0;

  let html = `
    <div class="card">
      <div class="pub-head">
        ${coverHtmlStr}
        <div>
          <div class="pub-title">${esc(item.name || 'Ohne Titel')}</div>
          <div class="item-meta"><b>${esc(formatPriceDisplay(item.priceCents))}</b>${item.condition ? ' · ' + esc(item.condition) : ''} · ${nImg} Foto${nImg === 1 ? '' : 's'}</div>
        </div>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn small" data-a="edit" type="button">✏️ Bearbeiten</button>
        <button class="btn small" data-a="sold" type="button">${item.sold ? '↩︎ Wieder aktiv' : '✅ Verkauft'}</button>
      </div>
      ${ext.available
        ? '<p class="info ext-ok">✅ Browser-Erweiterung verbunden – „Öffnen &amp; ausfüllen“ trägt alles automatisch ein.</p>'
        : '<p class="hint">So geht’s auf dem Handy: <b>Fotos teilen</b> oder <b>speichern</b>, dann Titel, Preis und Beschreibung kopieren und in der Vinted-/Kleinanzeigen-App einfügen.</p>'}
    </div>`;

  Object.keys(SITES).forEach((site) => {
    const priceStr = formatPriceFor(item.priceCents ?? null, site);
    const posted = !!(item.posted && item.posted[site]);
    html += `
      <div class="card site-card ${site}" data-site="${site}">
        <div class="card-head">
          <h2>${SITES[site].label}</h2>
          <label class="posted-toggle"><input type="checkbox" data-a="posted" ${posted ? 'checked' : ''}> eingestellt</label>
        </div>
        <button class="btn block ${site}" data-a="fill" type="button">${ext.available ? '↗ Öffnen &amp; automatisch ausfüllen' : `↗ ${esc(SITES[site].label)} öffnen`}</button>
        <div class="btn-row">
          ${canShareFiles ? `<button class="btn small" data-a="share" type="button" ${nImg ? '' : 'disabled'}>📤 Fotos teilen</button>` : ''}
          <button class="btn small" data-a="download" type="button" ${nImg ? '' : 'disabled'}>⬇️ Fotos speichern</button>
        </div>
        <div class="copy-grid">
          <button class="btn" data-a="copy-title" type="button">Titel</button>
          <button class="btn" data-a="copy-price" type="button" ${priceStr ? '' : 'disabled'}>Preis ${esc(priceStr)}</button>
          <button class="btn" data-a="copy-desc" type="button">Beschreibung</button>
        </div>
        ${site === 'kleinanzeigen' && item.priceCents != null && item.priceCents % 100 !== 0 ? '<p class="hint">Kleinanzeigen akzeptiert nur ganze Euro – Preis wurde gerundet.</p>' : ''}
      </div>`;
  });
  root.innerHTML = html;

  root.querySelector('[data-a=edit]').onclick = () => go('#/edit/' + encodeURIComponent(item.id));
  root.querySelector('[data-a=sold]').onclick = async () => {
    item.sold = !item.sold;
    item.updatedAt = Date.now();
    await dbPut(item);
    toast(item.sold ? 'Als verkauft markiert' : 'Wieder aktiv');
    renderPublish(item.id);
  };
  $$('.site-card', root).forEach((card) => {
    const site = card.dataset.site;
    const on = (a, fn) => { const el = card.querySelector(`[data-a=${a}]`); if (el) el.onclick = fn; };
    on('fill', () => openAndFill(item, site));
    on('share', () => shareImages(item));
    on('download', () => downloadImages(item));
    on('copy-title', () => copyText(item.name || '', 'Titel'));
    on('copy-price', () => copyText(formatPriceFor(item.priceCents ?? null, site), 'Preis'));
    on('copy-desc', () => copyText(item.description || '', 'Beschreibung'));
    const cb = card.querySelector('[data-a=posted]');
    cb.onchange = async () => {
      item.posted = { ...(item.posted || {}), [site]: cb.checked };
      item.updatedAt = Date.now();
      await dbPut(item);
      toast(cb.checked ? `Bei ${SITES[site].label} als eingestellt markiert` : 'Markierung entfernt');
    };
  });
}

async function shareImages(item) {
  try {
    const files = await publishState.files;
    if (!files.length) return;
    if (navigator.canShare && !navigator.canShare({ files })) { toast('Teilen dieser Fotos wird nicht unterstützt – nutze „Fotos speichern“.', 'err'); return; }
    await navigator.share({ files, title: item.name || 'Fotos' });
  } catch (e) {
    if (e.name !== 'AbortError') toast('Teilen fehlgeschlagen: ' + e.message, 'err');
  }
}
async function downloadImages(item) {
  const files = await publishState.files;
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    await sleep(350);
  }
  toast(`${files.length} Foto${files.length === 1 ? '' : 's'} gespeichert`);
}

/* ------------------------------------------------------------------ */
/* Einstellungen & Backup                                              */
/* ------------------------------------------------------------------ */
function loadSettingsForm() {
  const s = getSettings();
  $('#s-apikey').value = s.apiKey;
  $('#s-model').value = s.model;
  $('#s-grounding').checked = s.searchGrounding;
  $('#s-prompt').value = s.generalPrompt;
  $('#s-fullres').checked = s.fullResCamera;
  Object.keys(SITES).forEach((k) => { $('#s-url-' + k).value = s.siteUrls[k]; });
  updateExtStatus();
  updateStorageInfo();
}
function saveSettingsForm() {
  const urls = {};
  Object.keys(SITES).forEach((k) => { urls[k] = $('#s-url-' + k).value.trim() || SITES[k].url; });
  saveSettings({
    apiKey: $('#s-apikey').value.trim(),
    model: $('#s-model').value.trim() || DEFAULT_MODEL,
    searchGrounding: $('#s-grounding').checked,
    generalPrompt: $('#s-prompt').value.trim() || DEFAULT_PROMPT,
    fullResCamera: $('#s-fullres').checked,
    siteUrls: urls
  });
  toast('Einstellungen gespeichert ✓');
}
async function updateStorageInfo() {
  const el = $('#storage-info');
  if (!navigator.storage || !navigator.storage.estimate) { el.textContent = ''; return; }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    el.textContent = `Belegt: ${(usage / 1048576).toFixed(1)} MB von ca. ${(quota / 1073741824).toFixed(1)} GB${persisted ? ' · dauerhaft gespeichert' : ''}`;
  } catch (_) { el.textContent = ''; }
}
async function exportBackup() {
  busy(true, 'Export wird erstellt …');
  try {
    const items = await dbAll();
    const out = [];
    for (const it of items) {
      const images = [];
      for (const im of it.images || []) images.push({ id: im.id, rotation: im.rotation || 0, dataUrl: await blobToDataUrl(im.blob) });
      out.push({ ...it, images });
    }
    const s = getSettings();
    delete s.apiKey;
    const blob = new Blob([JSON.stringify({ app: 'sales-manager', version: APP_VERSION, exportedAt: new Date().toISOString(), settings: s, items: out })], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`${items.length} Artikel exportiert`);
  } catch (e) {
    toast('Export fehlgeschlagen: ' + e.message, 'err');
  } finally {
    busy(false);
  }
}
async function importBackup(file) {
  busy(true, 'Import läuft …');
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'sales-manager' || !Array.isArray(data.items)) throw new Error('Keine Sales-Manager-Sicherung');
    let n = 0;
    for (const it of data.items) {
      const images = [];
      for (const im of it.images || []) images.push({ id: im.id || uid(), rotation: im.rotation || 0, blob: await dataUrlToBlob(im.dataUrl) });
      await dbPut({ ...it, id: it.id || uid(), images });
      n++;
    }
    if (data.settings) {
      const { apiKey, ...rest } = data.settings;
      saveSettings(rest);
      loadSettingsForm();
    }
    toast(`${n} Artikel importiert ✓`);
  } catch (e) {
    toast('Import fehlgeschlagen: ' + e.message, 'err', 6000);
  } finally {
    busy(false);
  }
}

/* ------------------------------------------------------------------ */
/* Installation (PWA)                                                  */
/* ------------------------------------------------------------------ */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#nav-install').hidden = false;
});
window.addEventListener('appinstalled', () => { $('#nav-install').hidden = true; installPrompt = null; });

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
function init() {
  $('#app-version').textContent = `Sales Manager ${APP_VERSION}`;

  // Navigation
  $('#nav-back').onclick = () => go('#/');
  $('#nav-settings').onclick = () => go('#/settings');
  $('#nav-install').onclick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    $('#nav-install').hidden = true;
  };
  $('#fab-new').onclick = () => go('#/new');

  // Liste
  $('#search').addEventListener('input', (e) => { listSearch = e.target.value; renderList(); });
  $$('#filter-seg button').forEach((b) => {
    b.onclick = () => {
      listFilter = b.dataset.filter;
      $$('#filter-seg button').forEach((x) => x.classList.toggle('on', x === b));
      renderList();
    };
  });

  // Editor
  $('#btn-camera').onclick = openCamera;
  $('#btn-syscam').onclick = () => $('#in-syscam').click();
  $('#btn-gallery').onclick = () => $('#in-gallery').click();
  $('#in-gallery').onchange = async (e) => { await addImageFiles(e.target.files); e.target.value = ''; };
  $('#in-syscam').onchange = async (e) => { await addImageFiles(e.target.files); e.target.value = ''; };
  ['#f-name', '#f-price', '#f-condition', '#f-hints', '#f-desc', '#f-query'].forEach((s) => {
    $(s).addEventListener('input', markDirty);
    $(s).addEventListener('change', markDirty);
  });
  $('#f-name').addEventListener('input', () => { updateNameCount(); updateCompareLinks(); });
  $('#f-query').addEventListener('input', updateCompareLinks);
  $('#f-price').addEventListener('blur', () => {
    const raw = $('#f-price').value.trim();
    if (!raw) return;
    const c = parsePriceToCents(raw);
    if (c == null) toast('Preis nicht erkannt – bitte z.B. 12,50 eingeben.', 'err');
    else $('#f-price').value = formatPriceInput(c);
  });
  $('#btn-ai').onclick = generateWithAi;
  $('#btn-save').onclick = saveEditor;
  $('#btn-cancel').onclick = () => go('#/');

  // Kamera
  $('#cam-shutter').onclick = capturePhoto;
  $('#cam-done').onclick = closeCamera;
  $('#cam-close').onclick = closeCamera;
  $('#cam-torch').onclick = toggleTorch;
  document.addEventListener('keydown', (e) => {
    if ($('#camera').hidden) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); capturePhoto(); }
    if (e.key === 'Escape') closeCamera();
  });
  setupLightbox();

  // Einstellungen
  $('#s-save').onclick = saveSettingsForm;
  $('#s-prompt-reset').onclick = () => { $('#s-prompt').value = DEFAULT_PROMPT; };
  $('#s-export').onclick = exportBackup;
  $('#s-import').onclick = () => $('#in-backup').click();
  $('#in-backup').onchange = async (e) => { if (e.target.files[0]) await importBackup(e.target.files[0]); e.target.value = ''; };
  $('#s-legacy-import').onclick = importLegacy;

  window.addEventListener('beforeunload', (e) => {
    if (currentView === 'editor' && editor.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('hashchange', route);

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
  }
  pingExtension();
  route();
}

// Für Tests exportieren
window.SM = { parsePriceToCents, formatPriceFor, formatPriceInput };

init();
