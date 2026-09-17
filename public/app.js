// ---------- State ----------
let token = localStorage.getItem('gp_token') || null;
let me = null;
let users = [];
let socket = null;

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
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
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
  });
});

// ---------- App startup ----------
async function startApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  renderProfileButton();

  await loadUsers();
  await loadExpenses();
  await loadBalances();
  await loadMessages();
  await loadFeed();
  connectSocket();
  setupNotifications();
  maybeAutoJoinCall();
  setupChatMediaInput();
  setupPostMediaInput();
  setupProfileModal();
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
async function loadUsers() {
  const data = await api('/api/users');
  users = data.users;
  const sub = $('#header-sub');
  if (sub) sub.textContent = `${users.length} roommate${users.length === 1 ? '' : 's'}`;
  const box = $('#split-checkboxes');
  box.innerHTML = users.map(u => `
    <label>
      <input type="checkbox" value="${u.id}" checked />
      ${avatarOrInitials(u.id, u.name, 'mini-avatar', 20)}
      ${escapeHtml(u.name)}
    </label>
  `).join('');
}

function userName(id) {
  const u = users.find(u => u.id === id);
  return u ? u.name : 'Someone';
}

// ---------- Avatars ----------
const AVATAR_COLORS = ['#ee6c4d', '#f4a259', '#5b8c5a', '#457b9d', '#7b6cbd', '#e07a9e', '#2a9d8f', '#e9924a'];

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

// ---------- Expenses ----------
$('#expense-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#expense-error').textContent = '';
  const description = $('#exp-description').value;
  const amount = parseFloat($('#exp-amount').value);
  const splitAmong = Array.from($$('#split-checkboxes input:checked')).map(i => i.value);

  if (splitAmong.length === 0) {
    $('#expense-error').textContent = 'Pick at least one person to split with.';
    return;
  }

  try {
    await api('/api/expenses', {
      method: 'POST',
      body: JSON.stringify({ description, amount, splitAmong }),
    });
    $('#exp-description').value = '';
    $('#exp-amount').value = '';
    await loadExpenses();
  } catch (err) {
    $('#expense-error').textContent = err.message;
  }
});

async function loadExpenses() {
  const data = await api('/api/expenses');
  renderExpenses(data.expenses);
}

const EXPENSE_EMOJI_RULES = [
  [/groc|market|vegetabl|fruit/i, '🛒'],
  [/electric|wapda|utility|utilit|gas bill|water bill/i, '💡'],
  [/internet|wifi|broadband/i, '📶'],
  [/rent/i, '🏠'],
  [/food|dinner|lunch|breakfast|restaurant|order|takeaway|zomato|foodpanda/i, '🍔'],
  [/cleaning|maid|detergent/i, '🧹'],
  [/gas cylinder|lpg/i, '🔥'],
  [/fuel|petrol|diesel/i, '⛽'],
  [/medic|pharmacy|doctor/i, '💊'],
];

function emojiForExpense(description) {
  for (const [pattern, emoji] of EXPENSE_EMOJI_RULES) {
    if (pattern.test(description)) return emoji;
  }
  return '💵';
}

function dayHeading(timestamp) {
  const d = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
}

