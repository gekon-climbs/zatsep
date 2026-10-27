// Хранение данных в IndexedDB браузера. Данные живут отдельно от кода приложения,
// поэтому обновление версии (новые файлы на хостинге) их не затрагивает.

const DB_NAME = 'zatsep';
const STORE = 'kv';

// Версия формата данных. Если в новой версии приложения меняется структура данных:
// увеличь SCHEMA_VERSION и добавь функцию в MIGRATIONS, которая переводит старые данные в новый вид.
export const SCHEMA_VERSION = 1;

const MIGRATIONS = {
  // 2: (s) => { s.climbs.forEach((c) => { c.note = ''; }); return s; },
};

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessions: [],
    climbs: [],
    projects: [],
    goals: [],
    rank: { g: 0, history: [] },
    seen: { ach: [], level: 1 },
    settings: { windowWeeks: 8, autoEndMin: 40 },
    lastBackupAt: null,
  };
}

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idbGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function migrate(s) {
  let v = s.schemaVersion || 1;
  if (v > SCHEMA_VERSION) throw new Error('Данные созданы более новой версией приложения');
  while (v < SCHEMA_VERSION) {
    v += 1;
    if (MIGRATIONS[v]) s = MIGRATIONS[v](s);
    s.schemaVersion = v;
  }
  return s;
}

// Новые поля, появившиеся в новых версиях, получают значения по умолчанию.
function withDefaults(s) {
  const d = emptyState();
  for (const k of Object.keys(d)) if (s[k] === undefined) s[k] = d[k];
  s.settings = { ...d.settings, ...s.settings };
  s.seen = { ...d.seen, ...s.seen };
  s.rank = { ...d.rank, ...s.rank };
  return s;
}

export async function loadState() {
  const raw = await idbGet('state');
  if (!raw) return emptyState();
  const from = raw.schemaVersion || 1;
  // Перед миграцией сохраняем нетронутую копию: если что-то пойдёт не так, данные можно вернуть.
  if (from < SCHEMA_VERSION) await idbSet(`backup-schema-${from}`, raw);
  return withDefaults(migrate(structuredClone(raw)));
}

let saving = Promise.resolve();
export function saveState(s) {
  saving = saving.then(() => idbSet('state', s)).catch((e) => console.error('Не удалось сохранить', e));
  return saving;
}
export const flush = () => saving;

export function saveBackupCopy(s, label) {
  return idbSet(`backup-${label}-${Date.now()}`, s);
}

export function backupBlob(s) {
  const payload = { app: 'zatsep', exportedAt: new Date().toISOString(), data: s };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export function parseBackup(text) {
  const j = JSON.parse(text);
  const s = j && j.app === 'zatsep' ? j.data : null;
  if (!s || !Array.isArray(s.climbs)) throw new Error('Это не файл резервной копии Зацепа');
  return withDefaults(migrate(s));
}

// Просим браузер не удалять данные при нехватке места.
export async function requestPersist() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function isPersisted() {
  return navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : false;
}
