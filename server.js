const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { Redis } = require('@upstash/redis');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT || 3000);
const TZ = 'America/Guayaquil';
const ADMIN_PASSWORD = 'leo123';
const REDIS_KEY = 'tareas_hogar_state';
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
    id, name, person, color, permission: false, permissionReason: '',
    ...(name === 'BAÑO' ? { responsables: ['Libro', 'Angel'] } : {}),
    tasks: tasks.map((text, i) => ({ id: `${id}-${i + 1}`, text, done: false, markedBy: null, markedAt: null }))
  }; });
  return { date: dateInZone(new Date()), zones, streaks: {}, history: [], notices: {}, cicloInicio: ecuadorDateTime(new Date()), perfilesBloqueados: {}, ultimoSorteo: null };
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
    const normalized = { ...defaults, ...saved };
    if (!Array.isArray(normalized.zones)) normalized.zones = defaults.zones;
    for (const defaultZone of defaults.zones) {
      if (!normalized.zones.some(zone => zone.id === defaultZone.id)) normalized.zones.push(defaultZone);
    }
    const bathroom = normalized.zones.find(zone => zone.id === 'bano');
    if (bathroom) {
      bathroom.responsables ||= ['Libro', 'Angel'];
      bathroom.person ||= 'Libro y Angel';
    }
    for (const zone of normalized.zones) zone.permissionReason ||= '';
    if (!normalized.cicloInicio) normalized.cicloInicio = ecuadorDateTime(new Date());
    if (!normalized.perfilesBloqueados || Array.isArray(normalized.perfilesBloqueados)) normalized.perfilesBloqueados = {};
    if (!Object.hasOwn(normalized, 'ultimoSorteo')) normalized.ultimoSorteo = null;
    if (!Array.isArray(normalized.history)) normalized.history = [];
    if (!normalized.streaks || typeof normalized.streaks !== 'object') normalized.streaks = {};
    if (!normalized.notices || typeof normalized.notices !== 'object') normalized.notices = {};
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
  const { perfilesBloqueados, ...visible } = state;
  return visible;
}
function sendState() {
  persist();
  if (!io) return;
  io.emit('state', publicState());
  for (const socket of io.sockets.sockets.values()) {
    const profile = state.perfilesBloqueados[socket.data.deviceId];
    if (profile) socket.emit('profile', { name: profile.name, zoneId: profile.zoneId, deviceId: profile.deviceId });
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

app.post('/api/profile/claim', (req, res) => {
  drawRolesIfDue();
  const deviceId = String(req.body?.deviceId || '').trim().slice(0, 100);
  const claimed = state.perfilesBloqueados[deviceId];
  if (!deviceId) return res.status(400).json({ error: 'No se identificó este dispositivo.' });
  if (claimed) return res.json({ profile: { name: claimed.name, zoneId: claimed.zoneId, deviceId }, state: publicState() });

  const name = String(req.body?.name || '').trim().slice(0, 40);
  const zone = zoneById(req.body?.zoneId);
  if (!name || !zone) return res.status(400).json({ error: 'Elige tu nombre y una zona para registrar este dispositivo.' });
  const otherDevice = Object.values(state.perfilesBloqueados).find(entry => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (otherDevice) return res.status(409).json({ error: 'Este nombre ya está vinculado a otro dispositivo. Para cambiar de celular, elimina su registro en data.json.' });
  if (zone.responsables && !zone.responsables.some(person => person.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return res.status(403).json({ error: `El rol ${zone.name} está reservado para ${zone.responsables.join(' y ')}.` });
  }
  const zoneLock = Object.values(state.perfilesBloqueados).find(entry => entry.zoneId === zone.id);
  if (zoneLock && !zone.responsables) return res.status(409).json({ error: 'Esta zona ya está vinculada a otro dispositivo.' });

  if (!zone.responsables) zone.person = name;
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
  if (zone.responsables && !zone.responsables.some(person => person.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return res.status(403).json({ error: `El rol ${zone.name} está reservado para ${zone.responsables.join(' y ')}.` });
  }
  const occupiedZone = Object.values(state.perfilesBloqueados).find(entry => entry.deviceId !== deviceId && entry.zoneId === zone.id);
  if (occupiedZone && !zone.responsables) return res.status(409).json({ error: 'Esa zona ya está vinculada a otro dispositivo.' });
  profile.name = name;
  profile.zoneId = zone.id;
  if (!zone.responsables) zone.person = name;
  if (!state.streaks[name]) state.streaks[name] = 0;
  sendState();
  res.json({ profile: { name, zoneId: zone.id, deviceId }, state: publicState() });
});
app.post('/api/permission', (req, res) => {
  const zone = zoneById(req.body?.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zona no encontrada.' });
  const enabled = Boolean(req.body.enabled);
  const reason = String(req.body?.reason || '').trim().slice(0, 180);
  if (enabled && !reason) return res.status(400).json({ error: 'Escribe un motivo antes de activar el permiso.' });
  zone.permission = enabled;
  zone.permissionReason = enabled ? reason : '';
  sendState(); res.json(publicState());
});
app.post('/api/notice/dismiss', (req, res) => {
  const person = String(req.body?.person || '').trim();
  if (person) delete state.notices[person];
  sendState(); res.json(publicState());
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
  const zone = zoneById(req.body?.zoneId);
  const text = String(req.body?.text || '').trim().slice(0, 120);
  if (!zone || !text) return res.status(400).json({ error: 'Zona y descripción son obligatorias.' });
  const task = { id: `${zone.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, done: false, markedBy: null, markedAt: null };
  zone.tasks.push(task); sendState(); res.json(task);
});
app.patch('/api/task/:zoneId/:taskId', (req, res) => {
  if (!requirePassword(req, res)) return;
  const zone = zoneById(req.params.zoneId);
  const task = zone?.tasks.find(t => t.id === req.params.taskId);
  const text = String(req.body?.text || '').trim().slice(0, 120);
  if (!task || !text) return res.status(400).json({ error: 'Tarea o descripción no válida.' });
  task.text = text; sendState(); res.json(publicState());
});

function rollover() {
  const today = dateInZone(new Date());
  if (state.date === today) return;
  const yesterday = state.date;
  for (const zone of state.zones) {
    const persons = zone.responsables || [zone.person];
    const personLabel = zone.person;
    if (zone.permission) {
      if (zone.permissionReason) state.history.unshift({ date: yesterday, person: personLabel, zone: zone.name, type: 'permiso', reason: zone.permissionReason, tasks: [] });
    } else {
      const unfinished = zone.tasks.filter(t => !t.done).map(t => t.text);
      const complete = unfinished.length === 0;
      for (const person of persons) state.streaks[person] = complete ? (state.streaks[person] || 0) + 1 : 0;
      if (unfinished.length) {
        state.history.unshift({ date: yesterday, person: personLabel, zone: zone.name, tasks: unfinished });
        for (const person of persons) state.notices[person] = { date: yesterday, tasks: unfinished, zone: zone.name };
      }
    }
    zone.permission = false;
    zone.permissionReason = '';
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
      if (!task || task.done || zone.permission) return;
      io.emit('nudge', { person: zone.person, persons: zone.responsables || [zone.person], zone: zone.name, task: task.text, from: String(payload.from || 'Alguien').slice(0, 40) });
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
