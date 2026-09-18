// ---------- State ----------
let token = localStorage.getItem('gp_token') || null;
let me = null;
let users = [];
let socket = null;
let tasksCache = [];
let notificationsCache = [];
let pollsCache = [];
let onlineUserIds = new Set();
let chatViewerIds = new Set();
let chatReads = {}; // userId -> messageId (their last-read message)
let currentPage = 'feed';
let pageBeforeNotifications = 'feed';
let unreadNotifCount = 0;
let unreadCounts = { feed: 0, chat: 0, home: 0 };
let storiesByUser = {}; // userId -> array of story objects, newest last
let myStories = []; // convenience alias for storiesByUser[me.id]
let storyViewerState = null; // { userId, stories, index, timer }

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- Haptics ----------
// Vibration is only actually supported on Android/Chrome-family browsers
// (iOS Safari has no vibrate API), so this is a "when we can" nicety, not
// something any feature depends on.
const HAPTIC_PATTERNS = {
  light: 8,             // tab switches, opening a popup
  tap: 14,               // sending a message, reacting, liking
  success: [12, 40, 16], // completing a task, casting a poll vote
  pop: [8, 30, 8, 30, 14], // a little extra flourish (double-tap like)
};

function haptic(type = 'light') {
  try {
    if (navigator.vibrate) navigator.vibrate(HAPTIC_PATTERNS[type] || HAPTIC_PATTERNS.light);
  } catch {}
}

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
// "Sub-pages" are reached from the header (notifications) or a bottom-nav
// avatar (profile) rather than a .page-btn tab, so they're not part of the
// 4-tab bottom bar but still use the same show/hide machinery.
const SUB_PAGES = new Set(['notifications', 'profile', 'compose']);

function switchToPage(page) {
  const wasChatPage = currentPage === 'chat';
  if (!SUB_PAGES.has(page)) {
    // Only remember a "real" tab as the place to return to from a sub-page.
    pageBeforeNotifications = page;
  }
  $$('.page-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  $('#nav-profile-btn')?.classList.toggle('active', page === 'profile');
  $('#nav-add-btn')?.classList.toggle('active', page === 'compose');
  currentPage = page;
  haptic('light');

  if (page === 'notifications' && me) {
    // Notifications are marked "seen" server-side the moment they're
    // fetched, so re-fetch each time someone actually opens this screen.
    loadNotifications().catch(() => {});
    unreadNotifCount = 0;
    setHeaderNotifBadge(0);
  }
  if (page === 'profile' && me) populateProfilePage();
  clearTabBadge(page);

  // Let roommates see who's actually looking at the chat right now.
  if (page === 'chat' && !wasChatPage) {
    // Compute the scroll position from the read state as it stood before
    // this visit, then mark everything read.
    scrollChatToRelevantPosition();
    socket?.emit('chat:enter');
    markLatestMessageRead();
    initChatCat();
  } else if (wasChatPage && page !== 'chat') {
    socket?.emit('chat:leave-view');
  }
}

$$('.page-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchToPage(btn.dataset.page));
});

// Header bell — Instagram-style Activity screen: its own page, reachable
// from any tab, with a badge for unseen notifications.
$('#header-notif-btn')?.addEventListener('click', () => switchToPage('notifications'));
$('#notifications-back-btn')?.addEventListener('click', () => switchToPage(pageBeforeNotifications || 'feed'));

// Bottom-nav profile avatar — opens the profile as a full page instead of a
// modal, so there's never an awkward "how do I close this" moment.
$('#nav-profile-btn')?.addEventListener('click', () => switchToPage('profile'));

function setTabBadge(tab, count) {
  const badge = $(`#badge-${tab}`);
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function clearTabBadge(tab) {
  unreadCounts[tab] = 0;
  setTabBadge(tab, 0);
}

function bumpTabBadge(tab) {
  if (currentPage === tab) return; // already looking at it — no need to badge it
  unreadCounts[tab] = (unreadCounts[tab] || 0) + 1;
  setTabBadge(tab, unreadCounts[tab]);
}

// ---------- App startup ----------
async function startApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  renderProfileButton();
  renderHomeGreeting();
  renderEventBanner();
  renderEventDancer();
  syncHeaderHeight();

  await loadUsers();
  await loadMessages();
  await loadFeed();
  await loadTasks();
  await loadNotifications();
  await loadPolls();
  await loadStories();
  connectSocket();
  setupNotifications();
  maybeAutoJoinCall();
  setupChatMediaInput();
  setupPostMediaInput();
  setupProfileModal();
  setupPollModal();
  setupTypingIndicator();
  setupMembersPopup();
  setupStoriesRow();
  setupStoryViewer();
}

// ---------- Keep the chat page's height in sync with the real header ----------
// The topbar can grow taller than its normal size while the wedding dancers
// (and their speech bubble) are showing, so the chat page's height can't be
// a hardcoded number — measure the actual header + tabbar height instead.
function syncHeaderHeight() {
  const topbar = document.querySelector('.topbar');
  const tabbar = document.querySelector('.tabbar');
  if (!topbar || !tabbar) return;
  const h = topbar.getBoundingClientRect().height + tabbar.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--header-tabbar-h', `${Math.round(h)}px`);
}
window.addEventListener('resize', syncHeaderHeight);
window.addEventListener('load', syncHeaderHeight);

// ---------- Chat kitten (a tiny wandering orange cat, purely for fun) ----------
let catTimer = null;
let catX = 8;
let catY = 60;
const CAT_STATES = ['cat-walking', 'cat-sit', 'cat-sleep', 'cat-clean', 'cat-meow', 'cat-dance', 'cat-play'];

function setCatState(state) {
  const cat = $('#chat-cat');
  if (!cat) return;
  CAT_STATES.forEach((s) => cat.classList.remove(s));
  cat.classList.add(state);
}

function moveCatTo(x, y) {
  const cat = $('#chat-cat');
  if (!cat) return;
  cat.style.setProperty('--cat-x', `${x}px`);
  cat.style.setProperty('--cat-y', `${y}px`);
}