function renderExpenses(expenses) {
  const list = $('#expense-list');
  if (expenses.length === 0) {
    list.innerHTML = '<li class="empty-state">No expenses yet — add the first one above. 🎉</li>';
    return;
  }

  let lastHeading = null;
  const rows = [];

  for (const e of expenses) {
    const heading = dayHeading(e.created_at);
    if (heading !== lastHeading) {
      rows.push(`<li class="expense-day-heading">${escapeHtml(heading)}</li>`);
      lastHeading = heading;
    }

    const iAmPayer = e.paid_by === me.id;
    const iAmInSplit = e.split_among.includes(me.id);
    const myShare = iAmInSplit ? e.amount / e.split_among.length : 0;

    let shareLine = '';
    let shareClass = 'neutral';
    if (iAmPayer) {
      const lentToOthers = e.amount - myShare;
      if (lentToOthers > 0.01) {
        shareLine = `you lent Rs. ${lentToOthers.toFixed(2)}`;
        shareClass = 'positive';
      } else {
        shareLine = 'just for you';
      }
    } else if (iAmInSplit) {
      shareLine = `you owe Rs. ${myShare.toFixed(2)}`;
      shareClass = 'negative';
    } else {
      shareLine = 'not involved';
    }

    const time = new Date(e.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    rows.push(`
      <li class="expense-row">
        <div class="expense-icon">${emojiForExpense(e.description)}</div>
        <div class="expense-row-main">
          <div class="expense-row-title">${escapeHtml(e.description)}</div>
          <div class="expense-row-meta">${iAmPayer ? 'You' : escapeHtml(userName(e.paid_by))} paid · split ${e.split_among.length} way${e.split_among.length === 1 ? '' : 's'} · ${time}</div>
        </div>
        <div class="expense-row-amounts">
          <div class="expense-row-total">Rs. ${e.amount.toFixed(2)}</div>
          <div class="expense-row-share ${shareClass}">${shareLine}</div>
        </div>
        <button class="del-btn" data-id="${e.id}">✕</button>
      </li>
    `);
  }

  list.innerHTML = rows.join('');

  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/expenses/${btn.dataset.id}`, { method: 'DELETE' });
      await loadExpenses();
    });
  });
}

// ---------- Balances ----------
async function loadBalances() {
  const data = await api('/api/balances');
  renderBalances(data);
}

function renderBalances({ net, settlements }) {
  // ---- Summary banner: how the current user personally stands ----
  const myNet = net[me?.id] ?? 0;
  const bannerLabel = $('#balance-banner-label');
  const bannerAmount = $('#balance-banner-amount');
  if (bannerLabel && bannerAmount) {
    if (Math.abs(myNet) < 0.01) {
      bannerLabel.textContent = "You're all settled up";
      bannerAmount.textContent = 'Rs. 0.00';
    } else if (myNet > 0) {
      bannerLabel.textContent = 'You are owed overall';
      bannerAmount.textContent = `Rs. ${myNet.toFixed(2)}`;
    } else {
      bannerLabel.textContent = 'You owe overall';
      bannerAmount.textContent = `Rs. ${Math.abs(myNet).toFixed(2)}`;
    }
  }

  // ---- Who owes whom ----
  const settlementsList = $('#settlements-list');
  if (settlements.length === 0) {
    settlementsList.innerHTML = '<li class="empty-state">Everyone is settled up! 🎉</li>';
  } else {
    settlementsList.innerHTML = settlements.map(s => `
      <li class="settlement-row">
        ${avatarOrInitials(s.from, userName(s.from), '', 30)}
        <strong>${escapeHtml(userName(s.from))}</strong>
        <span class="settlement-arrow">→</span>
        <strong>${escapeHtml(userName(s.to))}</strong>
        ${avatarOrInitials(s.to, userName(s.to), '', 30)}
        <span class="negative" style="margin-left:auto;">Rs. ${s.amount.toFixed(2)}</span>
      </li>
    `).join('');
  }

  // ---- Net balance per person ----
  const netList = $('#net-list');
  netList.innerHTML = Object.entries(net).map(([uid, amount]) => {
    const cls = amount > 0.01 ? 'positive' : amount < -0.01 ? 'negative' : '';
    const label = amount > 0.01 ? 'is owed' : amount < -0.01 ? 'owes' : 'is settled up';
    return `
      <li class="net-row">
        ${avatarOrInitials(uid, userName(uid), '', 34)}
        <div class="net-row-name">
          ${escapeHtml(userName(uid))}${uid === me?.id ? ' (you)' : ''}
          <div class="net-row-sub">${label}</div>
        </div>
        <span class="${cls}">Rs. ${Math.abs(amount).toFixed(2)}</span>
      </li>
    `;
  }).join('');
}

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

function renderMessage(m) {
  if (m.type === 'call-start') return renderCallSystemMessage(m);

  const mine = m.user_id === me.id;
  const name = m.user_name || userName(m.user_id);
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `
    <div class="chat-msg-row ${mine ? 'mine' : ''}">
      <div class="chat-msg">
        <div class="bubble">
          ${mine ? '' : `<div class="sender" style="color:${colorForName(name)};">${escapeHtml(name)}</div>`}
          ${renderAttachment(m.attachment)}
          ${m.text ? `<span class="msg-text">${escapeHtml(m.text)}</span>` : ''}
          <span class="msg-time">${time}</span>
        </div>
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
  });
  input.value = '';
  clearChatMediaPreview();
});

function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('chat:message', (m) => {
    const box = $('#chat-messages');
    box.insertAdjacentHTML('beforeend', renderMessage(m));
    box.scrollTop = box.scrollHeight;
  });

  socket.on('balances:update', renderBalances);

  socket.on('user:updated', (u) => {
    const idx = users.findIndex(x => x.id === u.id);
    if (idx !== -1) users[idx] = u; else users.push(u);
  });

  socket.on('expense:new', async () => {
    await loadExpenses();
  });

  socket.on('expense:deleted', async () => {
    await loadExpenses();
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
        ${avatarOrInitials(post.user_id, post.user_name, '', 38)}
        <div class="post-card-header-info">
          <div class="post-card-header-name">${escapeHtml(post.user_name)}${isMine ? ' (you)' : ''}</div>
          <div class="post-card-header-time">${timeAgo(post.created_at)}</div>
        </div>
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
