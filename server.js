const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Redis } = require('@upstash/redis');
const webpush = require('web-push');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT || 3000);
const TZ = 'America/Guayaquil';
const ADMIN_PASSWORD = 'leo123';
const REDIS_KEY = 'tareas_hogar_state';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
if (PUSH_ENABLED) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;
let persistenceQueue = Promise.resolve();

function initialState() {
  const zones = [
    ['ARRIBA', 'Made', '#06b6d4', ['Barrer cacas gallina y cornio', 'Barrer todo terraza', 'Dar de comer de dia gallinas y perros', 'Clasificar ropa']],
    ['AFUERA', 'Maciel', '#a855f7', ['Limpiar cacas Ramon', 'Dar de comer noche perros', 'Limpiar pasillo', 'Colgar ropa']],
    ['COCINA', 'Leo', '#22c55e', ['Limpiar cocina, microondas, refri', 'Barrer', 'Trapear', 'Limpiar meson', 'Trapos']],
    ['SALA', 'Mati', '#3b82f6', ['Arreglar sillones', 'Mesas 3', 'Recoger ropa', 'Botar basura de todo', 'Barrer y trapear']],
    ['BAÑO', 'Libro y Angel', '#f97316', ['Limpieza de baño']]
  ].map(([name, person, color, tasks]) => {
    const id = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return {
    id, name, person, color, permission: false, permissionReason: '', notes: [],
    ...(name === 'BAÑO' ? { responsables: ['Libro', 'Angel'], personasPermitidas: ['Libro', 'Angel'] } : {}),
    tasks: tasks.map((text, i) => ({ id: `${id}-${i + 1}`, text, done: false, markedBy: null, markedAt: null }))
  }; });
  return { date: dateInZone(new Date()), zones, streaks: {}, history: [], reminders: [], pushSubscriptions: {}, notices: {}, cicloInicio: ecuadorDateTime(new Date()), perfilesBloqueados: {}, profileResetVersion: 1, ultimoSorteo: null };
}