// The cat should roam anywhere over the message area itself — not just a
// strip above the composer — but never overlap the sticky chat header up
// top or the composer down below. Measure those live so it always works,
// however tall the header happens to be (e.g. with the wedding dancers
// showing) or however many messages are on screen.
function getCatBounds() {
  const card = $('#chat-cat')?.closest('.chat-card');
  const header = $('.chat-header');
  const form = $('#chat-form');
  const fallback = { minX: 8, maxX: 220, minY: 60, maxY: 300 };
  if (!card || !header || !form) return fallback;
  const cardRect = card.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const formRect = form.getBoundingClientRect();
  const minX = 6;
  const maxX = Math.max(minX, cardRect.width - 50);
  // Extra headroom below the chat header so the cat's floating speech/zzz
  // bubble (which sits above its own box) never pokes into the header text.
  const minY = Math.max(8, headerRect.bottom - cardRect.top + 34);
  const maxY = Math.max(minY + 10, formRect.top - cardRect.top - 40);
  return { minX, maxX, minY, maxY };
}

function scheduleNextCatBehavior() {
  clearTimeout(catTimer);
  const cat = $('#chat-cat');
  if (!cat || catPlayingWithTyping) return;

  // Weighted so it walks around most of the time, with occasional rest stops.
  const choices = ['walk', 'walk', 'walk', 'sit', 'sleep', 'clean'];
  const next = choices[Math.floor(Math.random() * choices.length)];

  if (next === 'walk') {
    const { minX, maxX, minY, maxY } = getCatBounds();
    const targetX = Math.round(minX + Math.random() * (maxX - minX));
    const targetY = Math.round(minY + Math.random() * (maxY - minY));
    cat.classList.toggle('facing-left', targetX < catX);
    catX = targetX;
    catY = targetY;
    setCatState('cat-walking');
    moveCatTo(targetX, targetY);
    catTimer = setTimeout(scheduleNextCatBehavior, 2600 + Math.random() * 2200);
  } else if (next === 'sit') {
    setCatState('cat-sit');
    catTimer = setTimeout(scheduleNextCatBehavior, 2200 + Math.random() * 1800);
  } else if (next === 'sleep') {
    setCatState('cat-sleep');
    catTimer = setTimeout(scheduleNextCatBehavior, 7000 + Math.random() * 5000);
  } else if (next === 'clean') {
    setCatState('cat-clean');
    catTimer = setTimeout(scheduleNextCatBehavior, 2800 + Math.random() * 1600);
  }
}

function initChatCat() {
  if (initChatCat._started) return;
  initChatCat._started = true;
  // Give layout a moment to settle (header height, message list, etc.)
  // before measuring bounds for the cat's starting spot.
  setTimeout(() => {
    const { minX, maxX, minY, maxY } = getCatBounds();
    catX = Math.round(minX + Math.random() * (maxX - minX));
    catY = Math.round(minY + Math.random() * (maxY - minY));
    moveCatTo(catX, catY);
    scheduleNextCatBehavior();
  }, 300);
}

// Give the kitten a little reaction whenever a chat message comes in —
// meowing at it or breaking into a quick dance — then back to normal.
function catReactToMessage() {
  const cat = $('#chat-cat');
  if (!cat || !initChatCat._started || catPlayingWithTyping) return;
  clearTimeout(catTimer);
  const reaction = Math.random() < 0.5 ? 'cat-meow' : 'cat-dance';
  setCatState(reaction);
  catTimer = setTimeout(scheduleNextCatBehavior, 1700);
}

// Whenever someone starts typing, the kitten drops whatever it's doing,
// trots straight over to the typing indicator's little dots, and bats at
// them like it's the most exciting toy in the room — until they stop.
let catPlayingWithTyping = false;
function catGoPlayWithTyping() {
  const cat = $('#chat-cat');
  const indicator = $('#typing-indicator');
  const card = cat?.closest('.chat-card');
  if (!cat || !indicator || !card || !initChatCat._started) return;

  catPlayingWithTyping = true;
  clearTimeout(catTimer);

  const cardRect = card.getBoundingClientRect();
  const indRect = indicator.getBoundingClientRect();
  if (!indRect.width || !indRect.height) { catPlayingWithTyping = false; return; }

  // Aim just beside the typing bubble's dots, roughly level with them.
  const targetX = Math.max(6, indRect.left - cardRect.left - 30);
  const targetY = Math.max(6, indRect.top - cardRect.top + (indRect.height / 2) - 10);
  cat.classList.toggle('facing-left', targetX < catX);
  catX = targetX;
  catY = targetY;
  setCatState('cat-walking');
  moveCatTo(targetX, targetY);

  // Give it time to actually run over before it starts pawing at the dots.
  clearTimeout(catTimer);
  catTimer = setTimeout(() => {
    if (!catPlayingWithTyping) return;
    setCatState('cat-play');
  }, 750);
}

function catStopPlayingWithTyping() {
  if (!catPlayingWithTyping) return;
  catPlayingWithTyping = false;
  clearTimeout(catTimer);
  scheduleNextCatBehavior();
}

// ---------- Home greeting (a little personal touch each time you open the app) ----------
function renderHomeGreeting() {
  const lineEl = $('#home-greeting-line');
  const dateEl = $('#home-greeting-date');
  if (!lineEl || !me) return;
  const hour = new Date().getHours();
  const salutation = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : hour < 21 ? 'Good evening' : 'Good night';
  const firstName = me.name.trim().split(/\s+/)[0];
  lineEl.textContent = `${salutation}, ${firstName} 👋`;
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }
}

// ---------- Time-limited "Baraat" theme (Ateeb Saeed's wedding, Nov 1–3) ----------
// The palette/background pattern itself is pure CSS gated on the
// data-event-theme attribute (set in index.html's head, so there's no
// flash). This just handles the two dynamic bits: the falling petals and
// the Home banner text, which both need to know today's date.
const BARAAT_START = new Date('2026-11-01T00:00:00');
const BARAAT_END = new Date('2026-11-03T23:59:59');

