const socket = io({ transports: ['websocket', 'polling'] });
const $ = selector => document.querySelector(selector);
const DAY_MS = 24 * 60 * 60 * 1000;
const EDIT_PASSWORD = 'leo123';
const storedProfile = (() => { try { return JSON.parse(localStorage.getItem('tareas-profile') || 'null'); } catch { return null; } })();
const deviceId = localStorage.getItem('tareas-device-id') || (crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(36).slice(2)}`);
localStorage.setItem('tareas-device-id', deviceId);
const state = { data: null, profile: null, isGuest: false, editTask: null, selectedZone: null, roleZoneId: null, pendingAbsenceZone: null, notesZoneId: null, toastTimer: null, reminderKey: '' };
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
  $('#notify-btn').classList.toggle('hidden', state.isGuest);
  $('#add-task-btn').classList.toggle('hidden', state.isGuest);
  document.body.classList.toggle('guest-mode', state.isGuest);

  const total = data.zones.reduce((sum, zone) => sum + zone.tasks.length, 0);
  const done = data.zones.reduce((sum, zone) => sum + zone.tasks.filter(task => task.done).length, 0);
  $('#done-total').textContent = done; $('#task-total').textContent = `de ${total} tareas completadas`;
  $('#summary-caption').textContent = total && done === total ? '¡El hogar está listo por hoy! 🎉' : 'Cada pequeño avance cuenta ✨';
  const percent = total ? Math.round(done / total * 100) : 0;
  $('#progress-percent').textContent = `${percent}%`; $('#progress-ring').style.setProperty('--progress', `${percent * 3.6}deg`);
  $('#zones').innerHTML = data.zones.map(renderZone).join('');
  document.querySelectorAll('.zone-card').forEach((card, index) => { card.style.animationDelay = `${index * 70}ms`; });
  renderHistory(); renderNotice(); renderDrawAnnouncement(); renderZonePicker();
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
      ${state.isGuest ? '' : `<div class="zone-tools"><span class="permission-label">Ausente</span><input class="permission-toggle" type="checkbox" aria-label="Permiso o ausente ${escapeHtml(zone.name)}" data-permission="${escapeHtml(zone.id)}" ${zone.permission ? 'checked' : ''}></div>`}</div>
    <div class="zone-progress"><span>${zone.permission ? 'Con permiso hoy' : pending ? `Faltan ${pending} de ${zone.tasks.length}` : '¡Todo listo!'}</span><strong>${progress}%</strong></div>
    <div class="bar"><i style="width:${progress}%"></i></div>
    <button class="notes-button" type="button" data-notes-zone="${escapeHtml(zone.id)}">📝 Notas <span>${zone.notes?.length || 0}</span></button>
    ${zone.permission ? `<div class="permission-note">☀️ Con permiso hoy${zone.permissionReason ? ` · ${escapeHtml(zone.permissionReason)}` : ''}</div>` : ''}
    <ul class="task-list">${zone.tasks.map(task => `<li class="task-row ${task.done ? 'done' : ''}">
      <span class="task-check-wrap">${isOwn ? `<input type="checkbox" class="task-check" aria-label="Marcar ${escapeHtml(task.text)}" data-toggle-zone="${escapeHtml(zone.id)}" data-task="${escapeHtml(task.id)}" ${task.done ? 'checked' : ''}>` : `<input type="checkbox" class="task-check blocked-check" aria-label="${task.done ? 'Completada' : 'Pendiente'}: ${escapeHtml(task.text)}" ${task.done ? 'checked' : ''} disabled>${state.isGuest ? '' : '<button type="button" class="task-lock-hit" data-locked-check aria-label="Solo puedes marcar las actividades de tu propio rol"></button>'}`}</span>
      <div class="task-detail"><div class="task-text">${escapeHtml(task.text)}</div>${task.done ? `<div class="task-meta">✓ ${escapeHtml(task.markedBy || '')} · ${escapeHtml(task.markedAt || '')}</div>` : ''}</div>
      ${!state.isGuest && !task.done && !zone.permission ? `<button class="mini-button nudge-button" title="Dar un toque a ${escapeHtml(zone.person)}" aria-label="Dar un toque" data-nudge-zone="${escapeHtml(zone.id)}" data-task="${escapeHtml(task.id)}">🔔</button>` : ''}
      ${state.isGuest ? '' : `<div class="task-actions"><button class="mini-button edit-button" title="Editar tarea" aria-label="Editar tarea" data-edit-task-zone="${escapeHtml(zone.id)}" data-task="${escapeHtml(task.id)}">✏️</button></div>`}
    </li>`).join('')}</ul>
  </article>`;
}
function renderHistory() {
  const list = $('#history-list');
  if (!state.data.history.length) { list.innerHTML = '<div class="empty-history">✨ Aún no hay tareas pendientes en el historial.</div>'; return; }
  list.innerHTML = state.data.history.map(item => `<article class="history-item ${item.type === 'permiso' ? 'permission-history' : ''}"><div class="history-top"><div><span class="history-person">${escapeHtml(item.person)}</span><div class="history-zone">${escapeHtml(item.zone)}</div></div><time>${escapeHtml(item.date)}</time></div>${item.type === 'permiso' ? `<div class="history-permission">☀️ Ausente con permiso</div><p class="history-reason"><strong>Motivo:</strong> ${escapeHtml(item.reason || 'Sin motivo registrado')}</p>` : `<ul>${(item.tasks || []).map(task => `<li>${escapeHtml(task)}</li>`).join('')}</ul>`}</article>`).join('');
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
  if (Notification.permission === 'granted') new Notification('Tareas del Hogar', { body: message, icon: '/icon.svg', tag: `nudge-${Date.now()}` });
});

