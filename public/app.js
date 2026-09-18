// ---------- State ----------
let token = localStorage.getItem('gp_token') || null;
let me = null;
let users = [];
let socket = null;
let tasksCache = [];
let notificationsCache = [];
let pollsCache = [];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- Installable app (PWA) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = $('#install-btn');
  if (btn) btn.classList.remove('hidden');
});

document.addEventListener('DOMContentLoaded', () => {
  const installBtn = $('#install-btn');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      installBtn.classList.add('hidden');
    });
  }
});

window.addEventListener('appinstalled', () => {
  const btn = $('#install-btn');
  if (btn) btn.classList.add('hidden');
});

async function api(path, options = {}) {
  // A hard timeout so a slow/stuck server request can never leave a button
  // disabled forever with no feedback — it'll show a real error instead.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('That took too long. Please check your connection and try again.');
    throw new Error('Could not reach the server. Please check your connection and try again.');
  } finally {
    clearTimeout(timeoutId);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ---------- Media upload (used by both chat attachments and feed posts) ----------
async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed.');
  return data; // { url, name, mime, kind, size }
}

// ---------- Auth screen tabs ----------
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('#login-form').classList.toggle('hidden', tab !== 'login');
    $('#signup-form').classList.toggle('hidden', tab !== 'signup');
  });
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#login-name').value,
        password: $('#login-password').value,
      }),
    });
    onLoggedIn(data);
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#signup-error').textContent = '';
  try {
    const data = await api('/api/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#signup-name').value,
        email: $('#signup-email').value,
        password: $('#signup-password').value,
      }),
    });
    onLoggedIn(data);
  } catch (err) {
    $('#signup-error').textContent = err.message;
  }
});

// ---------- Show/hide password toggles (login, signup, profile, forgot-password) ----------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.show-pass-btn');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.target);
  if (!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? '👁️' : '🙈';
});

$('#logout-btn').addEventListener('click', () => {
  localStorage.removeItem('gp_token');
  token = null;
  me = null;
  if (socket) socket.disconnect();
  location.reload();
});

// ---------- Modal open/close helpers ----------
function openModal(id) { $(`#${id}`)?.classList.remove('hidden'); }
function closeModal(id) { $(`#${id}`)?.classList.add('hidden'); }

document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close-modal]');
  if (closeBtn) { closeModal(closeBtn.dataset.closeModal); return; }
  // Clicking the dimmed overlay itself (not the card) closes the modal too.
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
  }
});

// ---------- Forgot password (email OTP) ----------
let forgotPasswordEmail = '';

$('#forgot-password-link').addEventListener('click', () => {
  $('#forgot-request-form').classList.remove('hidden');
  $('#forgot-reset-form').classList.add('hidden');
  $('#forgot-request-error').textContent = '';
  $('#forgot-reset-error').textContent = '';
  $('#forgot-email').value = '';
  openModal('forgot-password-modal');
});

async function requestPasswordResetCode(email) {
  $('#forgot-request-error').textContent = '';
  const btn = $('#forgot-request-btn');
  btn.disabled = true;
  try {
    await api('/api/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    forgotPasswordEmail = email;
    $('#forgot-request-form').classList.add('hidden');
    $('#forgot-reset-form').classList.remove('hidden');
    $('#forgot-otp').value = '';
    $('#forgot-new-password').value = '';
  } catch (err) {
    $('#forgot-request-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

$('#forgot-request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await requestPasswordResetCode($('#forgot-email').value.trim());
});

$('#forgot-resend-btn').addEventListener('click', async () => {
  if (!forgotPasswordEmail) return;
  await requestPasswordResetCode(forgotPasswordEmail);
});

$('#forgot-reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#forgot-reset-error').textContent = '';
  const btn = $('#forgot-reset-btn');
  btn.disabled = true;
  try {
    await api('/api/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        email: forgotPasswordEmail,
        otp: $('#forgot-otp').value.trim(),
        newPassword: $('#forgot-new-password').value,
      }),
    });
    closeModal('forgot-password-modal');
    alert('Password reset! You can log in with your new password now.');
    $('#login-name').focus();
  } catch (err) {
    $('#forgot-reset-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function onLoggedIn(data) {
  token = data.token;
  me = data.user;
  localStorage.setItem('gp_token', token);
  startApp();
}

// ---------- Page navigation ----------
$$('.page-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.page-btn').forEach((b) => b.classList.remove('active'));
    $$('.page').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#page-${btn.dataset.page}`).classList.add('active');
    // Notifications are marked "seen" server-side the moment they're fetched,
    // so re-fetch each time someone actually opens Home to see fresh ones.
    if (btn.dataset.page === 'home' && me) loadNotifications().catch(() => {});
  });
});

// ---------- App startup ----------
async function startApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  renderProfileButton();

  await loadUsers();
  await loadMessages();
  await loadFeed();
  await loadTasks();
  await loadNotifications();
  await loadPolls();
  connectSocket();
  setupNotifications();
  maybeAutoJoinCall();
  setupChatMediaInput();
  setupPostMediaInput();
  setupProfileModal();
  setupPollModal();
  setupTypingIndicator();
}

function renderProfileButton() {
  const btn = $('#profile-btn');
  if (!btn || !me) return;
  btn.innerHTML = avatarOrInitials(me.id, me.name, '', 32);
  btn.title = me.name;
  btn.classList.remove('hidden');
}

// ---------- Profile modal (view/edit profile, avatar, dark mode, password) ----------
function applyDarkModePreference() {
  const saved = localStorage.getItem('gp_theme');
  const isDark = saved === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  const toggle = $('#dark-mode-toggle');
  if (toggle) toggle.checked = isDark;
}