function isEventThemeActive() {
  return document.documentElement.getAttribute('data-event-theme') === 'baraat';
}

function renderEventDancer() {
  const dancer = $('#event-dancer');
  const bubble = $('#event-speech-bubble');
  if (!dancer) return;
  if (!isEventThemeActive()) { dancer.classList.add('hidden'); return; }

  const now = new Date();
  let text;
  if (now < BARAAT_START) {
    text = `Shadi soon! 💍`;
  } else if (now <= BARAAT_END) {
    text = `Mubarak! 🎊`;
  } else {
    text = `Mubarak ho! 💐`;
  }
  if (bubble) bubble.textContent = text;
  dancer.classList.remove('hidden');
  startDancerRoaming();
}

// The couple runs, plays and dances freely across their little stage in the
// header, instead of standing still in one spot. Each figure has its own
// independent loop: run to a random point on the stage (faster legs, like
// actually running), then settle there and do the normal bhangra bounce for
// a bit, then pick a new spot — so they never move in perfect lockstep and
// occasionally end up dancing right next to each other.
let dancerRoamStarted = false;
function roamFigure(figureId) {
  const fig = document.getElementById(figureId);
  const stage = $('#event-stage');
  if (!fig || !stage || !isEventThemeActive()) return;

  const stageW = stage.clientWidth || 68;
  const figW = fig.offsetWidth || 30;
  const maxX = Math.max(4, stageW - figW - 4);
  const targetX = Math.round(Math.random() * maxX);
  const currentX = parseFloat(fig.style.getPropertyValue('--dx')) || 0;
  fig.classList.toggle('facing-left', targetX < currentX);
  fig.classList.add('dancer-running');
  fig.style.setProperty('--dx', `${targetX}px`);

  const runTime = 1100 + Math.random() * 900;
  setTimeout(() => {
    fig.classList.remove('dancer-running');
    const danceTime = 1600 + Math.random() * 2200;
    setTimeout(() => roamFigure(figureId), danceTime);
  }, runTime);
}

function startDancerRoaming() {
  if (dancerRoamStarted) return;
  dancerRoamStarted = true;
  roamFigure('dancer-figure-boy');
}

function renderEventBanner() {
  const banner = $('#event-banner');
  if (!banner) return;
  if (!isEventThemeActive()) { banner.classList.add('hidden'); return; }

  const now = new Date();
  let text;
  if (now < BARAAT_START) {
    const daysLeft = Math.ceil((BARAAT_START - now) / 86400000);
    text = `💍 ${daysLeft} day${daysLeft === 1 ? '' : 's'} until Ateeb Saeed's Baraat! 🎉`;
  } else if (now <= BARAAT_END) {
    text = `🎊 Baraat Mubarak! Celebrating Ateeb Saeed's wedding — mubarak ho! 💐`;
  } else {
    text = `💍 Wishing Ateeb Saeed a beautiful married life ahead! 🎉`;
  }
  banner.textContent = text;
  banner.classList.remove('hidden');
}

// ---------- Members popup (tap the logo/name in the header) ----------
function memberRowHtml(u) {
  const online = onlineUserIds.has(u.id);
  const inChat = chatViewerIds.has(u.id);
  const statusText = inChat ? '💬 In the chat right now' : (online ? 'Online' : 'Offline');
  return `
    <li class="member-row" data-action="view-profile" data-user-id="${u.id}">
      <span class="avatar-presence-wrap">
        ${avatarOrInitials(u.id, u.name, '', 44)}
        <span class="presence-dot ${online ? 'online' : ''}"></span>
      </span>
      <div class="member-row-info">
        <div class="member-row-name">${escapeHtml(u.name)}${u.id === me?.id ? ' (you)' : ''}</div>
        <div class="member-row-status ${inChat ? 'in-chat' : ''}">${statusText}</div>
      </div>
    </li>
  `;
}

function renderMembersList() {
  const list = $('#members-list');
  if (!list) return;
  const sorted = [...users].sort((a, b) => {
    const aOnline = onlineUserIds.has(a.id) ? 0 : 1;
    const bOnline = onlineUserIds.has(b.id) ? 0 : 1;
    return aOnline - bOnline || a.name.localeCompare(b.name);
  });
  list.innerHTML = sorted.length
    ? sorted.map(memberRowHtml).join('')
    : '<li class="empty-state">No roommates yet.</li>';
}

function setupMembersPopup() {
  const btn = $('#brand-logo-btn');
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      haptic('light');
      renderMembersList();
      openModal('members-modal');
    });
  }

  const list = $('#members-list');
  if (list && !list.dataset.wired) {
    list.dataset.wired = '1';
    // Opening someone's profile from here should close this popup first,
    // so the two modals don't stack on top of each other.
    list.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="view-profile"]')) closeModal('members-modal');
    });
  }
}

function renderProfileButton() {
  const navBtn = $('#nav-profile-btn');
  if (navBtn && me) {
    navBtn.innerHTML = avatarOrInitials(me.id, me.name, '', 26);
    navBtn.title = me.name;
  }
}

// ---------- Profile page (view/edit profile, avatar, dark mode, password) ----------
function applyDarkModePreference() {
  const saved = localStorage.getItem('gp_theme');
  const isDark = saved === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  const toggle = $('#dark-mode-toggle');
  if (toggle) toggle.checked = isDark;
}

