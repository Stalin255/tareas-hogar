const socket = io({ transports: ['websocket', 'polling'] });
const $ = selector => document.querySelector(selector);
const DAY_MS = 24 * 60 * 60 * 1000;
const EDIT_PASSWORD = 'leo123';
const ECUADOR_HOLIDAYS = [
  { date: '2026-12-25', name: 'Navidad' },
  { date: '2027-01-01', name: 'Año Nuevo' },
  { date: '2027-02-08', name: 'Carnaval' }, { date: '2027-02-09', name: 'Carnaval' },
  { date: '2027-03-26', name: 'Viernes Santo' },
  { date: '2027-04-30', name: 'Día del Trabajo · descanso trasladado' },
  { date: '2027-05-24', name: 'Batalla de Pichincha' },
  { date: '2027-08-09', name: 'Primer Grito de Independencia · descanso trasladado' },
  { date: '2027-10-08', name: 'Independencia de Guayaquil · descanso trasladado' },
  { date: '2027-11-01', name: 'Independencia de Cuenca · descanso trasladado' },
  { date: '2027-11-02', name: 'Día de los Difuntos' },
  { date: '2027-12-25', name: 'Navidad' }
];
const deviceId = localStorage.getItem('tareas-device-id') || (crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(36).slice(2)}`);
localStorage.setItem('tareas-device-id', deviceId);
const state = { data: null, profile: null, isGuest: false, editTask: null, deleteTask: null, adminPassword: '', selectedZone: null, roleZoneId: null, pendingAbsenceZone: null, notesZoneId: null, toastTimer: null, reminderKey: '' };
const icons = { arriba: '🧺', afuera: '🌿', cocina: '🍋', sala: '🛋️', bano: '🧼' };
const personColors = { made: '#06b6d4', maciel: '#a855f7', leo: '#22c55e', mati: '#3b82f6', libro: '#f97316', angel: '#fb923c', 'libro y angel': '#f97316' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(result.error || 'No se pudo guardar el cambio.'); error.status = response.status; throw error; }
  return result;
}
function request(method, body) { return { method, body: JSON.stringify(body) }; }
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
async function updatePushButton() {
  const button = $('#notify-btn');
  if (!button) return;
  button.classList.toggle('hidden', state.isGuest || !state.profile);
  if (state.isGuest || !state.profile) return;
  const label = $('#notify-label'), status = $('#notify-status');
  button.classList.remove('enabled', 'blocked');
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    label.textContent = 'No disponible'; status.textContent = 'No compatible'; button.disabled = true; button.title = 'Este navegador no admite notificaciones push.'; button.setAttribute('aria-label', 'Notificaciones no compatibles'); return;
  }
  button.disabled = false;
  if (Notification.permission === 'denied') {
    label.textContent = 'Avisos'; status.textContent = 'Bloqueadas'; button.classList.add('blocked');
    button.title = 'Notificaciones bloqueadas. Habilítalas en los ajustes del navegador.'; button.setAttribute('aria-label', 'Notificaciones bloqueadas'); return;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = registration && await registration.pushManager.getSubscription();
    if (subscription) {
      label.textContent = 'Avisos'; status.textContent = 'Activas'; button.classList.add('enabled'); button.title = 'Notificaciones push activas en este teléfono.';
    } else if (Notification.permission === 'granted') {
      label.textContent = 'Activar avisos'; status.textContent = 'Permiso concedido'; button.title = 'Toca para completar la activación de notificaciones push.';
    } else {
      label.textContent = 'Activar avisos'; status.textContent = 'Inactivas'; button.title = 'Activar notificaciones en este teléfono.';
    }
  } catch {
    label.textContent = 'Activar avisos'; status.textContent = 'Inactivas'; button.title = 'Activar notificaciones en este teléfono.';
  }
  button.setAttribute('aria-label', `${label.textContent}: ${status.textContent}`);
}
function say(message, duration = 3600) {
  const element = $('#toast'); element.textContent = message; element.classList.remove('toast-enter');
  void element.offsetWidth; element.classList.add('show', 'toast-enter');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => element.classList.remove('show', 'toast-enter'), duration);
}
function colorFor(person) { return personColors[String(person).toLowerCase()] || '#f97316'; }
function syncProfile(profile) {
  state.profile = { ...profile, deviceId };
  localStorage.setItem('tareas-profile', JSON.stringify(state.profile));
  socket.emit('identify', { deviceId });
}
function closeDialog(dialog) {
  if (!dialog?.open || dialog.classList.contains('closing')) return;
  dialog.classList.add('closing');
  const finish = event => {
    if (event.target !== dialog) return;
    dialog.close(); dialog.classList.remove('closing'); dialog.removeEventListener('animationend', finish);
  };
  dialog.addEventListener('animationend', finish);
  setTimeout(() => { if (dialog.open) { dialog.close(); dialog.classList.remove('closing'); dialog.removeEventListener('animationend', finish); } }, 260);
}
function render() {
  if (!state.data) return;
  const data = state.data, mine = state.isGuest ? null : state.profile;
  const myZone = mine && data.zones.find(zone => zone.id === mine.zoneId);
  $('#hello-name').textContent = state.isGuest ? 'invitado' : mine?.name || 'familia';
  $('#avatar').textContent = (mine?.name || '?').slice(0, 1).toUpperCase();
  $('#today-label').textContent = new Intl.DateTimeFormat('es-EC', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  $('#year').textContent = new Date().getFullYear();
  $('#my-streak').innerHTML = `🔥 <span>${myZone ? (data.streaks[mine.name] || 0) : 0} días</span>`;
  const cycleStart = Date.parse(data.cicloInicio || new Date().toISOString());
  $('#days-left').textContent = Math.max(0, Math.ceil((cycleStart + 45 * DAY_MS - Date.now()) / DAY_MS));
  $('#cycle-indicator').classList.toggle('hidden', !mine);
  $('#role-change-btn').classList.toggle('hidden', !mine);
  $('#unlink-btn').classList.toggle('hidden', !mine);
  $('#guest-btn').classList.toggle('hidden', state.isGuest);
  $('#guest-status').classList.toggle('hidden', !state.isGuest);
  $('#notify-btn').classList.toggle('hidden', state.isGuest || !mine);
  $('#add-task-btn').classList.toggle('hidden', state.isGuest);
  $('#devices-btn').classList.toggle('hidden', state.isGuest || !mine);
  $('#manage-tasks-btn').classList.toggle('hidden', state.isGuest || !mine);
  $('#add-reminder-btn').classList.toggle('hidden', state.isGuest || !mine);
  document.body.classList.toggle('guest-mode', state.isGuest);
  updatePushButton();

  const total = data.zones.reduce((sum, zone) => sum + zone.tasks.length, 0);
  const done = data.zones.reduce((sum, zone) => sum + zone.tasks.filter(task => task.done).length, 0);
  $('#done-total').textContent = done; $('#task-total').textContent = `de ${total} tareas completadas`;
  $('#summary-caption').textContent = total && done === total ? '¡El hogar está listo por hoy! 🎉' : 'Cada pequeño avance cuenta ✨';
  const percent = total ? Math.round(done / total * 100) : 0;
  $('#progress-percent').textContent = `${percent}%`; $('#progress-ring').style.setProperty('--progress', `${percent * 3.6}deg`);
  $('#zones').innerHTML = data.zones.map(renderZone).join('');
  document.querySelectorAll('.zone-card').forEach((card, index) => { card.style.animationDelay = `${index * 70}ms`; });
  renderHistory(); renderReminders(); renderHolidays(); renderNotice(); renderDrawAnnouncement(); renderZonePicker();
  if ($('#task-manager-dialog').open) renderTaskManager();
  if (state.notesZoneId && $('#notes-dialog').open) renderNotes(state.notesZoneId);
  $('#history-count').textContent = String(data.history.length);
}
function renderZone(zone) {
  const complete = zone.tasks.filter(task => task.done).length;
  const pending = zone.tasks.length - complete;
  const progress = zone.tasks.length ? Math.round(complete / zone.tasks.length * 100) : 0;
  const accent = colorFor(zone.person), isOwn = Boolean(!state.isGuest && state.profile && state.profile.zoneId === zone.id);
  const responsibleNames = Array.isArray(zone.responsables) ? zone.responsables : (zone.person ? [zone.person] : []);
  const personLabel = zone.person || 'Sin responsable';
  const streakLabel = responsibleNames.length ? responsibleNames.map(person => `${person} ${state.data.streaks[person] || 0}`).join(' · ') : 'Sin responsable';
  return `<article class="zone-card ${zone.permission ? 'permission' : ''}" style="--accent:${accent}">
    <div class="zone-head"><div class="zone-identity"><div class="zone-icon">${icons[zone.id] || '⌂'}</div><div class="zone-copy"><div class="zone-title">${escapeHtml(zone.name)}</div><div class="zone-person">${escapeHtml(personLabel)} <span class="person-streak">🔥 ${escapeHtml(streakLabel)}</span></div></div></div>
      ${isOwn ? `<div class="zone-tools"><span class="permission-label">Ausente</span><input class="permission-toggle" type="checkbox" aria-label="Permiso o ausente ${escapeHtml(zone.name)}" data-permission="${escapeHtml(zone.id)}" ${zone.permission ? 'checked' : ''}></div>` : ''}</div>
    <div class="zone-progress"><span>${zone.permission ? 'Con permiso hoy' : pending ? `Faltan ${pending} de ${zone.tasks.length}` : '¡Todo listo!'}</span><strong>${progress}%</strong></div>
    <div class="bar"><i style="width:${progress}%"></i></div>
    <button class="notes-button" type="button" data-notes-zone="${escapeHtml(zone.id)}">📝 Notas <span>${zone.notes?.length || 0}</span></button>
    ${zone.permission ? `<div class="permission-note">☀️ Con permiso hoy${zone.permissionReason ? ` · ${escapeHtml(zone.permissionReason)}` : ''}</div>` : ''}
    <ul class="task-list">${zone.tasks.map(task => `<li class="task-row ${task.done ? 'done' : ''}">
      <span class="task-check-wrap">${isOwn ? `<input type="checkbox" class="task-check" aria-label="Marcar ${escapeHtml(task.text)}" data-toggle-zone="${escapeHtml(zone.id)}" data-task="${escapeHtml(task.id)}" ${task.done ? 'checked' : ''}>` : `<input type="checkbox" class="task-check blocked-check" aria-label="${task.done ? 'Completada' : 'Pendiente'}: ${escapeHtml(task.text)}" ${task.done ? 'checked' : ''} disabled>${state.isGuest ? '' : '<button type="button" class="task-lock-hit" data-locked-check aria-label="Solo puedes marcar las actividades de tu propio rol"></button>'}`}</span>
      <div class="task-detail"><div class="task-text">${escapeHtml(task.text)}</div>${task.done ? `<div class="task-meta">✓ ${escapeHtml(task.markedBy || '')} · ${escapeHtml(task.markedAt || '')}</div>` : ''}</div>
      ${!state.isGuest && !task.done && !zone.permission ? `<button class="mini-button nudge-button" title="Dar un toque a ${escapeHtml(zone.person)}" aria-label="Dar un toque" data-nudge-zone="${escapeHtml(zone.id)}" data-task="${escapeHtml(task.id)}">🔔</button>` : ''}
    </li>`).join('')}</ul>
  </article>`;
}
function renderHistory() {
  const list = $('#history-list');
  if (!state.data.history.length) { list.innerHTML = '<div class="empty-history">✨ Aún no hay tareas pendientes en el historial.</div>'; return; }
  list.innerHTML = state.data.history.map(item => {
    const notes = (item.notes || []).map(note => {
      const time = note.createdAt ? new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(note.createdAt)) : '';
      return `<div class="history-note"><div><strong>${escapeHtml(note.author || 'Familia')}</strong><time>${escapeHtml(time)}</time></div><p>${escapeHtml(note.text || '').replace(/\n/g, '<br>')}</p></div>`;
    }).join('');
    return `<article class="history-item ${item.type === 'permiso' ? 'permission-history' : ''}"><div class="history-top"><div><span class="history-person">${escapeHtml(item.person)}</span><div class="history-zone">${escapeHtml(item.zone)}</div></div><time>${escapeHtml(item.date)}</time></div>${item.type === 'permiso' ? `<div class="history-permission">☀️ Ausente con permiso</div><p class="history-reason"><strong>Motivo:</strong> ${escapeHtml(item.reason || 'Sin motivo registrado')}</p>` : (item.tasks || []).length ? `<ul>${item.tasks.map(task => `<li>${escapeHtml(task)}</li>`).join('')}</ul>` : ''}${notes ? `<div class="history-notes"><strong>📝 Notas de ese día</strong>${notes}</div>` : ''}</article>`;
  }).join('');
}
function formatDate(date) {
  return new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
}
function daysUntil(date) { return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${state.data.date}T00:00:00Z`)) / DAY_MS); }
function renderReminders() {
  const list = $('#reminders-list');
  const reminders = [...(state.data.reminders || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!reminders.length) { list.innerHTML = '<div class="empty-agenda">Aún no hay fechas pendientes. Puedes añadir una para toda la familia.</div>'; return; }
  list.innerHTML = reminders.map(item => {
    const left = daysUntil(item.date);
    const timing = left < 0 ? `Venció hace ${Math.abs(left)} días` : left === 0 ? 'Es hoy' : left === 1 ? 'Mañana' : `Faltan ${left} días`;
    return `<article class="reminder-card ${left >= 0 && left <= 7 ? 'reminder-soon' : ''} ${left < 0 ? 'reminder-overdue' : ''}"><div class="reminder-pin">📌</div><div class="reminder-copy"><strong>${escapeHtml(item.title)}</strong><span>${formatDate(item.date)} · Añadió ${escapeHtml(item.createdBy || 'la familia')}</span></div><div class="reminder-countdown">${escapeHtml(timing)}</div></article>`;
  }).join('');
}
function renderHolidays() {
  const list = $('#holidays-list'), upcoming = ECUADOR_HOLIDAYS.filter(item => item.date >= state.data.date);
  if (!upcoming.length) { list.innerHTML = '<div class="empty-agenda">No hay más fechas cargadas.</div>'; return; }
  list.innerHTML = upcoming.map((item, index) => `<article class="holiday-row"><span class="holiday-date">${formatDate(item.date)}</span><strong>${escapeHtml(item.name)}</strong><span class="holiday-count">${daysUntil(item.date) === 0 ? 'Hoy' : `en ${daysUntil(item.date)} días`}</span></article>`).join('');
}
function renderTaskManager() {
  const zoneId = $('#manage-task-zone').value || state.data.zones[0]?.id;
  const zone = state.data.zones.find(item => item.id === zoneId);
  if (!zone) return;
  $('#managed-task-list').innerHTML = zone.tasks.length ? zone.tasks.map(task => `<article class="managed-task-row"><span>${escapeHtml(task.text)}</span><div><button class="mini-button" type="button" title="Editar" data-manager-edit-zone="${escapeHtml(zone.id)}" data-task="${escapeHtml(task.id)}">✏️</button><button class="mini-button remove-task-button" type="button" title="Eliminar" data-manager-delete-zone="${escapeHtml(zone.id)}" data-task="${escapeHtml(task.id)}">🗑️</button></div></article>`).join('') : '<div class="empty-agenda">Esta zona todavía no tiene tareas.</div>';
}
function renderDeviceList() {
  const list = $('#device-list'), profiles = state.deviceProfiles || [];
  if (!profiles.length) { list.innerHTML = '<div class="empty-agenda">No hay dispositivos vinculados.</div>'; return; }
  list.innerHTML = `<div class="device-list-heading">${profiles.length} dispositivo${profiles.length === 1 ? '' : 's'} vinculados</div>${profiles.map(profile => {
    const zone = state.data.zones.find(item => item.id === profile.zoneId);
    return `<article class="device-row"><div><strong>${escapeHtml(profile.name)}</strong><span>${escapeHtml(zone?.name || 'Rol no encontrado')}</span></div><button class="secondary-button device-remove" type="button" data-remove-device="${escapeHtml(profile.deviceId)}">Quitar</button></article>`;
  }).join('')}<button id="unlink-all-devices" class="secondary-button unlink-all-button" type="button">Desvincular todos</button>`;
}
async function loadDeviceList() {
  const result = await api('/api/profile/list', request('POST', { password: state.adminPassword }));
  state.deviceProfiles = result.profiles;
  renderDeviceList();
}
function renderNotice() {
  const banner = $('#yesterday-banner'), notice = !state.isGuest && state.profile && state.data.notices[state.profile.name];
  if (!notice) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  banner.innerHTML = `<div><strong>⚠️ Ayer no hiciste (${escapeHtml(notice.zone)}):</strong> ${notice.tasks.map(escapeHtml).join(' · ')}</div><button id="dismiss-notice" class="mini-button" aria-label="Cerrar aviso">×</button>`;
  $('#dismiss-notice').onclick = async () => { await api('/api/notice/dismiss', request('POST', { deviceId, person: state.profile.name })).catch(() => {}); };
}
function renderNotes(zoneId) {
  const zone = state.data?.zones.find(item => item.id === zoneId);
  if (!zone) return;
  $('#notes-title').textContent = `Notas · ${zone.name}`;
  $('#notes-about').textContent = `Sobre: ${zone.person || 'Sin responsable'}`;
  $('#note-composer').classList.toggle('hidden', state.isGuest);
  const notes = zone.notes || [];
  $('#notes-list').innerHTML = notes.length ? notes.map(note => {
    const time = new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(note.createdAt));
    return `<article class="note-item"><div class="note-meta"><strong>${escapeHtml(note.author)}</strong><time>${escapeHtml(time)}</time></div><div class="note-about">Sobre ${escapeHtml(note.about || zone.person || 'Sin responsable')}</div><p>${escapeHtml(note.text).replace(/\n/g, '<br>')}</p></article>`;
  }).join('') : '<div class="empty-notes">Aún no hay notas en este rol.</div>';
}
function renderDrawAnnouncement() {
  const banner = $('#draw-banner'), draw = state.data.ultimoSorteo;
  if (!draw) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  banner.innerHTML = `<span class="draw-sparkle">✦</span><div><strong>¡Nuevos roles sorteados!</strong><p>${draw.roles.map(role => `<span>${escapeHtml(role.persona)} <b>·</b> ${escapeHtml(role.zona)}</span>`).join('')}</p></div><time>${escapeHtml(draw.fecha)}</time>`;
}
function renderZonePicker() {
  if (!state.data) return;
  $('#zone-picker').innerHTML = state.data.zones.map(zone => `<button type="button" class="zone-option ${state.selectedZone === zone.id ? 'selected' : ''}" data-pick-zone="${escapeHtml(zone.id)}"><span>${icons[zone.id] || '⌂'}</span>${escapeHtml(zone.name)}</button>`).join('');
  $('#role-zone-picker').innerHTML = state.data.zones.map(zone => `<button type="button" class="zone-option ${state.roleZoneId === zone.id ? 'selected' : ''}" data-pick-role-zone="${escapeHtml(zone.id)}"><span>${icons[zone.id] || '⌂'}</span>${escapeHtml(zone.name)}</button>`).join('');
  $('#task-zone').innerHTML = state.data.zones.map(zone => `<option value="${escapeHtml(zone.id)}">${escapeHtml(zone.name)}</option>`).join('');
}