function setupProfileModal() {
  const profileBtn = $('#profile-btn');
  if (profileBtn && !profileBtn.dataset.wired) {
    profileBtn.dataset.wired = '1';
    profileBtn.addEventListener('click', () => {
      $('#profile-name-input').value = me.name;
      $('#profile-email-input').value = me.email || '';
      $('#profile-avatar-preview').innerHTML = avatarOrInitials(me.id, me.name, '', 84);
      $('#profile-save-error').textContent = '';
      $('#profile-save-success').classList.add('hidden');
      $('#change-password-error').textContent = '';
      $('#change-password-success').classList.add('hidden');
      $('#current-password-input').value = '';
      $('#new-password-input').value = '';
      applyDarkModePreference();
      openModal('profile-modal');
    });
  }

  const avatarInput = $('#profile-avatar-input');
  if (avatarInput && !avatarInput.dataset.wired) {
    avatarInput.dataset.wired = '1';
    avatarInput.addEventListener('change', async () => {
      const file = avatarInput.files[0];
      avatarInput.value = '';
      if (!file) return;
      $('#profile-save-error').textContent = '';
      try {
        const uploaded = await uploadFile(file);
        const { user } = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ avatarUrl: uploaded.url }) });
        me.avatarUrl = user.avatarUrl;
        $('#profile-avatar-preview').innerHTML = avatarOrInitials(me.id, me.name, '', 84);
        renderProfileButton();
      } catch (err) {
        $('#profile-save-error').textContent = err.message;
      }
    });
  }

  const nameForm = $('#profile-name-form');
  if (nameForm && !nameForm.dataset.wired) {
    nameForm.dataset.wired = '1';
    nameForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#profile-save-error').textContent = '';
      $('#profile-save-success').classList.add('hidden');
      try {
        const { user } = await api('/api/me', {
          method: 'PATCH',
          body: JSON.stringify({
            name: $('#profile-name-input').value.trim(),
            email: $('#profile-email-input').value.trim(),
          }),
        });
        me.name = user.name;
        me.email = user.email;
        renderProfileButton();
        $('#profile-save-success').classList.remove('hidden');
      } catch (err) {
        $('#profile-save-error').textContent = err.message;
      }
    });
  }

  const darkToggle = $('#dark-mode-toggle');
  if (darkToggle && !darkToggle.dataset.wired) {
    darkToggle.dataset.wired = '1';
    darkToggle.addEventListener('change', () => {
      const isDark = darkToggle.checked;
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
      try { localStorage.setItem('gp_theme', isDark ? 'dark' : 'light'); } catch {}
    });
  }

  const passwordForm = $('#change-password-form');
  if (passwordForm && !passwordForm.dataset.wired) {
    passwordForm.dataset.wired = '1';
    passwordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#change-password-error').textContent = '';
      $('#change-password-success').classList.add('hidden');
      try {
        await api('/api/change-password', {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: $('#current-password-input').value,
            newPassword: $('#new-password-input').value,
          }),
        });
        $('#current-password-input').value = '';
        $('#new-password-input').value = '';
        $('#change-password-success').classList.remove('hidden');
      } catch (err) {
        $('#change-password-error').textContent = err.message;
      }
    });
  }
}

// ---------- Incoming-call notification handling ----------
// If someone tapped "Join" on a call notification while the app was already
// open, the service worker messages us directly.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'join-call') {
      goToCallPageAndJoin();
    }
  });
}

// If the app had to be opened fresh (it wasn't running), the service worker
// opens it at /?join-call=1 instead. Check for that once we've logged in.
function maybeAutoJoinCall() {
  const params = new URLSearchParams(location.search);
  if (params.get('join-call') === '1') {
    history.replaceState(null, '', location.pathname);
    goToCallPageAndJoin();
  }
}

function goToCallPageAndJoin() {
  $$('.page-btn').forEach((b) => b.classList.remove('active'));
  $$('.page').forEach((p) => p.classList.remove('active'));
  $('.page-btn[data-page="chat"]').classList.add('active');
  $('#page-chat').classList.add('active');
  joinCallAndRevealBar();
}

function joinCallAndRevealBar() {
  $('#call-bar')?.classList.remove('hidden');
  if (!inCall) joinCall();
}

// ---------- Push notifications ----------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function setupNotifications() {
  const btn = $('#notif-btn');
  if (!btn) return;

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return; // silently do nothing on unsupported browsers (e.g. desktop Safari)

  if (Notification.permission === 'granted') {
    btn.classList.add('hidden');
    subscribeToPush().catch(() => {}); // make sure this device is registered
    return;
  }

  if (Notification.permission === 'denied') {
    btn.classList.add('hidden');
    return;
  }

  btn.classList.remove('hidden');
  btn.onclick = async () => {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      btn.classList.add('hidden');
      try {
        await subscribeToPush();
      } catch {
        alert('Could not enable notifications on this device. You can try again later.');
      }
    } else {
      btn.classList.add('hidden');
    }
  };
}

async function subscribeToPush() {
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    const { publicKey } = await api('/api/push/public-key');
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  await api('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription }),
  });
}

async function tryAutoLogin() {
  if (!token) return;
  try {
    const data = await api('/api/me');
    me = data.user;
    startApp();
  } catch {
    localStorage.removeItem('gp_token');
    token = null;
  }
}

// ---------- Users / split checkboxes ----------
function renderUserPickers() {
  const sub = $('#header-sub');
  if (sub) sub.textContent = `${users.length} roommate${users.length === 1 ? '' : 's'}`;

  const assigneeSelect = $('#task-assignee');
  if (assigneeSelect) {
    const previousValue = assigneeSelect.value;
    assigneeSelect.innerHTML = users.map(u => `
      <option value="${u.id}">${escapeHtml(u.name)}${u.id === me?.id ? ' (you)' : ''}</option>
    `).join('');
    if (previousValue && users.some(u => u.id === previousValue)) assigneeSelect.value = previousValue;
  }
}

async function loadUsers() {
  const data = await api('/api/users');
  users = data.users;
  renderUserPickers();
}

function userName(id) {
  const u = users.find(u => u.id === id);
  return u ? u.name : 'Someone';
}

// ---------- Avatars ----------
const AVATAR_COLORS = ['#FF6B6B', '#FFA94D', '#4ECDC4', '#5B8DEF', '#8E7CFF', '#FF7EB6', '#38C793', '#FFB84D'];

function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initialsForName(name) {
  const parts = name.trim().split(/\s+/);
  const initials = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return initials.toUpperCase();
}

function avatarHtml(name, extraClass = '', size) {
  const style = size ? `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;` : '';
  return `<span class="avatar ${extraClass}" style="${style}background:${colorForName(name)};">${escapeHtml(initialsForName(name))}</span>`;
}

function userAvatarUrl(id) {
  if (me && id === me.id && me.avatarUrl) return me.avatarUrl;
  const u = users.find(u => u.id === id);
  return u && u.avatarUrl ? u.avatarUrl : null;
}

// Renders a real profile photo when the user has one, falling back to the
// colored-initials avatar otherwise.
function avatarOrInitials(id, name, extraClass = '', size) {
  const url = id ? userAvatarUrl(id) : null;
  if (url) {
    const style = size ? `width:${size}px;height:${size}px;` : '';
    return `<img class="avatar ${extraClass}" style="${style}object-fit:cover;" src="${url}" alt="" />`;
  }
  return avatarHtml(name, extraClass, size);
}

