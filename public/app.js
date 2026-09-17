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
        password: $('#signup-password').value,
      }),
    });
    onLoggedIn(data);
  } catch (err) {
    $('#signup-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', () => {
  localStorage.removeItem('gp_token');
  token = null;
  me = null;
  if (socket) socket.disconnect();
  location.reload();
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
  $('#me-name').textContent = me.name;

  await loadUsers();
  await loadExpenses();
  await loadBalances();
  await loadMessages();
  connectSocket();
  setupNotifications();
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
  const box = $('#split-checkboxes');
  box.innerHTML = users.map(u => `
    <label>
      <input type="checkbox" value="${u.id}" checked /> ${escapeHtml(u.name)}
    </label>
  `).join('');
}

function userName(id) {
  const u = users.find(u => u.id === id);
  return u ? u.name : 'Someone';
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

function renderExpenses(expenses) {
  const list = $('#expense-list');
  if (expenses.length === 0) {
    list.innerHTML = '<li class="exp-meta">No expenses yet — add the first one above.</li>';
    return;
  }
  list.innerHTML = expenses.map(e => `
    <li>
      <div>
        <div>${escapeHtml(e.description)}</div>
        <div class="exp-meta">Paid by ${escapeHtml(userName(e.paid_by))} · split ${e.split_among.length} ways · ${new Date(e.created_at).toLocaleString()}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="exp-amount">Rs. ${e.amount.toFixed(2)}</span>
        <button class="del-btn" data-id="${e.id}">Delete</button>
      </div>
    </li>
  `).join('');

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
  const settlementsList = $('#settlements-list');
  if (settlements.length === 0) {
    settlementsList.innerHTML = '<li>Everyone is settled up! 🎉</li>';
  } else {
    settlementsList.innerHTML = settlements.map(s => `
      <li><strong>${escapeHtml(userName(s.from))}</strong> owes <strong>${escapeHtml(userName(s.to))}</strong>
      <span class="negative">Rs. ${s.amount.toFixed(2)}</span></li>
    `).join('');
  }

  const netList = $('#net-list');
  netList.innerHTML = Object.entries(net).map(([uid, amount]) => {
    const cls = amount > 0.01 ? 'positive' : amount < -0.01 ? 'negative' : '';
    const label = amount > 0.01 ? 'is owed' : amount < -0.01 ? 'owes' : 'is settled';
    return `<li>${escapeHtml(userName(uid))} ${label} <span class="${cls}">Rs. ${Math.abs(amount).toFixed(2)}</span></li>`;
  }).join('');
}

// ---------- Chat ----------
async function loadMessages() {
  const data = await api('/api/messages');
  const box = $('#chat-messages');
  box.innerHTML = data.messages.map(renderMessage).join('');
  box.scrollTop = box.scrollHeight;
}

function renderMessage(m) {
  const mine = m.user_id === me.id ? 'mine' : '';
  const name = m.user_name || userName(m.user_id);
  return `
    <div class="chat-msg ${mine}">
      <div class="sender">${escapeHtml(name)} · ${new Date(m.created_at).toLocaleTimeString()}</div>
      <div class="bubble">${escapeHtml(m.text)}</div>
    </div>
  `;
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat:send', text);
  input.value = '';
});

function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('chat:message', (m) => {
    const box = $('#chat-messages');
    box.insertAdjacentHTML('beforeend', renderMessage(m));
    box.scrollTop = box.scrollHeight;
  });

  socket.on('balances:update', renderBalances);

  socket.on('expense:new', async () => {
    await loadExpenses();
  });

  socket.on('expense:deleted', async () => {
    await loadExpenses();
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Init ----------
tryAutoLogin();