socket.on('connect', () => {
  $('#sync-status').textContent = '● En vivo'; $('#sync-status').classList.add('connected');
  if (state.profile && !state.isGuest) socket.emit('identify', { deviceId });
});
socket.on('disconnect', () => { $('#sync-status').textContent = '● Reconectando'; $('#sync-status').classList.remove('connected'); });
socket.on('state', data => { state.data = data; render(); });
socket.on('profile', profile => {
  if (!state.isGuest && profile.deviceId === deviceId) { state.profile = { name: profile.name, zoneId: profile.zoneId, deviceId }; localStorage.setItem('tareas-profile', JSON.stringify(state.profile)); render(); }
});
socket.on('profile-unlinked', () => {
  if (state.isGuest) return;
  state.profile = null; localStorage.removeItem('tareas-profile'); socket.emit('forget-profile'); render();
  state.selectedZone = state.data?.zones[0]?.id || null;
  if (!$('#profile-dialog').open) { renderZonePicker(); $('#profile-dialog').showModal(); }
});
socket.on('identity-error', payload => say(payload.error));
socket.on('nudge', payload => {
  const recipients = payload.persons || [payload.person];
  if (state.isGuest || !state.profile || !recipients.some(person => person.toLowerCase() === state.profile.name.toLowerCase())) return;
  const message = `🔔 ${payload.from} te recuerda que falta: ${payload.task}`;
  say(message); if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.frequency.value = 660; gain.gain.value = .045;
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .18);
  } catch {}
  if ('Notification' in window && Notification.permission === 'granted') {
    navigator.serviceWorker?.getRegistration().then(async registration => {
      if (registration && await registration.pushManager.getSubscription()) return;
      new Notification('Tareas del Hogar', { body: message, icon: '/icon.svg', tag: `nudge-${Date.now()}` });
    }).catch(() => {});
  }
});