// ---------- Polls (any member can start a referendum with a time limit) ----------
function pollTimeLeftLabel(expiresAt) {
  const diff = expiresAt - Date.now();
  if (diff <= 0) return 'Voting closed';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m left`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h left`;
  const days = Math.round(hours / 24);
  return `${days}d left`;
}

function pollCardHtml(poll) {
  const closed = poll.closed;
  const iVoted = poll.myVote !== null && poll.myVote !== undefined;
  const optionsHtml = poll.options.map(opt => {
    const isMyVote = poll.myVote === opt.idx;
    const showResults = closed || iVoted;
    return `
      <li class="poll-option ${isMyVote ? 'my-vote' : ''}" data-action="vote-poll" data-poll-id="${poll.id}" data-option-idx="${opt.idx}">
        ${showResults ? `<div class="poll-option-bar" style="width:${opt.percent}%;"></div>` : ''}
        <div class="poll-option-row">
          <span class="poll-option-text">${isMyVote ? '✓ ' : ''}${escapeHtml(opt.text)}</span>
          ${showResults ? `<span class="poll-option-pct">${opt.percent}% (${opt.voteCount})</span>` : ''}
        </div>
      </li>
    `;
  }).join('');

  return `
    <li class="poll-card ${closed ? 'poll-closed' : ''}" data-poll-id="${poll.id}">
      <div class="poll-card-header">
        <span class="user-link" data-action="view-profile" data-user-id="${poll.createdBy?.id || ''}">
          ${poll.createdBy ? avatarOrInitials(poll.createdBy.id, poll.createdBy.name, 'mini-avatar', 20) : ''}
          <span class="poll-card-author">${poll.createdBy ? escapeHtml(poll.createdBy.name) : 'Someone'}</span>
        </span>
        <span class="poll-card-status ${closed ? 'negative' : 'positive'}">${closed ? 'Closed' : pollTimeLeftLabel(poll.expiresAt)}</span>
      </div>
      <div class="poll-card-question">${escapeHtml(poll.question)}</div>
      <ul class="poll-options">${optionsHtml}</ul>
      <div class="poll-card-footer">${poll.totalVotes} vote${poll.totalVotes === 1 ? '' : 's'}${poll.createdBy?.id === me?.id ? ` · <button type="button" class="link-btn" data-action="delete-poll" data-poll-id="${poll.id}">Delete</button>` : ''}</div>
    </li>
  `;
}

function renderPolls() {
  const list = $('#polls-list');
  if (!list) return;
  list.innerHTML = pollsCache.length === 0
    ? '<li class="empty-state">No polls yet — start one above. 🗳️</li>'
    : pollsCache.map(pollCardHtml).join('');
}

async function loadPolls() {
  const data = await api('/api/polls');
  pollsCache = data.polls;
  renderPolls();
}

function upsertPoll(poll) {
  const idx = pollsCache.findIndex(p => p.id === poll.id);
  if (idx === -1) pollsCache.unshift(poll); else pollsCache[idx] = poll;
  renderPolls();
}

function applyPollVoteUpdate({ id, options, totalVotes }) {
  const poll = pollsCache.find(p => p.id === id);
  if (!poll) return;
  for (const o of options) {
    const target = poll.options.find(x => x.idx === o.idx);
    if (target) {
      target.voteCount = o.voteCount;
      target.percent = totalVotes ? Math.round((o.voteCount / totalVotes) * 100) : 0;
    }
  }
  poll.totalVotes = totalVotes;
  renderPolls();
}

function setupPollModal() {
  const newPollBtn = $('#new-poll-btn');
  if (newPollBtn && !newPollBtn.dataset.wired) {
    newPollBtn.dataset.wired = '1';
    newPollBtn.addEventListener('click', () => {
      $('#new-poll-form').reset();
      $('#poll-error').textContent = '';
      const optionsList = $('#poll-options-list');
      optionsList.innerHTML = `
        <input type="text" class="poll-option-input" placeholder="Option 1" required maxlength="80" />
        <input type="text" class="poll-option-input" placeholder="Option 2" required maxlength="80" />
      `;
      openModal('new-poll-modal');
      $('#poll-question-input')?.focus();
    });
  }

  const addOptionBtn = $('#poll-add-option-btn');
  if (addOptionBtn && !addOptionBtn.dataset.wired) {
    addOptionBtn.dataset.wired = '1';
    addOptionBtn.addEventListener('click', () => {
      const optionsList = $('#poll-options-list');
      const count = optionsList.querySelectorAll('.poll-option-input').length;
      if (count >= 8) return;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'poll-option-input';
      input.placeholder = `Option ${count + 1}`;
      input.maxLength = 80;
      optionsList.appendChild(input);
      input.focus();
    });
  }

  const pollForm = $('#new-poll-form');
  if (pollForm && !pollForm.dataset.wired) {
    pollForm.dataset.wired = '1';
    pollForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#poll-error').textContent = '';
      const question = $('#poll-question-input').value.trim();
      const options = Array.from($$('#poll-options-list .poll-option-input')).map(i => i.value.trim()).filter(Boolean);
      const durationMinutes = Number($('#poll-duration-input').value);
      try {
        await api('/api/polls', { method: 'POST', body: JSON.stringify({ question, options, durationMinutes }) });
        closeModal('new-poll-modal');
      } catch (err) {
        $('#poll-error').textContent = err.message;
      }
    });
  }
}

const pollsListEl = $('#polls-list');
if (pollsListEl) {
  pollsListEl.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('[data-action="delete-poll"]');
    if (deleteBtn) {
      if (!confirm('Delete this poll?')) return;
      try {
        await api(`/api/polls/${deleteBtn.dataset.pollId}`, { method: 'DELETE' });
      } catch (err) {
        alert(err.message);
      }
      return;
    }

    const option = e.target.closest('[data-action="vote-poll"]');
    if (option) {
      const poll = pollsCache.find(p => p.id === option.dataset.pollId);
      if (!poll || poll.closed) return;
      try {
        const { poll: updated } = await api(`/api/polls/${option.dataset.pollId}/vote`, {
          method: 'POST',
          body: JSON.stringify({ optionIdx: Number(option.dataset.optionIdx) }),
        });
        const idx = pollsCache.findIndex(p => p.id === updated.id);
        if (idx !== -1) pollsCache[idx] = updated;
        renderPolls();
      } catch (err) {
        alert(err.message);
      }
    }
  });
}

// Poll cards' "time left" labels drift as time passes — refresh them periodically.
setInterval(() => { if (pollsCache.length) renderPolls(); }, 60000);