// Fills the profile page's fields with the current user's data — called
// every time the page is navigated to, same as any other tab's refresh.
function populateProfilePage() {
  if (!me) return;
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
  $('#profile-edit-panel')?.classList.add('hidden');
  const toggleBtn = $('#profile-edit-toggle-btn');
  if (toggleBtn) toggleBtn.textContent = 'Edit profile';

  $('#profile-display-name').textContent = me.name;
  $('#profile-bio-line').textContent = me.email || 'Gujjar Penthouse roommate';

  const myPosts = posts.filter((p) => p.user_id === me.id);
  const myTasks = tasksCache.filter((t) => t.assignedTo && t.assignedTo.id === me.id);
  $('#profile-stat-posts').textContent = myPosts.length;
  $('#profile-stat-tasks').textContent = myTasks.length;
  $('#profile-stat-done').textContent = myTasks.filter((t) => t.done).length;

  const gridWrap = $('#profile-posts-grid-wrap');
  if (gridWrap) {
    gridWrap.innerHTML = myPosts.length
      ? `<div class="profile-posts-grid">${myPosts.map((p) => `
          <div class="profile-post-tile">
            ${p.media
              ? (p.media.kind === 'video'
                  ? `<video src="${p.media.url}" muted></video>`
                  : `<img src="${p.media.url}" alt="" />`)
              : `<div class="profile-post-tile-text">${escapeHtml(p.caption || '').slice(0, 120)}</div>`}
            <div class="profile-post-tile-overlay">❤️ ${p.likes.length} · 💬 ${p.comments.length}</div>
          </div>
        `).join('')}</div>`
      : '<p class="empty-state">No posts yet — tap + to share your first one! 🎉</p>';
  }
}