document.addEventListener('change', async event => {
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
  const edit = event.target.closest('[data-edit-task-zone]');
  if (edit) {
    if (state.isGuest) return;
    state.editTask = { zoneId: edit.dataset.editTaskZone, taskId: edit.dataset.task };
    const task = state.data.zones.find(zone => zone.id === state.editTask.zoneId).tasks.find(item => item.id === state.editTask.taskId);
    $('#task-dialog-title').textContent = 'Editar tarea'; $('#task-zone').value = state.editTask.zoneId; $('#task-zone').disabled = true; $('#task-text').value = task.text; $('#task-password').value = ''; $('#task-password').required = true; $('#task-password-field').classList.remove('hidden'); $('#task-error').classList.add('hidden'); $('#task-dialog').showModal();
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
$('#task-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.isGuest || !state.profile) return say('Vincula un perfil para modificar tareas.');
  if (state.editTask && $('#task-password').value !== EDIT_PASSWORD) { $('#task-error').textContent = 'Contraseña incorrecta.'; $('#task-error').classList.remove('hidden'); return; }
  const zoneId = $('#task-zone').value, text = $('#task-text').value.trim();
  try {
    if (state.editTask) await api(`/api/task/${encodeURIComponent(state.editTask.zoneId)}/${encodeURIComponent(state.editTask.taskId)}`, request('PATCH', { text, password: $('#task-password').value, deviceId }));
    else await api('/api/task', request('POST', { zoneId, text, deviceId }));
    $('#task-password').value = ''; closeDialog($('#task-dialog'));
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
$('#notify-btn').addEventListener('click', async () => {
  if (state.isGuest) return;
  if (!('Notification' in window)) return say('Este navegador no admite notificaciones.');
  const permission = await Notification.requestPermission();
  if (permission === 'granted') { $('#notify-btn').classList.add('enabled'); say('Notificaciones activadas en este teléfono.'); }
  else say('Activa las notificaciones desde los ajustes del navegador.');
});
document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(nav => nav.classList.toggle('active', nav === item));
  const isToday = item.dataset.tab === 'today';
  const next = isToday ? $('#today-view') : $('#history-view');
  $('#today-view').classList.toggle('hidden', !isToday); $('#history-view').classList.toggle('hidden', isToday);
  next.classList.remove('view-enter'); void next.offsetWidth; next.classList.add('view-enter');
}));
function runReminderCheck() {
  if (state.isGuest || !state.profile || !('Notification' in window) || Notification.permission !== 'granted' || !state.data) return;
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
      if (error.status !== 400 || !storedProfile?.name || !storedProfile?.zoneId) {
        if (error.status === 400) { state.selectedZone = state.data.zones[0]?.id || null; renderZonePicker(); $('#profile-dialog').showModal(); }
        else say(error.message);
        return;
      }
      result = await api('/api/profile/claim', request('POST', { deviceId, name: storedProfile.name, zoneId: storedProfile.zoneId }));
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