document.addEventListener('change', async event => {
  if (event.target.id === 'manage-task-zone') { renderTaskManager(); return; }
  const toggle = event.target.closest('[data-toggle-zone]');
  if (!toggle) return;
  if (state.isGuest) { render(); return; }
  const payload = { zoneId: toggle.dataset.toggleZone, taskId: toggle.dataset.task, done: toggle.checked };
  socket.timeout(5000).emit('toggle-task', payload, (timeoutError, result) => {
    if (timeoutError || result?.error) { toggle.checked = !payload.done; say(result?.error || 'Se perdió la conexión. Intenta otra vez.'); }
  });
});
document.addEventListener('click', async event => {
  if (event.target.closest('#guest-btn, #profile-guest-btn')) {
    state.isGuest = true;
    socket.emit('forget-profile');
    closeDialog($('#profile-dialog'));
    render();
    say('Modo invitado: solo puedes mirar.');
    return;
  }
  if (event.target.closest('#devices-btn')) {
    if (state.isGuest) return;
    state.deviceProfiles = []; state.adminPassword = '';
    $('#devices-password').value = ''; $('#devices-error').classList.add('hidden'); $('#device-list').innerHTML = '';
    $('#devices-dialog').showModal();
  }
  if (event.target.closest('#manage-tasks-btn')) {
    if (state.isGuest || !state.profile) return;
    $('#manage-task-zone').innerHTML = state.data.zones.map(zone => `<option value="${escapeHtml(zone.id)}">${escapeHtml(zone.name)}</option>`).join('');
    renderTaskManager(); $('#task-manager-dialog').showModal();
  }
  if (event.target.closest('#manager-add-task')) {
    if (state.isGuest || !state.profile) return;
    const zoneId = $('#manage-task-zone').value;
    closeDialog($('#task-manager-dialog'));
    setTimeout(() => { state.editTask = null; $('#task-dialog-title').textContent = 'Añadir una tarea'; $('#task-form').reset(); $('#task-zone').disabled = false; $('#task-zone').value = zoneId; $('#task-password').required = false; $('#task-password-field').classList.add('hidden'); $('#task-error').classList.add('hidden'); renderZonePicker(); $('#task-zone').value = zoneId; $('#task-dialog').showModal(); }, 280);
  }
  const managerEdit = event.target.closest('[data-manager-edit-zone]');
  if (managerEdit) {
    if (state.isGuest) return;
    state.editTask = { zoneId: managerEdit.dataset.managerEditZone, taskId: managerEdit.dataset.task };
    const task = state.data.zones.find(zone => zone.id === state.editTask.zoneId)?.tasks.find(item => item.id === state.editTask.taskId);
    if (!task) return;
    closeDialog($('#task-manager-dialog'));
    setTimeout(() => { $('#task-dialog-title').textContent = 'Editar tarea'; $('#task-zone').value = state.editTask.zoneId; $('#task-zone').disabled = true; $('#task-text').value = task.text; $('#task-password').value = ''; $('#task-password').required = true; $('#task-password-field').classList.remove('hidden'); $('#task-error').classList.add('hidden'); $('#task-dialog').showModal(); }, 280);
  }
  const managerDelete = event.target.closest('[data-manager-delete-zone]');
  if (managerDelete) {
    if (state.isGuest) return;
    state.deleteTask = { zoneId: managerDelete.dataset.managerDeleteZone, taskId: managerDelete.dataset.task };
    const task = state.data.zones.find(zone => zone.id === state.deleteTask.zoneId)?.tasks.find(item => item.id === state.deleteTask.taskId);
    $('#delete-task-label').textContent = task ? task.text : '';
    $('#task-delete-password').value = ''; $('#task-delete-error').classList.add('hidden'); $('#task-delete-dialog').showModal();
  }
  const removeDevice = event.target.closest('[data-remove-device]');
  if (removeDevice) {
    if (state.isGuest || !state.adminPassword) return;
    try {
      const result = await api('/api/profile/unlink', request('POST', { deviceId: removeDevice.dataset.removeDevice, password: state.adminPassword }));
      state.data = result.state; render();
      if (removeDevice.dataset.removeDevice === deviceId) {
        state.profile = null; localStorage.removeItem('tareas-profile'); socket.emit('forget-profile'); render();
        closeDialog($('#devices-dialog')); state.selectedZone = state.data.zones[0]?.id || null;
        setTimeout(() => { renderZonePicker(); if (!$('#profile-dialog').open) $('#profile-dialog').showModal(); }, 280);
      } else await loadDeviceList();
    } catch (error) { say(error.message); }
  }
  if (event.target.closest('#unlink-all-devices')) {
    if (state.isGuest || !state.adminPassword) return;
    if (!window.confirm('¿Desvincular todos los dispositivos y dejar libres sus roles?')) return;
    const hadProfile = Boolean(state.profile);
    try {
      const result = await api('/api/profile/unlink-all', request('POST', { password: state.adminPassword }));
      state.data = result.state; state.deviceProfiles = []; renderDeviceList(); render();
      closeDialog($('#devices-dialog'));
      if (hadProfile) {
        state.profile = null; localStorage.removeItem('tareas-profile'); socket.emit('forget-profile'); render();
        state.selectedZone = state.data.zones[0]?.id || null;
        setTimeout(() => { renderZonePicker(); if (!$('#profile-dialog').open) $('#profile-dialog').showModal(); }, 280);
      } else say('Todos los dispositivos quedaron desvinculados.');
    } catch (error) { say(error.message); }
  }
  if (event.target.closest('#add-reminder-btn')) {
    if (state.isGuest || !state.profile) return say('Vincula un perfil para añadir fechas.');
    $('#reminder-form').reset(); $('#reminder-date').min = state.data.date; $('#reminder-date').value = state.data.date;
    $('#reminder-error').classList.add('hidden'); $('#reminder-dialog').showModal();
  }
  const quickName = event.target.closest('[data-name]');
  if (quickName) $('#person-input').value = quickName.dataset.name;
  const zoneChoice = event.target.closest('[data-pick-zone]');
  if (zoneChoice) { state.selectedZone = zoneChoice.dataset.pickZone; renderZonePicker(); }
  const roleZoneChoice = event.target.closest('[data-pick-role-zone]');
  if (roleZoneChoice) { state.roleZoneId = roleZoneChoice.dataset.pickRoleZone; renderZonePicker(); }

  const lockedCheck = event.target.closest('[data-locked-check]');
  if (lockedCheck) say('Solo puedes marcar las actividades de tu propio rol', 1600);
  const permission = event.target.closest('[data-permission]');
  if (permission) {
    if (state.isGuest) { render(); return; }
    const zoneId = permission.dataset.permission;
    if (permission.checked) {
      permission.checked = false;
      state.pendingAbsenceZone = zoneId;
      const zone = state.data.zones.find(item => item.id === zoneId);
      $('#permission-zone-label').textContent = `${zone.name} · responsable ${zone.person}`;
      $('#permission-reason').value = ''; $('#permission-error').classList.add('hidden');
      $('#permission-dialog').showModal();
    } else {
      try { await api('/api/permission', request('POST', { zoneId, enabled: false, deviceId })); }
      catch (error) { say(error.message); render(); }
    }
  }
  const nudge = event.target.closest('[data-nudge-zone]');
  if (nudge) {
    if (state.isGuest || !state.profile) return say('Solo los perfiles vinculados pueden dar un toque.');
    nudge.classList.remove('ringing'); void nudge.offsetWidth; nudge.classList.add('ringing');
    socket.emit('nudge', { zoneId: nudge.dataset.nudgeZone, taskId: nudge.dataset.task, from: state.profile?.name || 'Alguien' });
    say(`Toque enviado a ${state.data.zones.find(zone => zone.id === nudge.dataset.nudgeZone)?.person}.`);
  }
  if (event.target.closest('#add-task-btn')) {
    if (state.isGuest) return;
    state.editTask = null; $('#task-dialog-title').textContent = 'Añadir una tarea'; $('#task-form').reset(); $('#task-zone').disabled = false; $('#task-password').required = false; $('#task-password-field').classList.add('hidden'); $('#task-error').classList.add('hidden'); renderZonePicker(); $('#task-dialog').showModal();
  }
  if (event.target.closest('#role-change-btn')) {
    if (state.isGuest) return;
    $('#role-password').value = ''; $('#role-password-error').classList.add('hidden'); $('#role-password-dialog').showModal();
  }
  if (event.target.closest('#unlink-btn')) {
    if (state.isGuest) return;
    $('#unlink-password').value = ''; $('#unlink-error').classList.add('hidden'); $('#unlink-dialog').showModal();
  }
  const notes = event.target.closest('[data-notes-zone]');
  if (notes) {
    state.notesZoneId = notes.dataset.notesZone; $('#note-form').reset(); $('#note-error').classList.add('hidden');
    renderNotes(state.notesZoneId); $('#notes-dialog').showModal();
  }
  const closeButton = event.target.closest('[data-close-dialog]');
  if (closeButton) closeDialog(document.getElementById(closeButton.dataset.closeDialog));
});