function setupProfileModal() {
  const editToggleBtn = $('#profile-edit-toggle-btn');
  if (editToggleBtn && !editToggleBtn.dataset.wired) {
    editToggleBtn.dataset.wired = '1';
    editToggleBtn.addEventListener('click', () => {
      const panel = $('#profile-edit-panel');
      const nowHidden = !panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      editToggleBtn.textContent = nowHidden ? 'Edit profile' : 'Done';
      if (!nowHidden) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  const shareBtn = $('#profile-share-btn');
  if (shareBtn && !shareBtn.dataset.wired) {
    shareBtn.dataset.wired = '1';
    shareBtn.addEventListener('click', async () => {
      const text = `${me.name} on Gujjar Penthouse`;
      try {
        if (navigator.share) {
          await navigator.share({ title: text, text });
        } else {
          await navigator.clipboard.writeText(text);
        }
        const original = shareBtn.textContent;
        shareBtn.textContent = navigator.share ? 'Shared!' : 'Copied!';
        setTimeout(() => { shareBtn.textContent = original; }, 1500);
      } catch {
        // User cancelled the native share sheet — nothing to do.
      }
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
  switchToPage('chat');
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
  renderStoriesRow();
}

function userName(id) {
  const u = users.find(u => u.id === id);
  return u ? u.name : 'Someone';
}

// ---------- Icons (thin-stroke, Instagram-style line icons; a couple of
// filled variants for "active" states) ----------
const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V20a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1V9.5"/></svg>',
  homeActive: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.6 2.2 10.8a1 1 0 0 0 .64 1.77H4.5V20a2 2 0 0 0 2 2H9a1 1 0 0 0 1-1v-5.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V21a1 1 0 0 0 1 1h2.5a2 2 0 0 0 2-2v-7.43h1.66a1 1 0 0 0 .64-1.77z"/></svg>',
  explore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/></svg>',
  exploreActive: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/></svg>',
  plusSquare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m2.5 3.5 18.5 8-7.7 3-3 7.7-7.8-18.7Z"/></svg>',
  chatActive: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="m2.5 3.5 18.5 8-7.7 3-3 7.7-7.8-18.7Z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7.6-4.6-10.2-9.3C.2 8.7 1.6 5 5.2 4.2c2.1-.5 4.1.4 5.3 2.1l1.5 2 1.5-2c1.2-1.7 3.2-2.6 5.3-2.1 3.6.8 5 4.5 3.4 7.5C19.6 16.4 12 21 12 21Z"/></svg>',
  heartActive: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 21s-7.6-4.6-10.2-9.3C.2 8.7 1.6 5 5.2 4.2c2.1-.5 4.1.4 5.3 2.1l1.5 2 1.5-2c1.2-1.7 3.2-2.6 5.3-2.1 3.6.8 5 4.5 3.4 7.5C19.6 16.4 12 21 12 21Z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.8 8.4c-1.4 0-2.7-.3-3.9-.9L3 20l1.1-4.7A8.3 8.3 0 0 1 3 11.5 8.4 8.4 0 0 1 11.8 3a8.4 8.4 0 0 1 9.2 8.5Z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h2.6l1.2-2h8.4l1.2 2H20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="14" r="3.4"/></svg>',
};

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
      haptic('success');
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

  const checkbox = e.target.closest('[data-action="toggle-task"]');
  if (checkbox) {
    const aboutToComplete = !checkbox.classList.contains('checked');
    if (aboutToComplete) { spawnConfetti(checkbox); haptic('success'); } else { haptic('light'); }
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

// ---------- In-app notifications feed (Instagram-style Activity screen) ----------
// Each notification type gets its own colored icon bubble, standing in for
// the "who did this" avatar Instagram would show (our notifications don't
// carry a specific actor), so the feed still reads as a scannable pile
// rather than a flat list.
function notificationIcon(type) {
  if (type === 'task') return ICONS.plusSquare;
  if (type === 'poll') return ICONS.explore;
  if (type === 'like') return ICONS.heartActive;
  if (type === 'comment') return ICONS.comment;
  if (type === 'post') return ICONS.camera;
  return ICONS.plusSquare;
}

function renderNotifications(list) {
  const box = $('#notifications-page-list');
  if (!box) return;
  box.innerHTML = list.length === 0
    ? '<li class="empty-state">No notifications yet.</li>'
    : list.map(n => `
      <li class="notification-row notification-row-${n.type} ${n.read ? '' : 'unread'}">
        <span class="notification-icon">${notificationIcon(n.type)}</span>
        <div class="notification-row-main">
          <div class="notification-text">${escapeHtml(n.text)}</div>
          <div class="notification-time">${timeAgo(n.createdAt)}</div>
        </div>
        ${n.read ? '' : '<span class="notification-dot"></span>'}
      </li>
    `).join('');
}

// Small numbered badge on the header bell — capped at 9+, like a typical
// Instagram-style activity indicator.
function setHeaderNotifBadge(count) {
  const badge = $('#header-notif-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
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
    // Viewing yourself opens the same editable page as the bottom-nav
    // avatar — editing only ever applies to your own profile.
    switchToPage('profile');
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
  chatReads = {};
  for (const [userId, r] of Object.entries(data.reads || {})) chatReads[userId] = r.messageId;
  renderSeenReceipts();
  scrollChatToRelevantPosition();
}

// Opens the chat where a person would actually want it: right at their
// first unread message (like WhatsApp/Messenger), or at the very latest
// message if they're already caught up or have no read history yet. Called
// on load and again whenever the chat tab is actually opened, since the
// page may have been hidden (display:none) the first time and unable to
// compute a real scroll position.
function scrollChatToRelevantPosition() {
  const box = $('#chat-messages');
  if (!box) return;
  $('.chat-unread-divider')?.remove();
  const rows = [...$$('.chat-msg-row[data-message-id]')];
  if (!rows.length) return;
  const lastReadId = me && chatReads[me.id];
  // No read receipt at all means this person has never opened chat before —
  // everything is unread, so the first unread message is the very first one.
  // A read receipt that no longer matches any row (e.g. it was the very
  // last message and nothing new has arrived) means they're caught up.
  let firstUnreadIdx = 0;
  if (lastReadId) {
    const idx = rows.findIndex((r) => r.dataset.messageId === lastReadId);
    firstUnreadIdx = idx === -1 ? 0 : idx + 1;
  }
  if (firstUnreadIdx < rows.length) {
    const firstUnread = rows[firstUnreadIdx];
    firstUnread.insertAdjacentHTML('beforebegin', '<div class="chat-unread-divider"><span>New messages</span></div>');
    // Scroll the divider itself into view (rather than the message after it)
    // so the "New messages" label is actually visible, not scrolled past.
    $('.chat-unread-divider')?.scrollIntoView({ block: 'start' });
    return;
  }
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

// ---------- Chat message reactions (tap the ❤️/😂/👍 row that pops up) ----------
const QUICK_REACTIONS = ['❤️', '😂', '👍', '😮', '😢', '🙏'];

function reactionsBarHtml(reactions) {
  if (!reactions || Object.keys(reactions).length === 0) return '';
  const chips = Object.entries(reactions)
    .filter(([, userIds]) => userIds.length > 0)
    .map(([emoji, userIds]) => `
      <button type="button" class="msg-reaction-chip ${userIds.includes(me.id) ? 'mine' : ''}" data-action="toggle-reaction" data-emoji="${emoji}">
        ${emoji} <span class="msg-reaction-count">${userIds.length}</span>
      </button>
    `).join('');
  return chips ? `<div class="msg-reactions">${chips}</div>` : '';
}

function closeReactPicker() {
  document.querySelector('.react-picker-popup')?.remove();
}

function openReactPicker(row) {
  closeReactPicker();
  if (!row) return;
  const messageId = row.dataset.messageId;
  const popup = document.createElement('div');
  popup.className = 'react-picker-popup';
  popup.innerHTML = QUICK_REACTIONS.map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
  popup.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn && socket) { haptic('pop'); socket.emit('chat:react', { messageId, emoji: btn.dataset.emoji }); }
    closeReactPicker();
  });
  // Fixed-position + clamped so it never gets stuck under the sticky chat
  // header for messages near the top of the scroll area.
  document.body.appendChild(popup);
  const bubbleRect = row.querySelector('.bubble').getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  const headerBottom = document.querySelector('.chat-header')?.getBoundingClientRect().bottom || 0;
  let top = bubbleRect.top - popupRect.height - 8;
  if (top < headerBottom + 4) top = bubbleRect.bottom + 8; // not enough room above — show below instead
  let left = bubbleRect.left + bubbleRect.width / 2 - popupRect.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - popupRect.width - 6));
  popup.style.position = 'fixed';
  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;

  setTimeout(() => {
    document.addEventListener('click', function onOutside(e) {
      if (!popup.contains(e.target) && !e.target.closest('[data-action="open-react-picker"]')) {
        closeReactPicker();
        document.removeEventListener('click', onOutside);
      }
    });
  }, 0);
}

function updateMessageReactionsInDom(messageId, reactions) {
  const row = document.querySelector(`.chat-msg-row[data-message-id="${messageId}"]`);
  if (!row) return;
  const bubble = row.querySelector('.bubble');
  if (!bubble) return;
  const existing = bubble.querySelector('.msg-reactions');
  const html = reactionsBarHtml(reactions);
  if (existing) existing.remove();
  if (html) bubble.insertAdjacentHTML('beforeend', html);
}

// ---------- Chat read receipts ("seen by", Instagram DM style) ----------
// Rather than marking every single message read/unread, we track only the
// last message each person has read, and show a tiny avatar under that exact
// message row — the same "Seen" pattern Instagram/iMessage DMs use.
function markLatestMessageRead() {
  const rows = $$('.chat-msg-row[data-message-id]');
  if (!rows.length || !socket) return;
  const lastId = rows[rows.length - 1].dataset.messageId;
  socket.emit('chat:mark-read', { messageId: lastId });
}

function renderSeenReceipts() {
  document.querySelectorAll('.msg-seen-row').forEach(el => el.remove());
  const rowsInOrder = [...$$('.chat-msg-row[data-message-id]')];
  const indexOf = new Map(rowsInOrder.map((row, i) => [row.dataset.messageId, i]));

  // Group readers by the row they've each read up to, then only draw the
  // marker on the single most-recent row for each reader.
  for (const [userId, messageId] of Object.entries(chatReads)) {
    if (userId === me?.id) continue;
    if (!indexOf.has(messageId)) continue;
    const row = rowsInOrder[indexOf.get(messageId)];
    const msgCol = row.querySelector('.chat-msg');
    if (!msgCol) continue;
    let seenRow = msgCol.querySelector('.msg-seen-row');
    if (!seenRow) {
      seenRow = document.createElement('div');
      seenRow.className = 'msg-seen-row';
      msgCol.appendChild(seenRow);
    }
    if (seenRow.querySelector(`[data-seen-user="${userId}"]`)) continue;
    seenRow.insertAdjacentHTML('beforeend', `<span data-seen-user="${userId}" title="Seen by ${escapeHtml(userName(userId))}">${avatarOrInitials(userId, userName(userId), 'seen-avatar', 15)}</span>`);
  }
}

// ---------- Who's currently on the Chat tab ----------
function renderChatViewers() {
  const row = $('#chat-viewers-row');
  if (!row) return;
  const others = [...chatViewerIds].filter(id => id !== me?.id);
  if (others.length === 0) {
    row.classList.add('hidden');
    return;
  }
  row.innerHTML = others.slice(0, 5).map(id => avatarOrInitials(id, userName(id), 'chat-viewer-avatar', 20)).join('');
  row.title = `${others.map(userName).join(', ')} ${others.length === 1 ? 'is' : 'are'} viewing this chat`;
  row.classList.remove('hidden');
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
          ${reactionsBarHtml(m.reactions)}
        </div>
        <button type="button" class="msg-react-hint" data-action="open-react-picker" title="React">🙂</button>
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
      return;
    }

    const reactHint = e.target.closest('[data-action="open-react-picker"]');
    if (reactHint) {
      openReactPicker(reactHint.closest('.chat-msg-row'));
      return;
    }

    const reactionChip = e.target.closest('[data-action="toggle-reaction"]');
    if (reactionChip) {
      const row = reactionChip.closest('.chat-msg-row');
      if (row && socket) socket.emit('chat:react', { messageId: row.dataset.messageId, emoji: reactionChip.dataset.emoji });
      return;
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
    catStopPlayingWithTyping();
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
  catGoPlayWithTyping();
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

  haptic('tap');
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
    renderSeenReceipts();
    catReactToMessage();
    if (m.user_id !== me?.id) {
      bumpTabBadge('chat');
      if (currentPage === 'chat') { haptic('light'); markLatestMessageRead(); }
    }
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

  // ---------- Presence (online/offline) ----------
  socket.on('presence:snapshot', ({ onlineUserIds: ids }) => {
    onlineUserIds = new Set(ids);
    renderMembersList();
    renderStoriesRow();
  });

  socket.on('presence:update', ({ userId, online }) => {
    if (online) onlineUserIds.add(userId); else onlineUserIds.delete(userId);
    renderMembersList();
    renderStoriesRow();
  });

  // ---------- Chat message reactions ----------
  socket.on('chat:reaction-update', ({ messageId, reactions }) => {
    updateMessageReactionsInDom(messageId, reactions);
  });

  // ---------- Who's viewing the chat right now ----------
  socket.on('chat:viewers-update', (viewers) => {
    chatViewerIds = new Set(viewers.map(v => v.id));
    renderChatViewers();
    renderMembersList();
  });

  // ---------- Read receipts ----------
  socket.on('chat:read-update', ({ userId, messageId }) => {
    chatReads[userId] = messageId;
    renderSeenReceipts();
  });

  // ---------- Notifications ----------
  socket.on('notification:new', ({ userId, notification }) => {
    if (userId !== me?.id) return;
    notificationsCache.unshift(notification);
    renderNotifications(notificationsCache);
    if (currentPage !== 'notifications') {
      unreadNotifCount += 1;
      setHeaderNotifBadge(unreadNotifCount);
    }
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
    if (post.user_id !== me?.id) bumpTabBadge('feed');
  });

  socket.on('story:new', (story) => {
    if (!storiesByUser[story.user_id]) storiesByUser[story.user_id] = [];
    if (storiesByUser[story.user_id].find((s) => s.id === story.id)) return;
    storiesByUser[story.user_id].push(story);
    renderStoriesRow();
  });

  socket.on('story:viewed', ({ id, viewers }) => {
    for (const list of Object.values(storiesByUser)) {
      const story = list.find((s) => s.id === id);
      if (story) { story.viewers = viewers; break; }
    }
    renderStoriesRow();
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
      btn.innerHTML = likedByMe ? ICONS.heartActive : ICONS.heart;
    }
    let likesEl = card.querySelector('.post-card-likes');
    if (likes.length === 0) {
      likesEl?.remove();
    } else {
      const label = `${likes.length} like${likes.length === 1 ? '' : 's'}`;
      if (likesEl) {
        likesEl.textContent = label;
      } else {
        likesEl = document.createElement('div');
        likesEl.className = 'post-card-likes';
        likesEl.textContent = label;
        card.querySelector('.post-card-actions').insertAdjacentElement('afterend', likesEl);
      }
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
    switchToPage('feed');
  } catch (err) {
    $('#post-error').textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

$('#nav-add-btn')?.addEventListener('click', () => {
  switchToPage('compose');
  requestAnimationFrame(() => $('#post-caption')?.focus());
});

$('#compose-back-btn')?.addEventListener('click', () => {
  switchToPage(pageBeforeNotifications || 'feed');
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

// Instagram-style "stories" row at the top of the Feed. "Your story" on the
// left opens the story viewer if you have an active story, or the upload
// picker if you don't. Everyone else gets a gradient ring when they have an
// unseen story, a muted ring when their story's already been seen, and a
// plain ring (tapping through to their profile) when they have none.
function renderStoriesRow() {
  const row = $('#stories-row');
  if (!row || !me) return;
  myStories = storiesByUser[me.id] || [];
  const others = users.filter((u) => u.id !== me.id);
  const myRing = avatarOrInitials(me.id, me.name, '', 58);
  const itemsHtml = others.map((u) => {
    const stories = storiesByUser[u.id] || [];
    const hasStory = stories.length > 0;
    const hasUnseen = stories.some((s) => !(s.viewers || []).includes(me.id));
    const ringClass = hasStory
      ? (hasUnseen ? 'story-ring-active' : 'story-ring-seen')
      : (onlineUserIds.has(u.id) ? 'story-ring-online' : '');
    return `
    <div class="story-item" data-user-id="${u.id}" ${hasStory ? 'data-has-story="1"' : 'data-action="view-profile"'}>
      <span class="story-ring ${ringClass}">${avatarOrInitials(u.id, u.name, '', 58)}</span>
      <span class="story-name">${escapeHtml(u.name.split(' ')[0])}</span>
    </div>
  `;
  }).join('');
  row.innerHTML = `
    <div class="story-item" id="story-item-you" title="${myStories.length ? 'View your story' : 'Share a story'}">
      <span class="story-ring story-ring-you ${myStories.length ? 'story-ring-active' : ''}">${myRing}${myStories.length ? '' : '<span class="story-add-badge">+</span>'}</span>
      <span class="story-name">Your story</span>
    </div>
    ${itemsHtml}
  `;
}

async function loadStories() {
  try {
    const data = await api('/api/stories');
    storiesByUser = {};
    for (const s of data.stories || []) {
      if (!storiesByUser[s.user_id]) storiesByUser[s.user_id] = [];
      storiesByUser[s.user_id].push(s);
    }
    myStories = me ? (storiesByUser[me.id] || []) : [];
    renderStoriesRow();
  } catch {
    // Non-fatal — the stories row just won't show any active stories.
  }
}

// Navigates to the compose page and focuses it — used anywhere that should
// drop the user straight into writing a post.
function focusComposer() {
  switchToPage('compose');
  requestAnimationFrame(() => $('#post-caption')?.focus());
}

function setupStoriesRow() {
  const row = $('#stories-row');
  if (!row || row.dataset.wired) return;
  row.dataset.wired = '1';
  row.addEventListener('click', (e) => {
    const youItem = e.target.closest('#story-item-you');
    if (youItem) {
      if (myStories.length) openStoryViewer(me.id);
      else $('#story-media-input')?.click();
      return;
    }
    const storyItem = e.target.closest('.story-item[data-has-story="1"]');
    if (storyItem) {
      e.stopPropagation();
      openStoryViewer(storyItem.dataset.userId);
    }
  });
  $('#story-media-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const uploaded = await uploadFile(file);
      await api('/api/stories', { method: 'POST', body: JSON.stringify({ media: { url: uploaded.url, kind: uploaded.kind === 'video' ? 'video' : 'image' } }) });
      await loadStories();
      openStoryViewer(me.id);
    } catch (err) {
      alert(err.message || 'Could not upload that story.');
    }
  });
}

// ---------- Story viewer (full-screen, Instagram-style) ----------
const STORY_IMAGE_DURATION_MS = 5000;

// Order of userIds that currently have at least one story, in the same
// order they appear in the stories row (you first), so tapping "next" past
// the end of one person's stories moves on to the next person's.
function storyUserOrder() {
  const order = [];
  if (myStories.length) order.push(me.id);
  users.filter((u) => u.id !== me.id).forEach((u) => {
    if ((storiesByUser[u.id] || []).length) order.push(u.id);
  });
  return order;
}

function openStoryViewer(userId) {
  const stories = userId === me.id ? myStories : (storiesByUser[userId] || []);
  if (!stories.length) return;
  const firstUnseenIdx = stories.findIndex((s) => !(s.viewers || []).includes(me.id));
  clearTimeout(storyViewerState?.timer);
  storyViewerState = { userId, stories, index: firstUnseenIdx !== -1 ? firstUnseenIdx : 0 };
  $('#story-viewer')?.classList.remove('hidden');
  document.body.classList.add('story-viewer-open');
  showStoryFrame();
}

function closeStoryViewer() {
  clearTimeout(storyViewerState?.timer);
  storyViewerState = null;
  $('#story-viewer')?.classList.add('hidden');
  document.body.classList.remove('story-viewer-open');
  const media = $('#story-viewer-media');
  if (media) media.innerHTML = '';
}

function showStoryFrame() {
  if (!storyViewerState) return;
  const { stories, index, userId } = storyViewerState;
  const story = stories[index];
  if (!story) return closeStoryViewer();

  const user = users.find((u) => u.id === userId) || me;
  $('#story-viewer-avatar').innerHTML = avatarOrInitials(user.id, user.name, '', 30);
  $('#story-viewer-name').textContent = userId === me.id ? 'Your story' : user.name;
  $('#story-viewer-time').textContent = timeAgo(story.createdAt || story.created_at);

  const barsWrap = $('#story-viewer-bars');
  if (barsWrap) {
    barsWrap.innerHTML = stories.map((_, i) => `
      <span class="story-bar ${i < index ? 'story-bar-done' : ''}"><i class="${i === index ? 'story-bar-fill' : ''}"></i></span>
    `).join('');
  }

  const mediaWrap = $('#story-viewer-media');
  if (mediaWrap) {
    mediaWrap.innerHTML = story.media
      ? (story.media.kind === 'video'
          ? `<video src="${story.media.url}" autoplay playsinline></video>`
          : `<img src="${story.media.url}" alt="" />`)
      : `<div class="story-viewer-text">${escapeHtml(story.caption || '')}</div>`;
  }

  if (!(story.viewers || []).includes(me.id)) {
    api(`/api/stories/${story.id}/view`, { method: 'POST' }).then(() => {
      story.viewers = story.viewers || [];
      if (!story.viewers.includes(me.id)) story.viewers.push(me.id);
      renderStoriesRow();
    }).catch(() => {});
  }

  clearTimeout(storyViewerState.timer);
  const video = mediaWrap?.querySelector('video');
  const activeBarFill = $('.story-bar-fill');
  if (activeBarFill) {
    activeBarFill.style.animation = 'none';
    // Force reflow so the animation restarts cleanly on the new bar.
    void activeBarFill.offsetWidth;
  }
  if (video) {
    video.addEventListener('loadedmetadata', () => {
      const durationMs = Math.max(1000, (video.duration || 5) * 1000);
      if (activeBarFill) activeBarFill.style.animation = `story-bar-fill ${durationMs}ms linear forwards`;
    }, { once: true });
    storyViewerState.timer = setTimeout(() => advanceStory(1), 15000); // safety fallback
    video.addEventListener('ended', () => advanceStory(1), { once: true });
  } else {
    if (activeBarFill) activeBarFill.style.animation = `story-bar-fill ${STORY_IMAGE_DURATION_MS}ms linear forwards`;
    storyViewerState.timer = setTimeout(() => advanceStory(1), STORY_IMAGE_DURATION_MS);
  }
}

function advanceStory(dir) {
  if (!storyViewerState) return;
  clearTimeout(storyViewerState.timer);
  const { stories, index, userId } = storyViewerState;
  const nextIndex = index + dir;
  if (nextIndex >= 0 && nextIndex < stories.length) {
    storyViewerState.index = nextIndex;
    showStoryFrame();
    return;
  }
  // Ran off the end of this person's stories — move to the next/previous
  // person in the row, or close if there's nowhere left to go.
  const order = storyUserOrder();
  const pos = order.indexOf(userId);
  const nextPos = pos + dir;
  if (nextPos < 0 || nextPos >= order.length) {
    closeStoryViewer();
    return;
  }
  const nextUserId = order[nextPos];
  const nextStories = nextUserId === me.id ? myStories : (storiesByUser[nextUserId] || []);
  if (!nextStories.length) return closeStoryViewer();
  storyViewerState = { userId: nextUserId, stories: nextStories, index: dir > 0 ? 0 : nextStories.length - 1 };
  showStoryFrame();
}

function setupStoryViewer() {
  const viewer = $('#story-viewer');
  if (!viewer || viewer.dataset.wired) return;
  viewer.dataset.wired = '1';
  $('#story-viewer-close')?.addEventListener('click', closeStoryViewer);
  $('#story-viewer-prev')?.addEventListener('click', () => advanceStory(-1));
  $('#story-viewer-next')?.addEventListener('click', () => advanceStory(1));
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
        ? `<div class="post-card-media" data-action="dbltap-like"><video src="${post.media.url}" controls></video></div>`
        : `<div class="post-card-media" data-action="dbltap-like"><img src="${post.media.url}" alt="" /></div>`)
    : '';
  const likeCount = post.likes.length;
  const likesLabel = likeCount === 0 ? '' : `<div class="post-card-likes">${likeCount} like${likeCount === 1 ? '' : 's'}</div>`;

  return `
    <div class="post-card" data-post-id="${post.id}">
      <div class="post-card-header">
        <span class="post-card-header-clickable" data-action="view-profile" data-user-id="${post.user_id}">
          <span class="post-card-avatar-ring">${avatarOrInitials(post.user_id, post.user_name, '', 34)}</span>
          <div class="post-card-header-info">
            <div class="post-card-header-name">${escapeHtml(post.user_name)}${isMine ? ' (you)' : ''}</div>
            <div class="post-card-header-time">${timeAgo(post.created_at)}</div>
          </div>
        </span>
        ${isMine ? `<button class="post-more-btn" data-action="delete-post" title="Delete post">${ICONS.more}</button>` : ''}
      </div>
      ${mediaHtml}
      <div class="post-card-actions">
        <button class="post-action-btn icon-only ${likedByMe ? 'liked' : ''}" data-action="like-post" title="Like">${likedByMe ? ICONS.heartActive : ICONS.heart}</button>
        <span class="post-action-btn icon-only" style="cursor:default;" title="Comments">${ICONS.comment}</span>
      </div>
      ${likesLabel}
      ${post.caption ? `<div class="post-card-caption"><span class="post-card-caption-name">${escapeHtml(post.user_name)}</span> ${escapeHtml(post.caption)}</div>` : ''}
      <div class="post-card-comments">${post.comments.map(renderComment).join('')}</div>
      <form class="post-comment-form" data-action="comment-form">
        <input type="text" placeholder="Add a comment..." maxlength="500" required />
        <button type="submit">Post</button>
      </form>
    </div>
  `;
}

// Instagram-style: double-tap/double-click a post's photo or video to like it,
// with a big heart animation — even if it's already liked (a fun no-op tap).
async function likePost(postId) {
  haptic('tap');
  try {
    await api(`/api/posts/${postId}/like`, { method: 'POST' });
  } catch (err) {
    alert(err.message);
  }
}

// A little celebratory confetti burst when a task gets checked off — a small
// reward that makes finishing chores a bit more satisfying.
const CONFETTI_COLORS = ['#FF6B6B', '#FFA94D', '#4ECDC4', '#5B8DEF', '#8E7CFF', '#38C793'];

function spawnConfetti(anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  const piece_count = 14;
  for (let i = 0; i < piece_count; i++) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    const angle = (Math.PI * 2 * i) / piece_count + Math.random() * 0.5;
    const distance = 40 + Math.random() * 40;
    piece.style.left = `${originX}px`;
    piece.style.top = `${originY}px`;
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    piece.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 700);
  }
}

function spawnHeartBurst(container) {
  haptic('pop');
  const heart = document.createElement('div');
  heart.className = 'heart-burst';
  heart.textContent = '❤️';
  container.appendChild(heart);
  setTimeout(() => heart.remove(), 900);
}

const feedListEl = $('#feed-list');
if (feedListEl) {
  feedListEl.addEventListener('click', async (e) => {
    const likeBtn = e.target.closest('[data-action="like-post"]');
    if (likeBtn) {
      await likePost(likeBtn.closest('.post-card').dataset.postId);
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

  feedListEl.addEventListener('dblclick', (e) => {
    const media = e.target.closest('[data-action="dbltap-like"]');
    if (!media) return;
    spawnHeartBurst(media);
    likePost(media.closest('.post-card').dataset.postId);
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