function dateInZone(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function timeInZone(date) {
  return new Intl.DateTimeFormat('es-EC', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function ecuadorDateTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const localAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  const instant = Math.floor(date.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((localAsUtc - instant) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absOffset / 60)).padStart(2, '0')}:${String(absOffset % 60).padStart(2, '0')}`;
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${offset}`;
}
function readLocalState() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('data.json no se pudo leer:', err.message);
    return null;
  }
}
function normalizeState(saved) {
  const defaults = initialState();
  try {
    saved = saved && typeof saved === 'string' ? JSON.parse(saved) : saved;
    if (!saved || typeof saved !== 'object') saved = defaults;
    const shouldResetOldProfiles = Number(saved.profileResetVersion || 0) < 1;
    const normalized = { ...defaults, ...saved };
    if (!Array.isArray(normalized.zones)) normalized.zones = defaults.zones;
    for (const defaultZone of defaults.zones) {
      if (!normalized.zones.some(zone => zone.id === defaultZone.id)) normalized.zones.push(defaultZone);
    }
    const bathroom = normalized.zones.find(zone => zone.id === 'bano');
    if (bathroom) {
      bathroom.responsables ||= ['Libro', 'Angel'];
      bathroom.personasPermitidas ||= ['Libro', 'Angel'];
      bathroom.person ||= 'Libro y Angel';
    }
    for (const zone of normalized.zones) { zone.permissionReason ||= ''; zone.notes ||= []; }
    if (!normalized.cicloInicio) normalized.cicloInicio = ecuadorDateTime(new Date());
    if (!normalized.perfilesBloqueados || Array.isArray(normalized.perfilesBloqueados)) normalized.perfilesBloqueados = {};
    if (!Object.hasOwn(normalized, 'ultimoSorteo')) normalized.ultimoSorteo = null;
    if (!Array.isArray(normalized.history)) normalized.history = [];
    if (!Array.isArray(normalized.reminders)) normalized.reminders = [];
    if (!normalized.pushSubscriptions || typeof normalized.pushSubscriptions !== 'object' || Array.isArray(normalized.pushSubscriptions)) normalized.pushSubscriptions = {};
    if (!normalized.streaks || typeof normalized.streaks !== 'object') normalized.streaks = {};
    if (!normalized.notices || typeof normalized.notices !== 'object') normalized.notices = {};
    if (shouldResetOldProfiles) {
      for (const profile of Object.values(normalized.perfilesBloqueados)) {
        const zone = normalized.zones.find(item => item.id === profile.zoneId);
        if (!zone) continue;
        if (Array.isArray(zone.responsables)) {
          zone.responsables = zone.responsables.filter(person => person.toLocaleLowerCase() !== String(profile.name || '').toLocaleLowerCase());
          zone.person = zone.responsables.join(' y ');
        } else if (String(zone.person || '').toLocaleLowerCase() === String(profile.name || '').toLocaleLowerCase()) zone.person = '';
      }
      normalized.perfilesBloqueados = {};
      normalized.pushSubscriptions = {};
      normalized.profileResetVersion = 1;
    }
    return normalized;
  } catch (err) { console.error('Estado guardado inválido:', err.message); return defaults; }
}
let state;
function writeLocalSnapshot(serialized) {
  try { fs.writeFileSync(DATA_FILE, serialized, 'utf8'); }
  catch (err) { console.error('No se pudo guardar data.json:', err.message); }
}
function persist() {
  const serialized = JSON.stringify(state, null, 2);
  writeLocalSnapshot(serialized);
  if (!redis) return persistenceQueue;
  persistenceQueue = persistenceQueue.catch(() => {}).then(() => redis.set(REDIS_KEY, JSON.parse(serialized)))
    .catch(err => { console.error('No se pudo guardar en Upstash Redis; queda el respaldo local:', err.message); });
  return persistenceQueue;
}
async function loadState() {
  let saved = null;
  let redisEmpty = false;
  if (redis) {
    try { saved = await redis.get(REDIS_KEY); redisEmpty = saved === null || saved === undefined; }
    catch (err) { console.error('No se pudo leer Upstash Redis; se usará data.json:', err.message); }
  }
  if (saved === null || saved === undefined) saved = readLocalState() || initialState();
  state = normalizeState(saved);
  if (redis) {
    try { await redis.set(REDIS_KEY, state); }
    catch (err) { console.error(`No se pudo ${redisEmpty ? 'inicializar' : 'actualizar'} Upstash Redis; se usará data.json como respaldo:`, err.message); }
  }
  writeLocalSnapshot(JSON.stringify(state, null, 2));
}

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(ROOT, 'public')));
let server;
let io;

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
app.get('/api/state', (_req, res) => res.json(publicState()));
app.get('/api/config', (_req, res) => res.json({ date: dateInZone(new Date()), time: timeInZone(new Date()), timezone: TZ }));