// ---------- Tasks (create & assign to a roommate, with a due date) ----------
function formatDueDate(dueDate) {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  if (isNaN(d.getTime())) return null;
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  const dateLabel = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (diffDays === 0) return { label: 'Due today', overdue: false, dueSoon: true };
  if (diffDays === 1) return { label: 'Due tomorrow', overdue: false, dueSoon: true };
  if (diffDays < 0) return { label: `Overdue — was due ${dateLabel}`, overdue: true, dueSoon: false };
  return { label: `Due ${dateLabel}`, overdue: false, dueSoon: false };
}

function taskRowHtml(task, { showAssignee, interactive = true }) {
  const due = formatDueDate(task.dueDate);
  const dueClass = due && !task.done ? (due.overdue ? 'negative' : due.dueSoon ? 'positive' : '') : '';
  const checkbox = interactive
    ? `<button type="button" class="task-checkbox ${task.done ? 'checked' : ''}" data-action="toggle-task" title="${task.done ? 'Mark as not done' : 'Mark as done'}">${task.done ? '✓' : ''}</button>`
    : `<span class="task-checkbox ${task.done ? 'checked' : ''}" aria-hidden="true">${task.done ? '✓' : ''}</span>`;
  return `
    <li class="task-row ${task.done ? 'task-done' : ''}" data-task-id="${task.id}">
      ${checkbox}
      <div class="task-row-main">
        <div class="task-row-title">${escapeHtml(task.title)}</div>
        <div class="task-row-meta">
          ${showAssignee && task.assignedTo ? `<span class="user-link" data-action="view-profile" data-user-id="${task.assignedTo.id}">${avatarOrInitials(task.assignedTo.id, task.assignedTo.name, 'mini-avatar', 18)}${escapeHtml(task.assignedTo.name)}</span> · ` : ''}
          ${due ? `<span class="${dueClass}">${due.label}</span>` : 'No due date'}
        </div>
      </div>
      ${interactive ? `<button type="button" class="del-btn" data-action="delete-task" title="Delete task">✕</button>` : ''}
    </li>
  `;
}

function renderHomeTasks() {
  const list = $('#home-tasks-list');
  if (!list) return;
  const mine = tasksCache.filter(t => t.assignedTo && t.assignedTo.id === me?.id);
  list.innerHTML = mine.length === 0
    ? '<li class="empty-state">No tasks assigned to you right now. 🎉</li>'
    : mine.map(t => taskRowHtml(t, { showAssignee: false })).join('');
}

function renderAllTasks() {
  const list = $('#all-tasks-list');
  if (!list) return;
  list.innerHTML = tasksCache.length === 0
    ? '<li class="empty-state">No tasks yet — assign the first one above.</li>'
    : tasksCache.map(t => taskRowHtml(t, { showAssignee: true })).join('');
}

async function loadTasks() {
  const data = await api('/api/tasks');
  tasksCache = data.tasks;
  renderHomeTasks();
  renderAllTasks();
}

function upsertTask(task) {
  const idx = tasksCache.findIndex(t => t.id === task.id);
  if (idx === -1) tasksCache.unshift(task); else tasksCache[idx] = task;
  renderHomeTasks();
  renderAllTasks();
}

$('#task-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#task-error').textContent = '';
  const title = $('#task-title').value;
  const assignedTo = $('#task-assignee').value;
  const dueDate = $('#task-due-date').value;
  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, assignedTo, dueDate }) });
    $('#task-form').reset();
  } catch (err) {
    $('#task-error').textContent = err.message;
  }
});