$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('#person-input').value.trim();
  if (!name || !state.selectedZone) return;
  try {
    const result = await api('/api/profile/claim', request('POST', { deviceId, name, zoneId: state.selectedZone }));
    state.data = result.state; syncProfile(result.profile); closeDialog($('#profile-dialog')); render();
  } catch (error) { $('#profile-error').textContent = error.message; $('#profile-error').classList.remove('hidden'); }
});
$('#role-password-form').addEventListener('submit', event => {
  event.preventDefault();
  if ($('#role-password').value !== EDIT_PASSWORD) {
    $('#role-password-error').textContent = 'Contraseña incorrecta.'; $('#role-password-error').classList.remove('hidden'); return;
  }
  state.roleZoneId = state.profile?.zoneId || state.data.zones[0]?.id || null;
  $('#role-name').value = state.profile?.name || '';
  $('#role-error').classList.add('hidden'); renderZonePicker();
  closeDialog($('#role-password-dialog')); setTimeout(() => $('#role-dialog').showModal(), 280);
});
$('#role-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('#role-password').value !== EDIT_PASSWORD) { $('#role-error').textContent = 'Contraseña incorrecta.'; $('#role-error').classList.remove('hidden'); return; }
  try {
    const result = await api('/api/profile/change', request('POST', { deviceId, name: $('#role-name').value.trim(), zoneId: state.roleZoneId, password: $('#role-password').value }));
    state.data = result.state; syncProfile(result.profile); closeDialog($('#role-dialog')); $('#role-password').value = ''; render();
  } catch (error) { $('#role-error').textContent = error.message; $('#role-error').classList.remove('hidden'); }
});
$('#unlink-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('#unlink-password').value !== EDIT_PASSWORD) { $('#unlink-error').textContent = 'Contraseña incorrecta.'; $('#unlink-error').classList.remove('hidden'); return; }
  const previousZoneId = state.profile?.zoneId;
  try {
    const result = await api('/api/profile/unlink', request('POST', { deviceId, password: $('#unlink-password').value }));
    state.data = result.state; state.profile = null;
    localStorage.removeItem('tareas-profile'); socket.emit('forget-profile');
    state.selectedZone = previousZoneId || state.data.zones[0]?.id || null;
    $('#unlink-password').value = ''; closeDialog($('#unlink-dialog')); render();
    setTimeout(() => { renderZonePicker(); $('#profile-error').classList.add('hidden'); $('#profile-dialog').showModal(); }, 280);
  } catch (error) { say(error.message); }
});
$('#devices-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('#devices-password').value;
  if (password !== EDIT_PASSWORD) { $('#devices-error').textContent = 'Contraseña incorrecta.'; $('#devices-error').classList.remove('hidden'); return; }
  state.adminPassword = password;
  try { await loadDeviceList(); $('#devices-error').classList.add('hidden'); }
  catch (error) { $('#devices-error').textContent = error.message; $('#devices-error').classList.remove('hidden'); }
});
$('#task-delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('#task-delete-password').value !== EDIT_PASSWORD) { $('#task-delete-error').textContent = 'Contraseña incorrecta.'; $('#task-delete-error').classList.remove('hidden'); return; }
  if (!state.deleteTask || !state.profile || state.isGuest) return;
  try {
    const result = await api(`/api/task/${encodeURIComponent(state.deleteTask.zoneId)}/${encodeURIComponent(state.deleteTask.taskId)}`, request('DELETE', { deviceId, password: $('#task-delete-password').value }));
    state.data = result; $('#task-delete-password').value = ''; closeDialog($('#task-delete-dialog')); render(); say('Tarea eliminada.');
  } catch (error) { $('#task-delete-error').textContent = error.message; $('#task-delete-error').classList.remove('hidden'); }
});
$('#reminder-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.profile || state.isGuest) return say('Vincula un perfil para añadir fechas.');
  const title = $('#reminder-title').value.trim(), date = $('#reminder-date').value;
  try {
    const result = await api('/api/reminders', request('POST', { title, date, deviceId }));
    state.data = result.state; closeDialog($('#reminder-dialog')); render(); say('Recordatorio añadido para toda la familia.');
  } catch (error) { $('#reminder-error').textContent = error.message; $('#reminder-error').classList.remove('hidden'); }
});
$('#task-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.isGuest || !state.profile) return say('Vincula un perfil para modificar tareas.');
  if (state.editTask && $('#task-password').value !== EDIT_PASSWORD) { $('#task-error').textContent = 'Contraseña incorrecta.'; $('#task-error').classList.remove('hidden'); return; }
  const zoneId = $('#task-zone').value, text = $('#task-text').value.trim();
  try {
    if (state.editTask) state.data = await api(`/api/task/${encodeURIComponent(state.editTask.zoneId)}/${encodeURIComponent(state.editTask.taskId)}`, request('PATCH', { text, password: $('#task-password').value, deviceId }));
    else { await api('/api/task', request('POST', { zoneId, text, deviceId })); state.data = await api('/api/state'); }
    state.editTask = null; $('#task-password').value = ''; closeDialog($('#task-dialog')); render();
  } catch (error) { $('#task-error').textContent = error.message; $('#task-error').classList.remove('hidden'); }
});
$('#permission-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.isGuest || !state.profile) return say('Vincula un perfil para activar un permiso.');
  const reason = $('#permission-reason').value.trim();
  if (!reason) { $('#permission-error').textContent = 'Escribe un motivo antes de confirmar.'; $('#permission-error').classList.remove('hidden'); return; }
  try {
    await api('/api/permission', request('POST', { zoneId: state.pendingAbsenceZone, enabled: true, reason, deviceId }));
    state.pendingAbsenceZone = null; closeDialog($('#permission-dialog'));
  } catch (error) { $('#permission-error').textContent = error.message; $('#permission-error').classList.remove('hidden'); }
});
$('#note-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.isGuest || !state.profile) return;
  const text = $('#note-text').value.trim();
  try {
    const result = await api(`/api/zone/${encodeURIComponent(state.notesZoneId)}/notes`, request('POST', { deviceId, text }));
    state.data = result.state; $('#note-text').value = ''; $('#note-error').classList.add('hidden'); render(); say('Nota guardada.');
  } catch (error) { $('#note-error').textContent = error.message; $('#note-error').classList.remove('hidden'); }
});
$('#task-close').addEventListener('click', () => closeDialog($('#task-dialog')));
$('#task-cancel').addEventListener('click', () => closeDialog($('#task-dialog')));
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => { if (event.target === dialog && dialog.id !== 'profile-dialog') closeDialog(dialog); });
  dialog.addEventListener('cancel', event => { if (dialog.id === 'profile-dialog') event.preventDefault(); else { event.preventDefault(); closeDialog(dialog); } });
}
$('#permission-dialog').addEventListener('close', () => { state.pendingAbsenceZone = null; });
$('#notes-dialog').addEventListener('close', () => { state.notesZoneId = null; });
$('#devices-dialog').addEventListener('close', () => { state.adminPassword = ''; state.deviceProfiles = []; $('#devices-password').value = ''; $('#device-list').innerHTML = ''; });
$('#notify-btn').addEventListener('click', async () => {
  if (state.isGuest || !state.profile) return;
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return say('Este navegador no admite notificaciones push.');
  if (Notification.permission === 'denied') { updatePushButton(); return say('Las notificaciones están bloqueadas. Habilítalas en los ajustes del navegador.'); }
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') { updatePushButton(); return say('No se concedió el permiso para notificaciones.'); }
    const registration = await navigator.serviceWorker.register('/sw.js');
    const { publicKey } = await api('/api/vapid-public-key');
    if (!publicKey) throw new Error('El servidor todavía no tiene configuradas las llaves VAPID.');
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    await api('/api/push/subscribe', request('POST', { subscription: subscription.toJSON(), profileId: state.profile.name.toLocaleLowerCase(), deviceId }));
    await updatePushButton(); say('Notificaciones push activas en este teléfono.');
  } catch (error) {
    await updatePushButton(); say(error.message || 'No se pudo activar las notificaciones push.');
  }
});
document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(nav => nav.classList.toggle('active', nav === item));
  const isToday = item.dataset.tab === 'today';
  const next = isToday ? $('#today-view') : $('#history-view');
  $('#today-view').classList.toggle('hidden', !isToday); $('#history-view').classList.toggle('hidden', isToday);
  next.classList.remove('view-enter'); void next.offsetWidth; next.classList.add('view-enter');
}));
async function runReminderCheck() {
  if (state.isGuest || !state.profile || !('Notification' in window) || Notification.permission !== 'granted' || !state.data) return;
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration && await registration.pushManager.getSubscription()) return;
  const zone = state.data.zones.find(item => item.id === state.profile.zoneId);
  if (!zone || zone.permission || !zone.tasks.some(task => !task.done)) return;
  const now = new Date(), hour = now.getHours(), minute = now.getMinutes();
  const slot = hour === 15 && minute === 0 ? '15' : hour === 20 && minute === 30 ? '20:30' : null;
  const key = `${state.data.date}-${slot}`;
  if (slot && state.reminderKey !== key) {
    state.reminderKey = key;
    new Notification('Tareas del Hogar', { body: `Te faltan ${zone.tasks.filter(task => !task.done).length} tareas en ${zone.name}. ¡Ánimo!`, icon: '/icon.svg', tag: key });
  }
}
setInterval(runReminderCheck, 20000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(error => console.warn('Service worker:', error));

async function initialize() {
  try {
    state.data = await api('/api/state'); render();
    let result;
    try { result = await api('/api/profile/claim', request('POST', { deviceId })); }
    catch (error) {
      if (error.status === 400 || error.status === 409) { localStorage.removeItem('tareas-profile'); state.selectedZone = state.data.zones[0]?.id || null; renderZonePicker(); $('#profile-dialog').showModal(); }
      else say(error.message);
      return;
    }
    state.data = result.state; syncProfile(result.profile); render();
  } catch (error) {
    if (!state.profile && state.data) {
      state.selectedZone ||= state.data.zones[0]?.id || null;
      renderZonePicker(); $('#profile-error').textContent = error.message; $('#profile-error').classList.remove('hidden'); $('#profile-dialog').showModal();
    } else say('No se pudo conectar con el servidor: ' + error.message);
  }
}
initialize();