function publicState() {
  const { perfilesBloqueados, profileResetVersion, pushSubscriptions, ...visible } = state;
  return visible;
}
function sendState() {
  persist();
  if (!io) return;
  io.emit('state', publicState());
  for (const socket of io.sockets.sockets.values()) {
    const profile = state.perfilesBloqueados[socket.data.deviceId];
    if (profile) socket.emit('profile', { name: profile.name, zoneId: profile.zoneId, deviceId: profile.deviceId });
    else if (socket.data.deviceId) { delete socket.data.deviceId; delete socket.data.person; socket.emit('profile-unlinked'); }
  }
}
function zoneById(id) { return state.zones.find(z => z.id === id); }
function profileForDevice(deviceId) { return state.perfilesBloqueados[String(deviceId || '')]; }
function requirePassword(req, res) {
  if (req.body?.password !== ADMIN_PASSWORD) { res.status(403).json({ error: 'Contraseña incorrecta.' }); return false; }
  return true;
}
function canMarkZone(deviceId, zone) {
  const profile = profileForDevice(deviceId);
  const isResponsible = zone?.responsables
    ? zone.responsables.some(person => person.toLocaleLowerCase() === profile?.name.toLocaleLowerCase())
    : profile?.name === zone?.person;
  return Boolean(profile && zone && profile.zoneId === zone.id && isResponsible);
}
function releaseZoneAssignment(zone, name) {
  if (!zone) return;
  if (Array.isArray(zone.responsables)) {
    zone.responsables = zone.responsables.filter(person => person.toLocaleLowerCase() !== String(name).toLocaleLowerCase());
    zone.person = zone.responsables.join(' y ');
  } else if (zone.person === name) zone.person = '';
}
function assignZone(zone, name) {
  if (Array.isArray(zone.responsables)) {
    if (!zone.responsables.some(person => person.toLocaleLowerCase() === name.toLocaleLowerCase())) zone.responsables.push(name);
    zone.person = zone.responsables.join(' y ');
  } else zone.person = name;
}
function pushProfileId(name) { return String(name || '').trim().toLocaleLowerCase(); }
function removePushSubscriptionsForDevice(deviceId) {
  for (const [profileId, entries] of Object.entries(state.pushSubscriptions || {})) {
    const kept = entries.filter(entry => entry.deviceId !== deviceId);
    if (kept.length) state.pushSubscriptions[profileId] = kept;
    else delete state.pushSubscriptions[profileId];
  }
}
function movePushSubscriptionsForDevice(deviceId, nextProfileId) {
  const moved = [];
  for (const [profileId, entries] of Object.entries(state.pushSubscriptions || {})) {
    const kept = entries.filter(entry => {
      if (entry.deviceId !== deviceId) return true;
      moved.push(entry);
      return false;
    });
    if (kept.length) state.pushSubscriptions[profileId] = kept;
    else delete state.pushSubscriptions[profileId];
  }
  if (!moved.length) return;
  const target = state.pushSubscriptions[nextProfileId] ||= [];
  for (const entry of moved) if (!target.some(existing => existing.subscription.endpoint === entry.subscription.endpoint)) target.push(entry);
}
async function sendPushToProfile(profileId, { title, body, url = '/' } = {}) {
  if (!PUSH_ENABLED) return 0;
  const key = pushProfileId(profileId);
  const entries = [...(state.pushSubscriptions[key] || [])];
  let delivered = 0;
  let removedExpired = false;
  const payload = JSON.stringify({ title: title || 'Tareas del Hogar', body: body || '', url });
  for (const entry of entries) {
    try {
      await webpush.sendNotification(entry.subscription, payload);
      delivered++;
    } catch (error) {
      const statusCode = error.statusCode || error.status;
      console.warn('No se pudo enviar push:', statusCode || error.message);
      if (statusCode === 404 || statusCode === 410) { removePushSubscriptionsForDevice(entry.deviceId); removedExpired = true; }
    }
  }
  if (removedExpired) await persist();
  return delivered;
}
function isValidCronSecret(req) {
  if (!CRON_SECRET) return false;
  const authorization = String(req.get('authorization') || '');
  const candidate = String(req.get('x-cron-secret') || (authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7) : ''));
  const expectedBuffer = Buffer.from(CRON_SECRET);
  const actualBuffer = Buffer.from(candidate);
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