async function handleTaskListClick(e) {
  const row = e.target.closest('.task-row');
  if (!row) return;
  const taskId = row.dataset.taskId;

  if (e.target.closest('[data-action="toggle-task"]')) {
    try {
      await api(`/api/tasks/${taskId}/toggle`, { method: 'POST' });
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  if (e.target.closest('[data-action="delete-task"]')) {
    if (!confirm('Delete this task?')) return;
    try {
      await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
    } catch (err) {
      alert(err.message);
    }
  }
}

$('#home-tasks-list')?.addEventListener('click', handleTaskListClick);
$('#all-tasks-list')?.addEventListener('click', handleTaskListClick);

// ---------- In-app notifications feed (Home tab) ----------
function notificationIcon(type) {
  if (type === 'task') return '✅';
  if (type === 'poll') return '🗳️';
  if (type === 'like') return '❤️';
  if (type === 'comment') return '💬';
  if (type === 'post') return '📸';
  return '🔔';
}

function renderNotifications(list) {
  const box = $('#home-notifications-list');
  if (!box) return;
  box.innerHTML = list.length === 0
    ? '<li class="empty-state">No notifications yet.</li>'
    : list.map(n => `
      <li class="notification-row ${n.read ? '' : 'unread'}">
        <span class="notification-icon">${notificationIcon(n.type)}</span>
        <div class="notification-row-main">
          <div class="notification-text">${escapeHtml(n.text)}</div>
          <div class="notification-time">${timeAgo(n.createdAt)}</div>
        </div>
        ${n.read ? '' : '<span class="notification-dot"></span>'}
      </li>
    `).join('');
}

async function loadNotifications() {
  const data = await api('/api/notifications');
  notificationsCache = data.notifications;
  renderNotifications(notificationsCache);
}

// ---------- View someone's profile (Instagram-style, read-only) ----------
async function openUserProfile(userId) {
  if (!userId) return;
  if (userId === me?.id) {
    // Viewing yourself opens the same modal as the header avatar, where you
    // can actually make changes — editing only ever applies to your own profile.
    $('#profile-btn')?.click();
    return;
  }

  openModal('user-profile-modal');
  const body = $('#user-profile-body');
  body.innerHTML = '<p class="empty-state">Loading…</p>';

  try {
    const data = await api(`/api/users/${userId}/profile`);
    body.innerHTML = renderUserProfileBody(data);
  } catch (err) {
    body.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function renderUserProfileBody(data) {
  const { user, joinedAt, posts: theirPosts, tasks: theirTasks } = data;
  const joined = joinedAt
    ? new Date(joinedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  const tasksHtml = theirTasks.length
    ? theirTasks.map(t => taskRowHtml(t, { showAssignee: false, interactive: false })).join('')
    : '<li class="empty-state">No tasks assigned.</li>';

  const postsHtml = theirPosts.length
    ? `<div class="profile-posts-grid">${theirPosts.map(p => `
        <div class="profile-post-tile">
          ${p.media
            ? (p.media.kind === 'video'
                ? `<video src="${p.media.url}" muted></video>`
                : `<img src="${p.media.url}" alt="" />`)
            : `<div class="profile-post-tile-text">${escapeHtml(p.caption || '').slice(0, 120)}</div>`}
          <div class="profile-post-tile-overlay">❤️ ${p.likeCount} · 💬 ${p.comments.length}</div>
        </div>
      `).join('')}</div>`
    : '<p class="empty-state">No posts yet.</p>';

  return `
    <div class="profile-avatar-row">
      <div class="profile-avatar-preview">${avatarOrInitials(user.id, user.name, '', 84)}</div>
      <div style="text-align:center;">
        <div style="font-weight:700;font-size:17px;">${escapeHtml(user.name)}</div>
        ${joined ? `<div style="color:var(--muted);font-size:12.5px;margin-top:2px;">Joined ${joined}</div>` : ''}
      </div>
    </div>

    <div class="modal-divider"></div>
    <div class="field-label">Feed</div>
    ${postsHtml}

    <div class="modal-divider"></div>
    <div class="field-label">Tasks</div>
    <ul class="task-list">${tasksHtml}</ul>
  `;
}

// Any element anywhere in the app marked up with data-action="view-profile"
// and a data-user-id opens that person's profile — chat sender names, feed
// post headers, poll authors, and task assignees are all wired this way.
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-action="view-profile"]');
  if (trigger && trigger.dataset.userId) openUserProfile(trigger.dataset.userId);
});

// ---------- Chat ----------
async function loadMessages() {
  const data = await api('/api/messages');
  const box = $('#chat-messages');
  box.innerHTML = data.messages.map(renderMessage).join('');
  box.scrollTop = box.scrollHeight;
}

function renderAttachment(attachment) {
  if (!attachment || !attachment.url) return '';
  if (attachment.kind === 'image') {
    return `<a class="msg-media" href="${attachment.url}" target="_blank" rel="noopener"><img src="${attachment.url}" alt="" /></a>`;
  }
  if (attachment.kind === 'video') {
    return `<div class="msg-media"><video src="${attachment.url}" controls></video></div>`;
  }
  return `<a class="msg-file-chip" href="${attachment.url}" download target="_blank" rel="noopener">📎 ${escapeHtml(attachment.name || 'File')}</a>`;
}

function attachmentLabel(kind) {
  if (kind === 'image') return '📷 Photo';
  if (kind === 'video') return '🎥 Video';
  if (kind === 'file') return '📎 Attachment';
  return '';
}

function renderReplyQuote(replyTo) {
  if (!replyTo) return '';
  const isMine = replyTo.userId === me.id;
  const label = replyTo.text ? escapeHtml(replyTo.text).slice(0, 140) : attachmentLabel(replyTo.attachmentKind);
  return `
    <div class="msg-reply-quote" data-action="scroll-to-message" data-scroll-target="${replyTo.id}">
      <div class="msg-reply-quote-name" style="color:${colorForName(replyTo.userName || 'x')};">${isMine ? 'You' : escapeHtml(replyTo.userName || 'Someone')}</div>
      <div class="msg-reply-quote-text">${label}</div>
    </div>
  `;
}

function renderMessage(m) {
  if (m.type === 'call-start') return renderCallSystemMessage(m);

  const mine = m.user_id === me.id;
  const name = m.user_name || userName(m.user_id);
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const attachmentKind = m.attachment ? m.attachment.kind : '';
  return `
    <div class="chat-msg-row ${mine ? 'mine' : ''}" data-message-id="${m.id}" data-sender-name="${escapeHtml(name)}" data-text="${escapeHtml(m.text || '')}" data-attachment-kind="${attachmentKind}">
      <div class="chat-msg">
        <div class="bubble">
          ${mine ? '' : `<div class="sender" data-action="view-profile" data-user-id="${m.user_id}" style="color:${colorForName(name)};">${escapeHtml(name)}</div>`}
          ${renderReplyQuote(m.reply_to)}
          ${renderAttachment(m.attachment)}
          ${m.text ? `<span class="msg-text">${escapeHtml(m.text)}</span>` : ''}
          <span class="msg-time">${time}</span>
        </div>
        <button type="button" class="msg-reply-hint" data-action="start-reply" title="Reply">↩</button>
      </div>
    </div>
  `;
}

function renderCallSystemMessage(m) {
  const mine = m.user_id === me.id;
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const label = mine ? 'You started a house call' : `${escapeHtml(m.user_name)} started a house call`;
  return `
    <div class="chat-call-system">
      <div class="chat-call-system-pill">
        📞 ${label} · ${time}
        <button type="button" data-action="join-call-from-message">Join</button>
      </div>
    </div>
  `;
}

// ---------- Chat media attachments ----------
let chatPendingAttachment = null;
let chatPendingUploadPromise = null;

function showChatMediaPreviewLoading(file) {
  const box = $('#chat-media-preview');
  if (!box) return;
  const url = URL.createObjectURL(file);
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  box.innerHTML = `
    ${isImage ? `<img src="${url}" />` : isVideo ? `<video src="${url}" muted></video>` : `<div style="padding:14px;color:white;font-size:13px;">📎 ${escapeHtml(file.name)}</div>`}
    <button type="button" class="remove-media-btn" id="chat-media-remove">✕</button>
  `;
  box.classList.remove('hidden');
  $('#chat-media-remove').addEventListener('click', clearChatMediaPreview);
}

function clearChatMediaPreview() {
  const box = $('#chat-media-preview');
  if (!box) return;
  box.innerHTML = '';
  box.classList.add('hidden');
  chatPendingAttachment = null;
  chatPendingUploadPromise = null;
}

function setupChatMediaInput() {
  const input = $('#chat-media-input');
  if (!input) return;
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    showChatMediaPreviewLoading(file);
    chatPendingUploadPromise = uploadFile(file)
      .then((result) => {
        chatPendingAttachment = result;
        return result;
      })
      .catch((err) => {
        alert(err.message || 'Could not upload that file.');
        clearChatMediaPreview();
        return null;
      });
    await chatPendingUploadPromise;
  });
}

// ---------- Reply to a message (swipe right, WhatsApp/Instagram-style) ----------
let replyTarget = null;

function renderReplyPreview() {
  const box = $('#chat-reply-preview');
  if (!box) return;
  if (!replyTarget) {
    box.classList.add('hidden');
    return;
  }
  const snippet = replyTarget.text ? escapeHtml(replyTarget.text).slice(0, 120) : attachmentLabel(replyTarget.attachmentKind);
  $('#chat-reply-preview-name').textContent = replyTarget.senderName;
  $('#chat-reply-preview-text').innerHTML = snippet;
  box.classList.remove('hidden');
}

function startReplyTo(row) {
  if (!row || !row.dataset.messageId) return;
  replyTarget = {
    id: row.dataset.messageId,
    senderName: row.classList.contains('mine') ? 'You' : (row.dataset.senderName || 'Someone'),
    text: row.dataset.text || '',
    attachmentKind: row.dataset.attachmentKind || '',
  };
  renderReplyPreview();
  $('#chat-input')?.focus();
}