app.get('/api/vapid-public-key', (_req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: 'Las notificaciones push aún no están configuradas en el servidor.' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});
app.post('/api/push/subscribe', async (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: 'Las notificaciones push aún no están configuradas en el servidor.' });
  const deviceId = String(req.body?.deviceId || '').trim().slice(0, 100);
  const profile = profileForDevice(deviceId);
  const profileId = pushProfileId(req.body?.profileId);
  const subscription = req.body?.subscription;
  if (!profile || profileId !== pushProfileId(profile.name)) return res.status(403).json({ error: 'El perfil del dispositivo no coincide.' });
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ error: 'La suscripción push no es válida.' });
  const entries = state.pushSubscriptions[profileId] ||= [];
  const duplicate = entries.findIndex(entry => entry.subscription?.endpoint === subscription.endpoint);
  const record = { deviceId, subscription };
  if (duplicate >= 0) entries[duplicate] = record;
  else entries.push(record);
  await persist();
  res.json({ ok: true, profileId, devices: entries.length });
});
app.post('/api/push/remind-pending', async (req, res) => {
  if (!CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET no está configurado.' });
  if (!isValidCronSecret(req)) return res.status(401).json({ error: 'Secreto de cron no válido.' });
  if (!PUSH_ENABLED) return res.status(503).json({ error: 'Las notificaciones push aún no están configuradas en el servidor.' });
  rollover();
  const pending = new Map();
  for (const zone of state.zones) {
    if (zone.permission) continue;
    const tasks = zone.tasks.filter(task => !task.done).map(task => task.text);
    if (!tasks.length) continue;
    const people = zone.responsables || (zone.person ? [zone.person] : []);
    for (const person of people) {
      const key = pushProfileId(person);
      if (!key) continue;
      const previous = pending.get(key);
      if (previous) previous.tasks.push(...tasks);
      else pending.set(key, { name: person, zone: zone.name, tasks: [...tasks] });
    }
  }
  let sent = 0;
  for (const [profileId, item] of pending) {
    const uniqueTasks = [...new Set(item.tasks)];
    sent += await sendPushToProfile(profileId, {
      title: `Tareas pendientes · ${item.zone}`,
      body: uniqueTasks.length > 2 ? `${uniqueTasks.slice(0, 2).join(', ')} y ${uniqueTasks.length - 2} más` : uniqueTasks.join(', '),
      url: '/'
    });
  }
  res.json({ ok: true, date: dateInZone(new Date()), profiles: pending.size, notificationsSent: sent });
});

app.post('/api/profile/claim', (req, res) => {
  drawRolesIfDue();
  const deviceId = String(req.body?.deviceId || '').trim().slice(0, 100);
  const claimed = state.perfilesBloqueados[deviceId];
  if (!deviceId) return res.status(400).json({ error: 'No se identificó este dispositivo.' });
  if (claimed) return res.json({ profile: { name: claimed.name, zoneId: claimed.zoneId, deviceId }, state: publicState() });

  const name = String(req.body?.name || '').trim().slice(0, 40);
  const zone = zoneById(req.body?.zoneId);
  if (!name || !zone) return res.status(409).json({ error: 'Este dispositivo no está vinculado. Elige un nombre y una zona para registrarlo.' });
  const otherDevice = Object.values(state.perfilesBloqueados).find(entry => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (otherDevice) return res.status(409).json({ error: 'Este nombre ya está vinculado a otro dispositivo. Para cambiar de celular, elimina su registro en data.json.' });
  const permittedNames = zone.personasPermitidas || zone.responsables;
  if (permittedNames && !permittedNames.some(person => person.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return res.status(403).json({ error: `El rol ${zone.name} está reservado para ${zone.responsables.join(' y ')}.` });
  }
  if (zone.id === 'bano' && Object.values(state.perfilesBloqueados).filter(entry => entry.zoneId === 'bano').length >= 2) {
    return res.status(409).json({ error: 'El rol BAÑO admite como máximo dos personas.' });
  }
  const zoneLock = Object.values(state.perfilesBloqueados).find(entry => entry.zoneId === zone.id);
  if (zoneLock && !zone.responsables) return res.status(409).json({ error: 'Esta zona ya está vinculada a otro dispositivo.' });

  assignZone(zone, name);
  if (!state.streaks[name]) state.streaks[name] = 0;
  state.perfilesBloqueados[deviceId] = { deviceId, name, zoneId: zone.id, cicloInicio: state.cicloInicio };
  sendState();
  res.json({ profile: { name, zoneId: zone.id, deviceId }, state: publicState() });
});
app.post('/api/profile/change', (req, res) => {
  if (!requirePassword(req, res)) return;
  const deviceId = String(req.body?.deviceId || '').trim().slice(0, 100);
  const profile = profileForDevice(deviceId);
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const zone = zoneById(req.body?.zoneId);
  if (!profile) return res.status(404).json({ error: 'Este dispositivo no tiene un perfil registrado.' });
  if (!name || !zone) return res.status(400).json({ error: 'Nombre y zona son obligatorios.' });
  const duplicateName = Object.values(state.perfilesBloqueados).find(entry => entry.deviceId !== deviceId && entry.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (duplicateName) return res.status(409).json({ error: 'Ese nombre ya está vinculado a otro dispositivo.' });
  const permittedNames = zone.personasPermitidas || zone.responsables;
  if (permittedNames && !permittedNames.some(person => person.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return res.status(403).json({ error: `El rol ${zone.name} está reservado para ${zone.responsables.join(' y ')}.` });
  }
  const occupiedZone = Object.values(state.perfilesBloqueados).find(entry => entry.deviceId !== deviceId && entry.zoneId === zone.id);
  if (occupiedZone && !zone.responsables) return res.status(409).json({ error: 'Esa zona ya está vinculada a otro dispositivo.' });
  if (zone.id === 'bano' && Object.values(state.perfilesBloqueados).filter(entry => entry.deviceId !== deviceId && entry.zoneId === 'bano').length >= 2) {
    return res.status(409).json({ error: 'El rol BAÑO admite como máximo dos personas.' });
  }
  const oldZone = zoneById(profile.zoneId);
  releaseZoneAssignment(oldZone, profile.name);
  movePushSubscriptionsForDevice(deviceId, pushProfileId(name));
  assignZone(zone, name);
  profile.name = name;
  profile.zoneId = zone.id;
  if (!state.streaks[name]) state.streaks[name] = 0;
  sendState();
  res.json({ profile: { name, zoneId: zone.id, deviceId }, state: publicState() });
});
app.post('/api/profile/unlink', (req, res) => {
  if (!requirePassword(req, res)) return;
  const deviceId = String(req.body?.deviceId || '').trim().slice(0, 100);
  const profile = profileForDevice(deviceId);
  if (!profile) return res.status(404).json({ error: 'Este dispositivo no tiene un perfil vinculado.' });
  releaseZoneAssignment(zoneById(profile.zoneId), profile.name);
  delete state.perfilesBloqueados[deviceId];
  removePushSubscriptionsForDevice(deviceId);
  sendState();
  res.json({ state: publicState() });
});
app.post('/api/profile/list', (req, res) => {
  if (!requirePassword(req, res)) return;
  const profiles = Object.values(state.perfilesBloqueados).map(profile => ({ deviceId: profile.deviceId, name: profile.name, zoneId: profile.zoneId }));
  res.json({ profiles });
});
app.post('/api/profile/unlink-all', (req, res) => {
  if (!requirePassword(req, res)) return;
  for (const profile of Object.values(state.perfilesBloqueados)) releaseZoneAssignment(zoneById(profile.zoneId), profile.name);
  state.perfilesBloqueados = {};
  state.pushSubscriptions = {};
  sendState();
  res.json({ state: publicState() });
});
app.post('/api/permission', (req, res) => {
  const zone = zoneById(req.body?.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zona no encontrada.' });
  const profile = profileForDevice(req.body?.deviceId);
  if (!profile || !canMarkZone(profile.deviceId, zone)) return res.status(403).json({ error: 'Solo la persona responsable puede cambiar el permiso de su rol.' });
  const enabled = Boolean(req.body.enabled);
  const reason = String(req.body?.reason || '').trim().slice(0, 180);
  if (enabled && !reason) return res.status(400).json({ error: 'Escribe un motivo antes de activar el permiso.' });
  zone.permission = enabled;
  zone.permissionReason = enabled ? reason : '';
  sendState(); res.json(publicState());
});
app.post('/api/notice/dismiss', (req, res) => {
  const person = String(req.body?.person || '').trim();
  const profile = profileForDevice(req.body?.deviceId);
  if (!profile || profile.name.toLocaleLowerCase() !== person.toLocaleLowerCase()) return res.status(403).json({ error: 'No puedes modificar avisos de otro perfil.' });
  if (person) delete state.notices[person];
  sendState(); res.json(publicState());
});
app.post('/api/zone/:zoneId/notes', (req, res) => {
  const zone = zoneById(req.params.zoneId);
  const profile = profileForDevice(req.body?.deviceId);
  const text = String(req.body?.text || '').trim().slice(0, 600);
  if (!zone) return res.status(404).json({ error: 'Zona no encontrada.' });
  if (!profile) return res.status(403).json({ error: 'Vincula un perfil antes de escribir una nota.' });
  if (!text) return res.status(400).json({ error: 'Escribe una nota antes de guardarla.' });
  const note = { id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, author: profile.name, about: zone.person || 'Sin responsable', text, createdAt: ecuadorDateTime(new Date()) };
  zone.notes.unshift(note);
  zone.notes = zone.notes.slice(0, 200);
  sendState();
  res.json({ note, state: publicState() });
});
app.post('/api/task/toggle', (req, res) => {
  const zone = zoneById(req.body?.zoneId);
  const task = zone?.tasks.find(t => t.id === req.body?.taskId);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada.' });
  if (!canMarkZone(req.body?.deviceId, zone)) return res.status(403).json({ error: 'Solo puedes marcar las actividades de tu propio rol.' });
  const who = profileForDevice(req.body.deviceId).name;
  task.done = Boolean(req.body.done);
  task.markedBy = task.done ? who : null;
  task.markedAt = task.done ? timeInZone(new Date()) : null;
  sendState(); res.json(publicState());
});
app.post('/api/task', (req, res) => {
  if (!profileForDevice(req.body?.deviceId)) return res.status(403).json({ error: 'Vincula un perfil antes de modificar tareas.' });
  const zone = zoneById(req.body?.zoneId);
  const text = String(req.body?.text || '').trim().slice(0, 120);
  if (!zone || !text) return res.status(400).json({ error: 'Zona y descripción son obligatorias.' });
  const task = { id: `${zone.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, done: false, markedBy: null, markedAt: null };
  zone.tasks.push(task); sendState(); res.json(task);
});
app.delete('/api/task/:zoneId/:taskId', (req, res) => {
  if (!requirePassword(req, res)) return;
  if (!profileForDevice(req.body?.deviceId)) return res.status(403).json({ error: 'Vincula un perfil antes de modificar tareas.' });
  const zone = zoneById(req.params.zoneId);
  const index = zone?.tasks.findIndex(task => task.id === req.params.taskId) ?? -1;
  if (!zone || index < 0) return res.status(404).json({ error: 'Tarea no encontrada.' });
  zone.tasks.splice(index, 1);
  sendState(); res.json(publicState());
});
app.patch('/api/task/:zoneId/:taskId', (req, res) => {
  if (!requirePassword(req, res)) return;
  if (!profileForDevice(req.body?.deviceId)) return res.status(403).json({ error: 'Vincula un perfil antes de modificar tareas.' });
  const zone = zoneById(req.params.zoneId);
  const task = zone?.tasks.find(t => t.id === req.params.taskId);
  const text = String(req.body?.text || '').trim().slice(0, 120);
  if (!task || !text) return res.status(400).json({ error: 'Tarea o descripción no válida.' });
  task.text = text; sendState(); res.json(publicState());
});
app.post('/api/reminders', (req, res) => {
  const profile = profileForDevice(req.body?.deviceId);
  if (!profile) return res.status(403).json({ error: 'Vincula un perfil para agregar un recordatorio.' });
  const title = String(req.body?.title || '').trim().slice(0, 120);
  const date = String(req.body?.date || '');
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date || date < dateInZone(new Date())) return res.status(400).json({ error: 'Escribe un título y una fecha futura válida.' });
  const reminder = { id: `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, date, createdBy: profile.name, createdAt: ecuadorDateTime(new Date()) };
  state.reminders.unshift(reminder);
  state.reminders = state.reminders.slice(0, 300);
  sendState(); res.json({ reminder, state: publicState() });
});

function rollover() {
  const today = dateInZone(new Date());
  if (state.date === today) return;
  const yesterday = state.date;
  for (const zone of state.zones) {
    const persons = (zone.responsables || [zone.person]).filter(Boolean);
    const personLabel = zone.person || 'Sin responsable';
    const dailyNotes = Array.isArray(zone.notes) ? zone.notes.map(note => ({ ...note })) : [];
    if (zone.permission) {
      if (zone.permissionReason || dailyNotes.length) state.history.unshift({ date: yesterday, person: personLabel, zone: zone.name, type: 'permiso', reason: zone.permissionReason, tasks: [], notes: dailyNotes });
    } else {
      const unfinished = zone.tasks.filter(t => !t.done).map(t => t.text);
      const complete = unfinished.length === 0;
      for (const person of persons) state.streaks[person] = complete ? (state.streaks[person] || 0) + 1 : 0;
      if (unfinished.length) {
        state.history.unshift({ date: yesterday, person: personLabel, zone: zone.name, tasks: unfinished, notes: dailyNotes });
        for (const person of persons) state.notices[person] = { date: yesterday, tasks: unfinished, zone: zone.name };
      } else if (dailyNotes.length) state.history.unshift({ date: yesterday, person: personLabel, zone: zone.name, tasks: [], notes: dailyNotes });
    }
    zone.permission = false;
    zone.permissionReason = '';
    zone.notes = [];
    for (const task of zone.tasks) { task.done = false; task.markedBy = null; task.markedAt = null; }
  }
  state.history = state.history.slice(0, 500);
  state.date = today;
  sendState();
}

const CYCLE_MS = 45 * 24 * 60 * 60 * 1000;
function drawRolesIfDue(now = Date.now()) {
  const start = Date.parse(state.cicloInicio);
  if (!Number.isFinite(start)) state.cicloInicio = ecuadorDateTime(new Date(now));
  if (now - Date.parse(state.cicloInicio) < CYCLE_MS) return false;

  const eligible = ['arriba', 'afuera', 'sala'].map(zoneById).filter(Boolean);
  if (eligible.length !== 3) return false;
  const original = eligible.map(zone => zone.person);
  if (original.some(person => !String(person || '').trim()) || new Set(original).size !== original.length) return false;
  let selected = null;
  for (let attempt = 0; attempt < 300 && !selected; attempt++) {
    const candidate = [...original];
    for (let i = candidate.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidate[i], candidate[j]] = [candidate[j], candidate[i]];
    }
    if (candidate.every((person, i) => person !== original[i])) selected = candidate;
  }
  if (!selected) selected = [original[1], original[2], original[0]];
  eligible.forEach((zone, index) => { zone.person = selected[index]; });
  for (const record of Object.values(state.perfilesBloqueados)) {
    const assigned = eligible.find(zone => zone.person === record.name);
    if (assigned) record.zoneId = assigned.id;
  }
  state.cicloInicio = ecuadorDateTime(new Date(now));
  for (const record of Object.values(state.perfilesBloqueados)) record.cicloInicio = state.cicloInicio;
  state.ultimoSorteo = {
    fecha: dateInZone(new Date(now)),
    roles: eligible.map(zone => ({ zona: zone.name, persona: zone.person }))
  };
  sendState();
  console.log('Sorteo automático de roles:', state.ultimoSorteo.roles.map(role => `${role.persona} → ${role.zona}`).join(', '));
  return true;
}
async function start() {
  await loadState();
  server = http.createServer(app);
  io = new Server(server);
  io.on('connection', socket => {
    socket.on('identify', payload => {
      const deviceId = String(payload?.deviceId || '').trim();
      const profile = profileForDevice(deviceId);
      if (!profile) return socket.emit('identity-error', { error: 'Este dispositivo no tiene un perfil vinculado.' });
      socket.data.deviceId = deviceId;
      socket.data.person = profile.name;
      socket.emit('profile', { name: profile.name, zoneId: profile.zoneId, deviceId });
      socket.emit('state', publicState());
    });
    socket.on('forget-profile', () => { delete socket.data.deviceId; delete socket.data.person; });
    socket.on('toggle-task', (payload, acknowledge) => {
      const zone = zoneById(payload?.zoneId);
      const task = zone?.tasks.find(item => item.id === payload?.taskId);
      const profile = profileForDevice(socket.data.deviceId);
      if (!task) return acknowledge?.({ error: 'Tarea no encontrada.' });
      if (!profile || !canMarkZone(socket.data.deviceId, zone)) return acknowledge?.({ error: 'Solo puedes marcar las actividades de tu propio rol.' });
      task.done = Boolean(payload.done);
      task.markedBy = task.done ? profile.name : null;
      task.markedAt = task.done ? timeInZone(new Date()) : null;
      sendState();
      acknowledge?.({ ok: true });
    });
    socket.on('nudge', payload => {
      const zone = zoneById(payload?.zoneId);
      const task = zone?.tasks.find(t => t.id === payload?.taskId);
      const sender = profileForDevice(socket.data.deviceId);
      if (!sender || !task || task.done || zone.permission) return;
      const recipients = zone.responsables || (zone.person ? [zone.person] : []);
      io.emit('nudge', { person: zone.person, persons: recipients, zone: zone.name, task: task.text, from: sender.name });
      for (const person of recipients) {
        void sendPushToProfile(person, { title: `🔔 Recordatorio · ${zone.name}`, body: `${sender.name} te recuerda que falta: ${task.text}`, url: '/' });
      }
    });
  });
  drawRolesIfDue();
  setInterval(() => { rollover(); drawRolesIfDue(); }, 15000).unref();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Tareas del Hogar escuchando por HTTP en 0.0.0.0:${PORT}`);
    if (redis) console.log(`Persistencia Redis habilitada (${REDIS_KEY}).`);
    else console.log('Persistencia local activa en data.json.');
  });
}
start().catch(err => { console.error('No se pudo iniciar el servidor:', err); process.exit(1); });