function cancelReply() {
  replyTarget = null;
  renderReplyPreview();
}

$('#chat-reply-cancel')?.addEventListener('click', cancelReply);

const chatMessagesEl = $('#chat-messages');
if (chatMessagesEl) {
  chatMessagesEl.addEventListener('click', (e) => {
    const replyHint = e.target.closest('[data-action="start-reply"]');
    if (replyHint) {
      startReplyTo(replyHint.closest('.chat-msg-row'));
      return;
    }
    const quote = e.target.closest('[data-action="scroll-to-message"]');
    if (quote) {
      const target = document.querySelector(`.chat-msg-row[data-message-id="${quote.dataset.scrollTarget}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('flash-highlight');
        setTimeout(() => target.classList.remove('flash-highlight'), 900);
      }
    }
  });

  // Swipe (touch) / drag (mouse) a message slightly to the right to reply to
  // it — same gesture as WhatsApp and Instagram DMs. A small hover "↩" button
  // (added in renderMessage) covers desktop users who aren't dragging.
  let chatDrag = null;
  const SWIPE_TRIGGER_PX = 40;
  const SWIPE_MAX_PX = 64;

  chatMessagesEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('a, video, button, .sender, [data-action]')) return;
    const row = e.target.closest('.chat-msg-row');
    const bubbleWrap = row?.querySelector('.chat-msg');
    if (!row || !bubbleWrap) return;
    chatDrag = { row, bubbleWrap, startX: e.clientX, startY: e.clientY, dx: 0, dragging: false, pointerId: e.pointerId };
  });

  chatMessagesEl.addEventListener('pointermove', (e) => {
    if (!chatDrag || chatDrag.pointerId !== e.pointerId) return;
    const dx = e.clientX - chatDrag.startX;
    const dy = e.clientY - chatDrag.startY;
    if (!chatDrag.dragging) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) { chatDrag = null; return; } // vertical scroll, not a reply swipe
      chatDrag.dragging = true;
      chatDrag.row.classList.add('swipe-active');
    }
    const clamped = Math.max(0, Math.min(dx, SWIPE_MAX_PX));
    chatDrag.dx = clamped;
    chatDrag.bubbleWrap.style.transform = `translateX(${clamped}px)`;
    chatDrag.row.classList.toggle('swiping-reply', clamped > SWIPE_TRIGGER_PX);
  });

  function endChatDrag(e) {
    if (!chatDrag) return;
    const { row, bubbleWrap, dx, dragging } = chatDrag;
    if (dragging) {
      bubbleWrap.style.transform = '';
      row.classList.remove('swipe-active', 'swiping-reply');
      if (dx > SWIPE_TRIGGER_PX) startReplyTo(row);
    }
    chatDrag = null;
  }
  chatMessagesEl.addEventListener('pointerup', endChatDrag);
  chatMessagesEl.addEventListener('pointercancel', endChatDrag);
  chatMessagesEl.addEventListener('pointerleave', endChatDrag);
}

// ---------- Typing indicator (WhatsApp-style, with mini avatars) ----------
let typingStartSentAt = 0;
let typingStopTimer = null;

function setupTypingIndicator() {
  const input = $('#chat-input');
  if (!input || input.dataset.typingWired) return;
  input.dataset.typingWired = '1';

  const sendStop = () => {
    if (typingStopTimer) { clearTimeout(typingStopTimer); typingStopTimer = null; }
    if (typingStartSentAt) {
      socket?.emit('chat:typing-stop');
      typingStartSentAt = 0;
    }
  };

  input.addEventListener('input', () => {
    if (!socket) return;
    if (!input.value.trim()) { sendStop(); return; }
    const now = Date.now();
    // Throttle "start" pings to at most once every ~2.5s while someone keeps typing.
    if (!typingStartSentAt || now - typingStartSentAt > 2500) {
      socket.emit('chat:typing-start');
      typingStartSentAt = now;
    }
    if (typingStopTimer) clearTimeout(typingStopTimer);
    // Auto-clear "typing" if they pause for a couple of seconds without sending.
    typingStopTimer = setTimeout(sendStop, 2000);
  });

  input.addEventListener('blur', sendStop);
  $('#chat-form')?.addEventListener('submit', sendStop);
}

function renderTypingIndicator(typingList) {
  const box = $('#typing-indicator');
  if (!box) return;
  const others = (typingList || []).filter(t => t.userId !== me?.id);
  if (others.length === 0) {
    box.classList.add('hidden');
    return;
  }
  const avatarsBox = $('#typing-indicator-avatars');
  avatarsBox.innerHTML = others.slice(0, 4).map(t =>
    avatarOrInitials(t.userId, t.userName || 'Someone', 'typing-avatar', 20)
  ).join('');
  box.title = others.length === 1
    ? `${others[0].userName || 'Someone'} is typing…`
    : `${others.map(o => o.userName || 'Someone').join(', ')} are typing…`;
  box.classList.remove('hidden');
  const messagesBox = $('#chat-messages');
  if (messagesBox) messagesBox.scrollTop = messagesBox.scrollHeight;
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();

  let attachment = null;
  if (chatPendingUploadPromise) {
    attachment = await chatPendingUploadPromise;
    if (!attachment) return; // upload failed — already alerted, keep the draft
  }

  if (!text && !attachment) return;
  if (!socket) return;

  socket.emit('chat:send', {
    text,
    attachment: attachment
      ? { url: attachment.url, name: attachment.name, mime: attachment.mime, kind: attachment.kind }
      : null,
    replyTo: replyTarget ? replyTarget.id : null,
  });
  input.value = '';
  clearChatMediaPreview();
  cancelReply();
});

function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('chat:message', (m) => {
    const box = $('#chat-messages');
    box.insertAdjacentHTML('beforeend', renderMessage(m));
    box.scrollTop = box.scrollHeight;
  });

  socket.on('user:updated', (u) => {
    const idx = users.findIndex(x => x.id === u.id);
    if (idx !== -1) users[idx] = u; else users.push(u);
  });

  // A new roommate signed up — pick them up in split checkboxes / task assignees
  // without needing everyone else to reload.
  socket.on('user:new', (u) => {
    if (users.some(x => x.id === u.id)) return;
    users.push(u);
    renderUserPickers();
  });

  // ---------- Polls ----------
  socket.on('poll:new', upsertPoll);
  socket.on('poll:updated', applyPollVoteUpdate);
  socket.on('poll:deleted', ({ id }) => {
    pollsCache = pollsCache.filter(p => p.id !== id);
    renderPolls();
  });

  // ---------- Typing indicator ----------
  socket.on('chat:typing-users', renderTypingIndicator);

  // ---------- Notifications ----------
  socket.on('notification:new', ({ userId, notification }) => {
    if (userId !== me?.id) return;
    notificationsCache.unshift(notification);
    renderNotifications(notificationsCache);
  });

  // ---------- Tasks ----------
  socket.on('task:new', upsertTask);
  socket.on('task:updated', upsertTask);
  socket.on('task:deleted', ({ id }) => {
    tasksCache = tasksCache.filter(t => t.id !== id);
    renderHomeTasks();
    renderAllTasks();
  });

  // ---------- Feed ----------
  socket.on('post:new', (post) => {
    if (posts.find(p => p.id === post.id)) return;
    posts.unshift(post);
    const list = $('#feed-list');
    if (list) {
      const empty = list.querySelector('.empty-state');
      if (empty) list.innerHTML = '';
      list.insertAdjacentHTML('afterbegin', renderPostCard(post));
    }
  });

  socket.on('post:deleted', ({ id }) => {
    posts = posts.filter(p => p.id !== id);
    const card = document.querySelector(`.post-card[data-post-id="${id}"]`);
    if (card) card.remove();
    const list = $('#feed-list');
    if (list && posts.length === 0) {
      list.innerHTML = '<p class="empty-state">No posts yet — share the first one above! 🎉</p>';
    }
  });

  socket.on('post:like-update', ({ id, likes }) => {
    const post = posts.find(p => p.id === id);
    if (!post) return;
    post.likes = likes;
    const card = document.querySelector(`.post-card[data-post-id="${id}"]`);
    if (!card) return;
    const btn = card.querySelector('[data-action="like-post"]');
    if (btn) {
      const likedByMe = likes.includes(me.id);
      btn.classList.toggle('liked', likedByMe);
      btn.innerHTML = `${likedByMe ? '❤️' : '🤍'} <span class="count">${likes.length}</span>`;
    }
  });

  socket.on('post:comment-new', ({ postId, comment }) => {
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    post.comments.push(comment);
    const card = document.querySelector(`.post-card[data-post-id="${postId}"]`);
    if (!card) return;
    const commentsBox = card.querySelector('.post-card-comments');
    if (commentsBox) commentsBox.insertAdjacentHTML('beforeend', renderComment(comment));
    const countEls = card.querySelectorAll('.post-action-btn .count');
    if (countEls[1]) countEls[1].textContent = post.comments.length;
  });

  // ---------- Call signaling ----------
  socket.on('call:peer-joined', ({ socketId, userName }) => {
    // The new peer will send us an offer shortly; just remember their name for the tile.
    pendingPeerNames[socketId] = userName;
  });

  socket.on('call:peer-left', ({ socketId }) => {
    closePeerConnection(socketId);
  });

  socket.on('call:offer', async ({ from, userName, offer }) => {
    pendingPeerNames[from] = userName;
    const pc = getOrCreatePeerConnection(from);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call:answer', { to: from, answer });
  });

  socket.on('call:answer', async ({ from, answer }) => {
    const pc = peerConnections[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('call:ice-candidate', async ({ from, candidate }) => {
    const pc = peerConnections[from];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  });
}

// ---------- Feed (Instagram-style posts) ----------
let posts = [];
let postPendingAttachment = null;
let postPendingUploadPromise = null;

function showPostMediaPreviewLoading(file) {
  const box = $('#post-media-preview');
  if (!box) return;
  const url = URL.createObjectURL(file);
  const isImage = file.type.startsWith('image/');
  box.innerHTML = `
    ${isImage ? `<img src="${url}" />` : `<video src="${url}" muted controls></video>`}
    <button type="button" class="remove-media-btn" id="post-media-remove">✕</button>
  `;
  box.classList.remove('hidden');
  $('#post-media-remove').addEventListener('click', clearPostMediaPreview);
}

function clearPostMediaPreview() {
  const box = $('#post-media-preview');
  if (!box) return;
  box.innerHTML = '';
  box.classList.add('hidden');
  postPendingAttachment = null;
  postPendingUploadPromise = null;
}

function setupPostMediaInput() {
  const input = $('#post-media-input');
  if (!input) return;
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    showPostMediaPreviewLoading(file);
    postPendingUploadPromise = uploadFile(file)
      .then((result) => {
        postPendingAttachment = result;
        return result;
      })
      .catch((err) => {
        alert(err.message || 'Could not upload that file.');
        clearPostMediaPreview();
        return null;
      });
    await postPendingUploadPromise;
  });
}

$('#post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#post-error').textContent = '';
  const captionInput = $('#post-caption');
  const caption = captionInput.value.trim();

  let media = null;
  if (postPendingUploadPromise) {
    const uploaded = await postPendingUploadPromise;
    if (!uploaded) return; // upload failed — already alerted
    media = { url: uploaded.url, kind: uploaded.kind === 'video' ? 'video' : 'image' };
  }

  if (!caption && !media) {
    $('#post-error').textContent = 'Add a caption or a photo/video.';
    return;
  }

  const submitBtn = $('#post-submit-btn');
  submitBtn.disabled = true;
  try {
    await api('/api/posts', { method: 'POST', body: JSON.stringify({ caption, media }) });
    captionInput.value = '';
    clearPostMediaPreview();
  } catch (err) {
    $('#post-error').textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

async function loadFeed() {
  const data = await api('/api/posts');
  posts = data.posts;
  renderFeed();
}

function renderFeed() {
  const list = $('#feed-list');
  if (!list) return;
  if (posts.length === 0) {
    list.innerHTML = '<p class="empty-state">No posts yet — share the first one above! 🎉</p>';
    return;
  }
  list.innerHTML = posts.map(renderPostCard).join('');
}

function timeAgo(timestamp) {
  const diffMs = Date.now() - timestamp;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function renderComment(c) {
  return `
    <div class="post-comment-row">
      <span class="comment-author" style="color:${colorForName(c.user_name)};">${escapeHtml(c.user_name)}</span>${escapeHtml(c.text)}
    </div>
  `;
}

function renderPostCard(post) {
  const isMine = post.user_id === me.id;
  const likedByMe = post.likes.includes(me.id);
  const mediaHtml = post.media
    ? (post.media.kind === 'video'
        ? `<div class="post-card-media"><video src="${post.media.url}" controls></video></div>`
        : `<div class="post-card-media"><img src="${post.media.url}" alt="" /></div>`)
    : '';

  return `
    <div class="post-card" data-post-id="${post.id}">
      <div class="post-card-header">
        <span class="post-card-header-clickable" data-action="view-profile" data-user-id="${post.user_id}">
          ${avatarOrInitials(post.user_id, post.user_name, '', 38)}
          <div class="post-card-header-info">
            <div class="post-card-header-name">${escapeHtml(post.user_name)}${isMine ? ' (you)' : ''}</div>
            <div class="post-card-header-time">${timeAgo(post.created_at)}</div>
          </div>
        </span>
        ${isMine ? `<button class="post-delete-btn" data-action="delete-post" title="Delete post">🗑️</button>` : ''}
      </div>
      ${post.caption ? `<div class="post-card-caption">${escapeHtml(post.caption)}</div>` : ''}
      ${mediaHtml}
      <div class="post-card-actions">
        <button class="post-action-btn ${likedByMe ? 'liked' : ''}" data-action="like-post">${likedByMe ? '❤️' : '🤍'} <span class="count">${post.likes.length}</span></button>
        <span class="post-action-btn" style="cursor:default;">💬 <span class="count">${post.comments.length}</span></span>
      </div>
      <div class="post-card-comments">${post.comments.map(renderComment).join('')}</div>
      <form class="post-comment-form" data-action="comment-form">
        <input type="text" placeholder="Add a comment..." maxlength="500" required />
        <button type="submit">Post</button>
      </form>
    </div>
  `;
}

const feedListEl = $('#feed-list');
if (feedListEl) {
  feedListEl.addEventListener('click', async (e) => {
    const likeBtn = e.target.closest('[data-action="like-post"]');
    if (likeBtn) {
      const postId = likeBtn.closest('.post-card').dataset.postId;
      try {
        await api(`/api/posts/${postId}/like`, { method: 'POST' });
      } catch (err) {
        alert(err.message);
      }
      return;
    }

    const deleteBtn = e.target.closest('[data-action="delete-post"]');
    if (deleteBtn) {
      const postId = deleteBtn.closest('.post-card').dataset.postId;
      if (!confirm('Delete this post?')) return;
      try {
        await api(`/api/posts/${postId}`, { method: 'DELETE' });
      } catch (err) {
        alert(err.message);
      }
    }
  });

  feedListEl.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-action="comment-form"]');
    if (!form) return;
    e.preventDefault();
    const postId = form.closest('.post-card').dataset.postId;
    const input = form.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try {
      await api(`/api/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
      input.value = '';
    } catch (err) {
      alert(err.message);
    } finally {
      input.disabled = false;
    }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Voice/video call ----------
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

let localStream = null;
let inCall = false;
let isMuted = false;
let isCameraOff = false;
const peerConnections = {}; // socketId -> RTCPeerConnection
const pendingPeerNames = {}; // socketId -> userName (known before their video tile exists)

function getOrCreatePeerConnection(peerSocketId) {
  if (peerConnections[peerSocketId]) return peerConnections[peerSocketId];

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections[peerSocketId] = pc;

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('call:ice-candidate', { to: peerSocketId, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    addRemoteTile(peerSocketId, pendingPeerNames[peerSocketId] || 'Roommate', event.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      closePeerConnection(peerSocketId);
    }
  };

  return pc;
}

function closePeerConnection(socketId) {
  const pc = peerConnections[socketId];
  if (pc) {
    pc.close();
    delete peerConnections[socketId];
  }
  delete pendingPeerNames[socketId];
  const tile = document.getElementById(`call-tile-${socketId}`);
  if (tile) tile.remove();
}

function addRemoteTile(socketId, name, stream) {
  let tile = document.getElementById(`call-tile-${socketId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.id = `call-tile-${socketId}`;
    tile.innerHTML = `<video autoplay playsinline></video><span class="call-tile-name">${escapeHtml(name)}</span>`;
    $('#call-grid').appendChild(tile);
  }
  const video = tile.querySelector('video');
  if (video.srcObject !== stream) video.srcObject = stream;
}

function addLocalTile() {
  let tile = document.getElementById('call-tile-me');
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.id = 'call-tile-me';
    tile.innerHTML = `<video autoplay playsinline muted></video><span class="call-tile-name">You</span>`;
    $('#call-grid').prepend(tile);
  }
  tile.querySelector('video').srcObject = localStream;
}

async function joinCall() {
  $('#call-error').textContent = '';
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    $('#call-error').textContent = 'Could not access your camera/microphone. Check your browser permissions.';
    return;
  }

  addLocalTile();
  inCall = true;
  $('#call-status').textContent = 'In the call.';
  $('#call-controls').classList.add('hidden');
  $('#call-active-controls').classList.remove('hidden');

  socket.emit('call:join', {}, async ({ peers }) => {
    for (const peer of peers) {
      pendingPeerNames[peer.socketId] = peer.userName;
      const pc = getOrCreatePeerConnection(peer.socketId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call:offer', { to: peer.socketId, offer });
    }
  });
}

function leaveCallClient() {
  socket.emit('call:leave');
  Object.keys(peerConnections).forEach(closePeerConnection);
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  const myTile = document.getElementById('call-tile-me');
  if (myTile) myTile.remove();

  inCall = false;
  isMuted = false;
  isCameraOff = false;
  $('#call-mute-btn').textContent = '🎤 Mute';
  $('#call-camera-btn').textContent = '📷 Camera off';
  $('#call-status').textContent = 'Not in the call.';
  $('#call-controls').classList.remove('hidden');
  $('#call-active-controls').classList.add('hidden');
  $('#call-bar')?.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  $('#call-join-btn').addEventListener('click', joinCall);
  $('#call-leave-btn').addEventListener('click', leaveCallClient);
  $('#chat-call-btn')?.addEventListener('click', joinCallAndRevealBar);

  // "Join" button inside a "📞 X started a house call" chat bubble.
  $('#chat-messages')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="join-call-from-message"]')) joinCallAndRevealBar();
  });

  $('#call-mute-btn').addEventListener('click', () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((track) => (track.enabled = !isMuted));
    $('#call-mute-btn').textContent = isMuted ? '🔇 Unmute' : '🎤 Mute';
  });

  $('#call-camera-btn').addEventListener('click', () => {
    if (!localStream) return;
    isCameraOff = !isCameraOff;
    localStream.getVideoTracks().forEach((track) => (track.enabled = !isCameraOff));
    $('#call-camera-btn').textContent = isCameraOff ? '📷 Camera on' : '📷 Camera off';
  });
});

// Leave the call cleanly if the tab/app is closed while in a call.
window.addEventListener('beforeunload', () => {
  if (inCall && socket) socket.emit('call:leave');
});

// ---------- Init ----------
tryAutoLogin();
