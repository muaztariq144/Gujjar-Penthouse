// Gujjar Penthouse — household social app (feed, chat, tasks, polls, calling)
// Beginner-friendly, single-file backend. No native/compiled dependencies
// (data is stored in a plain JSON file), so `npm install` works everywhere.

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const webpush = require('web-push');
const multer = require('multer');
const { createStore } = require('./lib/jsondb');

// ---------- Setup ----------
const PORT = process.env.PORT || 3000;
// If a Railway Volume is attached, Railway automatically sets
// RAILWAY_VOLUME_MOUNT_PATH — use it so the database and uploaded media
// survive redeploys, not just restarts. DATA_DIR still wins if set by hand.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'app.json');
const { data: db, save } = createStore(DB_PATH);

// ---------- Uploaded media (chat photos/videos/files, feed post photos) ----------
// Stored on disk next to the database (same persistence caveats as the JSON
// db itself: survives restarts, but a fresh Railway deploy without a Volume
// wipes it). Served back out at /uploads/<filename>.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 10);
      cb(null, `${uuid()}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---------- Push notifications ----------
// These VAPID keys identify this server to push services (Google, Apple, etc).
// They're safe to keep here since this is a private repo — but you can override
// them with environment variables of the same name if you ever want to.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY
  || 'BJVSYev3ichUhn3boLtuYAdaOshJ2uuY-UVIJZgBUvDrAnmFDJew8mDOly-pYNi1F8aYJMCb8HxB4zkVfgwGPuI';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY
  || 'AYSFpjOE8BR6KSEOfQ3dL36CPE0ohtDpnPjuQdwCemA';

webpush.setVapidDetails('mailto:gujjarpenthouse@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ---------- Email (used for "forgot password" one-time codes) ----------
// Sent through Brevo's HTTPS email API (https://www.brevo.com) rather than
// classic SMTP. Railway blocks outbound SMTP ports (25, 465, 587) on its
// Free/Trial/Hobby plans "to prevent spam and abuse", so a Gmail-SMTP-based
// mailer (what this used to be) can never actually send from a Railway app
// on those plans — the request just hangs. Brevo's API runs over plain
// HTTPS like any other web request, so it works on every Railway plan.
//
// Configure by setting BREVO_API_KEY + EMAIL_FROM as environment variables
// on Railway. If they're not set, OTP codes are just printed to the server
// log instead of emailed — handy for local testing, but roommates won't get
// a real email until this is set up.
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM;

async function sendOtpEmail(toEmail, otp) {
  const subject = 'Your Gujjar Penthouse password reset code';
  const text = `Your password reset code is ${otp}. It expires in 15 minutes. If you didn't ask for this, you can ignore this email.`;
  const html = `
    <div style="font-family:sans-serif;max-width:420px;margin:0 auto;">
      <h2 style="color:#005e54;">Gujjar Penthouse</h2>
      <p>Your password reset code is:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#005e54;">${otp}</p>
      <p style="color:#667781;font-size:13px;">This code expires in 15 minutes. If you didn't ask for this, you can ignore this email.</p>
    </div>
  `;

  if (!BREVO_API_KEY || !EMAIL_FROM) {
    // Not configured — log it so whoever is running the server locally can still test the flow.
    console.log(`[dev only] Password reset code for ${toEmail}: ${otp}`);
    return;
  }

  // A hard timeout so a flaky network can never leave the request (and the
  // "Send code" button on the frontend) hanging forever with no feedback.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'Gujjar Penthouse', email: EMAIL_FROM },
        to: [{ email: toEmail }],
        subject,
        textContent: text,
        htmlContent: html,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Email service timed out. Please try again.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Brevo API error ${response.status}: ${body}`);
  }
}

// Sends a notification to every subscribed device belonging to the given users
// (or everyone, if excludeUserId is the only filter). Cleans up subscriptions
// that have gone stale (e.g. the user uninstalled the app).
async function sendPushToUsers({ excludeUserId, onlyUserId, title, body, tag, type, data }) {
  const targets = onlyUserId
    ? db.pushSubscriptions.filter(s => s.user_id === onlyUserId)
    : db.pushSubscriptions.filter(s => s.user_id !== excludeUserId);
  const stillValid = [];
  let changed = false;

  const payload = JSON.stringify({ title, body, tag, type, data });

  await Promise.all(targets.map(async (sub) => {
    try {
      await webpush.sendNotification(sub.subscription, payload);
      stillValid.push(sub);
    } catch (err) {
      changed = true; // subscription expired or was revoked — drop it
    }
  }));

  if (changed) {
    const keptEndpoints = new Set(stillValid.map(s => s.subscription.endpoint));
    db.pushSubscriptions = db.pushSubscriptions.filter((s) => {
      const inScope = onlyUserId ? s.user_id === onlyUserId : s.user_id !== excludeUserId;
      return !inScope || keptEndpoints.has(s.subscription.endpoint);
    });
    save();
  }
}

// In-app "recent notifications" feed (separate from browser push notifications
// above — this is what shows up in the Home tab even without push enabled).
function addNotification(userId, type, text) {
  if (!userId) return;
  const notification = { id: uuid(), user_id: userId, type, text, created_at: Date.now(), read: false };
  db.notifications.push(notification);
  // Let that person's Home tab pick it up live, the same way chat messages
  // and feed posts do, instead of only showing up on their next visit.
  io.emit('notification:new', {
    userId,
    notification: { id: notification.id, type: notification.type, text: notification.text, createdAt: notification.created_at, read: false },
  });
}

// Short, human quote of a caption/comment for inside a notification line —
// so notifications say specifically what happened, not just that "something" did.
function quoteSnippet(text, maxLen = 60) {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  return trimmed.length > maxLen ? `"${trimmed.slice(0, maxLen - 1)}…"` : `"${trimmed}"`;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const server = http.createServer(app);
const io = new Server(server);

// ---------- Helpers ----------
function publicUser(u) {
  return { id: u.id, name: u.name, avatarUrl: u.avatar_url || null };
}

// A fuller version of the user's own profile — only ever sent back to that user themselves.
function privateProfile(u) {
  return { id: u.id, name: u.name, email: u.email || null, avatarUrl: u.avatar_url || null };
}

function findUserById(id) {
  return db.users.find(u => u.id === id) || null;
}

function getUserByToken(token) {
  if (!token) return null;
  const session = db.sessions.find(s => s.token === token);
  if (!session) return null;
  return findUserById(session.user_id);
}

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  req.user = user;
  next();
}

// ---------- Auth routes ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !password || password.length < 4) {
    return res.status(400).json({ error: 'Name and a password (4+ chars) are required.' });
  }
  const trimmedName = name.trim();
  const trimmedEmail = (email || '').trim().toLowerCase();
  if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) {
    return res.status(400).json({ error: 'A valid email address is required (used for password resets).' });
  }

  const existingName = db.users.find(u => u.name === trimmedName);
  if (existingName) return res.status(400).json({ error: 'That name is already taken. Try logging in instead.' });
  const existingEmail = db.users.find(u => u.email === trimmedEmail);
  if (existingEmail) return res.status(400).json({ error: 'That email is already registered. Try logging in instead.' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  const newUser = { id, name: trimmedName, email: trimmedEmail, avatar_url: null, password_hash: hash, created_at: Date.now() };
  db.users.push(newUser);

  const token = uuid();
  db.sessions.push({ token, user_id: id, created_at: Date.now() });
  save();
  res.json({ token, user: privateProfile(newUser) });

  // Let everyone else's app pick up the new roommate live (split checkboxes,
  // task assignee list, etc.) without needing to reload.
  io.emit('user:new', publicUser(newUser));
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body || {};
  const user = db.users.find(u => u.name === (name || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong name or password.' });
  }
  const token = uuid();
  db.sessions.push({ token, user_id: user.id, created_at: Date.now() });
  save();
  res.json({ token, user: privateProfile(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: privateProfile(req.user) });
});

app.patch('/api/me', authMiddleware, (req, res) => {
  const { name, email, avatarUrl } = req.body || {};

  if (typeof name === 'string' && name.trim()) {
    const trimmedName = name.trim();
    const clash = db.users.find(u => u.id !== req.user.id && u.name === trimmedName);
    if (clash) return res.status(400).json({ error: 'That name is already taken.' });
    req.user.name = trimmedName;
  }

  if (typeof email === 'string' && email.trim()) {
    const trimmedEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmedEmail)) return res.status(400).json({ error: 'That email address looks invalid.' });
    const clash = db.users.find(u => u.id !== req.user.id && u.email === trimmedEmail);
    if (clash) return res.status(400).json({ error: 'That email is already registered to another account.' });
    req.user.email = trimmedEmail;
  }

  if (typeof avatarUrl === 'string') {
    req.user.avatar_url = avatarUrl || null;
  }

  save();
  io.emit('user:updated', publicUser(req.user));
  res.json({ ok: true, user: privateProfile(req.user) });
});

app.post('/api/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(currentPassword || '', req.user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  }
  req.user.password_hash = bcrypt.hashSync(newPassword, 10);
  save();
  res.json({ ok: true });
});

// ---------- Forgot password (email OTP) ----------
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const trimmedEmail = (email || '').trim().toLowerCase();
  // Always respond the same way whether or not the email exists, so this
  // can't be used to check who has an account.
  const genericResponse = { ok: true, message: 'If that email is registered, a code has been sent to it.' };
  if (!trimmedEmail) return res.json(genericResponse);

  const user = db.users.find(u => u.email === trimmedEmail);
  if (!user) return res.json(genericResponse);

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  db.passwordResets = db.passwordResets.filter(r => r.email !== trimmedEmail); // drop older codes
  db.passwordResets.push({
    email: trimmedEmail,
    otp,
    expires_at: Date.now() + 15 * 60 * 1000,
    used: false,
    created_at: Date.now(),
  });
  save();

  try {
    await sendOtpEmail(trimmedEmail, otp);
  } catch (err) {
    console.error('Failed to send OTP email:', err.message);
    return res.status(500).json({ error: 'Could not send the reset email right now. Please try again shortly.' });
  }

  res.json(genericResponse);
});

app.post('/api/reset-password', (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  const trimmedEmail = (email || '').trim().toLowerCase();
  const trimmedOtp = (otp || '').trim();

  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  }

  const reset = db.passwordResets.find(r => r.email === trimmedEmail && r.otp === trimmedOtp && !r.used);
  if (!reset || reset.expires_at < Date.now()) {
    return res.status(400).json({ error: 'That code is invalid or has expired. Request a new one.' });
  }

  const user = db.users.find(u => u.email === trimmedEmail);
  if (!user) return res.status(400).json({ error: 'That code is invalid or has expired. Request a new one.' });

  user.password_hash = bcrypt.hashSync(newPassword, 10);
  reset.used = true;
  // Log the user out of every device — their old password (and any leaked
  // session tokens) shouldn't keep working after a reset.
  db.sessions = db.sessions.filter(s => s.user_id !== user.id);
  save();

  res.json({ ok: true });
});

// ---------- Users ----------
app.get('/api/users', authMiddleware, (req, res) => {
  res.json({ users: db.users.map(publicUser) });
});

// ---------- Tasks (create & assign to a roommate, with a due date) ----------
function publicTask(t) {
  const assignee = findUserById(t.assigned_to);
  const assigner = findUserById(t.assigned_by);
  return {
    id: t.id,
    title: t.title,
    dueDate: t.due_date,
    done: !!t.done,
    createdAt: t.created_at,
    assignedTo: assignee ? publicUser(assignee) : null,
    assignedBy: assigner ? publicUser(assigner) : null,
  };
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1; // pending first
    const ad = a.due_date ? new Date(a.due_date).getTime() : Infinity;
    const bd = b.due_date ? new Date(b.due_date).getTime() : Infinity;
    if (ad !== bd) return ad - bd; // soonest due date first
    return b.created_at - a.created_at;
  });
}

app.get('/api/tasks', authMiddleware, (req, res) => {
  res.json({ tasks: sortTasks(db.tasks).map(publicTask) });
});

app.post('/api/tasks', authMiddleware, (req, res) => {
  const { title, assignedTo, dueDate } = req.body || {};
  const trimmedTitle = typeof title === 'string' ? title.trim() : '';
  if (!trimmedTitle) return res.status(400).json({ error: 'Give the task a title.' });

  const assignee = findUserById(assignedTo);
  if (!assignee) return res.status(400).json({ error: 'Pick who this task is for.' });

  let cleanDueDate = null;
  if (typeof dueDate === 'string' && dueDate.trim()) {
    if (isNaN(new Date(dueDate).getTime())) return res.status(400).json({ error: 'That due date looks invalid.' });
    cleanDueDate = dueDate.trim();
  }

  const task = {
    id: uuid(),
    title: trimmedTitle,
    assigned_to: assignee.id,
    assigned_by: req.user.id,
    due_date: cleanDueDate,
    done: false,
    created_at: Date.now(),
    completed_at: null,
  };
  db.tasks.push(task);

  if (assignee.id !== req.user.id) {
    addNotification(
      assignee.id,
      'task',
      `${req.user.name} assigned you a task: "${trimmedTitle}"${cleanDueDate ? ` — due ${cleanDueDate}` : ''}`
    );
  }
  save();

  const publicVersion = publicTask(task);
  io.emit('task:new', publicVersion);
  res.json({ ok: true, task: publicVersion });

  if (assignee.id !== req.user.id) {
    sendPushToUsers({
      onlyUserId: assignee.id,
      title: `${req.user.name} assigned you a task`,
      body: trimmedTitle,
      tag: 'gp-task',
    }).catch(() => {});
  }
});

app.post('/api/tasks/:id/toggle', authMiddleware, (req, res) => {
  const task = db.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  task.done = !task.done;
  task.completed_at = task.done ? Date.now() : null;
  save();

  const publicVersion = publicTask(task);
  io.emit('task:updated', publicVersion);
  res.json({ ok: true, task: publicVersion });
});

app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  db.tasks = db.tasks.filter(t => t.id !== req.params.id);
  save();
  io.emit('task:deleted', { id: req.params.id });
  res.json({ ok: true });
});

// ---------- In-app notifications feed (Home tab) ----------
app.get('/api/notifications', authMiddleware, (req, res) => {
  const mine = db.notifications
    .filter(n => n.user_id === req.user.id)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 20);

  const result = mine.map(n => ({ id: n.id, type: n.type, text: n.text, createdAt: n.created_at, read: n.read }));

  // Viewing the feed marks these as read, the same way opening a chat app
  // clears its unread badge.
  let changed = false;
  for (const n of mine) { if (!n.read) { n.read = true; changed = true; } }
  if (changed) save();

  res.json({ notifications: result });
});

// ---------- Public profile (Instagram-style "view someone's profile") ----------
// Read-only from the viewer's side: their posts and their tasks — but never
// their email, password, or anything editable.
app.get('/api/users/:id/profile', authMiddleware, (req, res) => {
  const user = findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const posts = db.posts
    .filter(p => p.user_id === user.id)
    .sort((a, b) => b.created_at - a.created_at)
    .map(p => publicPost(p, req.user.id));

  const tasks = sortTasks(db.tasks.filter(t => t.assigned_to === user.id)).map(publicTask);

  res.json({
    user: publicUser(user),
    joinedAt: user.created_at,
    isMe: user.id === req.user.id,
    posts,
    tasks,
  });
});

// ---------- Media uploads (used by chat attachments and feed posts) ----------
app.post('/api/upload', authMiddleware, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too big (max 25MB).' : 'Could not upload that file.';
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    const mime = req.file.mimetype || '';
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';

    res.json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      mime,
      kind,
      size: req.file.size,
    });
  });
});

// ---------- Push notifications ----------
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Missing push subscription.' });
  }
  // Replace any existing subscription for this exact device.
  db.pushSubscriptions = db.pushSubscriptions.filter(s => s.subscription.endpoint !== subscription.endpoint);
  db.pushSubscriptions.push({ user_id: req.user.id, subscription, created_at: Date.now() });
  save();
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', authMiddleware, (req, res) => {
  const { endpoint } = req.body || {};
  db.pushSubscriptions = db.pushSubscriptions.filter(s => s.subscription.endpoint !== endpoint);
  save();
  res.json({ ok: true });
});

// ---------- Polls (any member can start a referendum with a time limit) ----------
function publicPoll(p, viewerId) {
  const now = Date.now();
  const closed = now >= p.expires_at;
  const totalVotes = p.options.reduce((sum, o) => sum + o.votes.length, 0);
  return {
    id: p.id,
    question: p.question,
    options: p.options.map((o, idx) => ({
      idx,
      text: o.text,
      voteCount: o.votes.length,
      percent: totalVotes ? Math.round((o.votes.length / totalVotes) * 100) : 0,
    })),
    totalVotes,
    createdBy: publicUser(findUserById(p.created_by)) || null,
    createdAt: p.created_at,
    expiresAt: p.expires_at,
    closed,
    myVote: viewerId != null ? (p.options.findIndex(o => o.votes.includes(viewerId)) === -1 ? null : p.options.findIndex(o => o.votes.includes(viewerId))) : null,
  };
}

function sortPolls(polls) {
  return [...polls].sort((a, b) => {
    const aClosed = Date.now() >= a.expires_at;
    const bClosed = Date.now() >= b.expires_at;
    if (aClosed !== bClosed) return aClosed ? 1 : -1; // open polls first
    return b.created_at - a.created_at;
  });
}

app.get('/api/polls', authMiddleware, (req, res) => {
  res.json({ polls: sortPolls(db.polls).map(p => publicPoll(p, req.user.id)) });
});

app.post('/api/polls', authMiddleware, (req, res) => {
  const { question, options, durationMinutes } = req.body || {};
  const trimmedQuestion = typeof question === 'string' ? question.trim() : '';
  if (!trimmedQuestion) return res.status(400).json({ error: 'Give the poll a question.' });

  const cleanOptions = Array.isArray(options)
    ? options.map(o => (typeof o === 'string' ? o.trim() : '')).filter(Boolean).slice(0, 8)
    : [];
  if (cleanOptions.length < 2) return res.status(400).json({ error: 'Add at least 2 options.' });

  const minutes = Number(durationMinutes);
  const durMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 24 * 60 * 60 * 1000;
  const cappedMs = Math.min(durMs, 30 * 24 * 60 * 60 * 1000); // cap at 30 days

  const poll = {
    id: uuid(),
    question: trimmedQuestion,
    options: cleanOptions.map(text => ({ text, votes: [] })),
    created_by: req.user.id,
    created_at: Date.now(),
    expires_at: Date.now() + cappedMs,
  };
  db.polls.push(poll);

  for (const u of db.users) {
    if (u.id === req.user.id) continue;
    addNotification(u.id, 'poll', `${req.user.name} started a poll: "${trimmedQuestion}"`);
  }
  save();

  const publicVersion = publicPoll(poll, req.user.id);
  io.emit('poll:new', publicVersion);
  res.json({ ok: true, poll: publicVersion });

  sendPushToUsers({
    excludeUserId: req.user.id,
    title: `${req.user.name} started a poll`,
    body: trimmedQuestion,
    tag: 'gp-poll',
  }).catch(() => {});
});

app.post('/api/polls/:id/vote', authMiddleware, (req, res) => {
  const poll = db.polls.find(p => p.id === req.params.id);
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });
  if (Date.now() >= poll.expires_at) return res.status(400).json({ error: 'This poll has closed.' });

  const optionIdx = Number(req.body?.optionIdx);
  if (!Number.isInteger(optionIdx) || optionIdx < 0 || optionIdx >= poll.options.length) {
    return res.status(400).json({ error: 'Invalid option.' });
  }

  // One vote per member — voting again changes their vote.
  for (const opt of poll.options) {
    const idx = opt.votes.indexOf(req.user.id);
    if (idx !== -1) opt.votes.splice(idx, 1);
  }
  poll.options[optionIdx].votes.push(req.user.id);
  save();

  // Broadcast the fresh tallies to everyone (per-viewer myVote is computed client-side isn't possible,
  // so we emit the raw counts and let each client keep its own "myVote" from its own action/state).
  io.emit('poll:updated', {
    id: poll.id,
    options: poll.options.map((o, idx) => ({ idx, voteCount: o.votes.length })),
    totalVotes: poll.options.reduce((sum, o) => sum + o.votes.length, 0),
  });
  res.json({ ok: true, poll: publicPoll(poll, req.user.id) });
});

app.delete('/api/polls/:id', authMiddleware, (req, res) => {
  const poll = db.polls.find(p => p.id === req.params.id);
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });
  if (poll.created_by !== req.user.id) return res.status(403).json({ error: 'You can only delete polls you started.' });

  db.polls = db.polls.filter(p => p.id !== req.params.id);
  save();
  io.emit('poll:deleted', { id: req.params.id });
  res.json({ ok: true });
});

// ---------- Chat ----------
app.get('/api/messages', authMiddleware, (req, res) => {
  const messages = [...db.messages].sort((a, b) => a.created_at - b.created_at).slice(-200);
  res.json({ messages });
});

// ---------- Feed (Instagram-style posts, likes, comments) ----------
function publicPost(post, viewerId) {
  return {
    id: post.id,
    user_id: post.user_id,
    user_name: post.user_name,
    caption: post.caption,
    media: post.media || null,
    created_at: post.created_at,
    likes: post.likes,
    likeCount: post.likes.length,
    likedByMe: post.likes.includes(viewerId),
    comments: post.comments,
  };
}

app.get('/api/posts', authMiddleware, (req, res) => {
  const posts = [...db.posts]
    .sort((a, b) => b.created_at - a.created_at)
    .map(p => publicPost(p, req.user.id));
  res.json({ posts });
});

app.post('/api/posts', authMiddleware, (req, res) => {
  const { caption, media } = req.body || {};
  const trimmedCaption = typeof caption === 'string' ? caption.trim() : '';
  const cleanMedia = media && typeof media.url === 'string'
    ? {
        url: media.url,
        kind: ['image', 'video'].includes(media.kind) ? media.kind : 'image',
      }
    : null;

  if (!trimmedCaption && !cleanMedia) {
    return res.status(400).json({ error: 'Add a caption or a photo/video to post.' });
  }

  const post = {
    id: uuid(),
    user_id: req.user.id,
    user_name: req.user.name,
    caption: trimmedCaption,
    media: cleanMedia,
    likes: [],
    comments: [],
    created_at: Date.now(),
  };
  db.posts.push(post);

  const captionSnippet = quoteSnippet(trimmedCaption);
  const postKind = cleanMedia?.kind === 'video' ? 'a video' : cleanMedia ? 'a photo' : 'a post';
  for (const u of db.users) {
    if (u.id === req.user.id) continue;
    addNotification(u.id, 'post', `${req.user.name} shared ${postKind}${captionSnippet ? `: ${captionSnippet}` : ''}`);
  }
  save();

  const publicVersion = publicPost(post, req.user.id);
  io.emit('post:new', publicVersion);
  res.json({ ok: true, post: publicVersion });

  sendPushToUsers({
    excludeUserId: req.user.id,
    title: `${req.user.name} posted to the feed`,
    body: trimmedCaption || (cleanMedia?.kind === 'video' ? '🎥 New video' : '📷 New photo'),
    tag: 'gp-feed',
  }).catch(() => {});
});

app.delete('/api/posts/:id', authMiddleware, (req, res) => {
  const post = db.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own posts.' });

  db.posts = db.posts.filter(p => p.id !== req.params.id);
  save();
  io.emit('post:deleted', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', authMiddleware, (req, res) => {
  const post = db.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });

  const idx = post.likes.indexOf(req.user.id);
  const nowLiked = idx === -1;
  if (nowLiked) post.likes.push(req.user.id);
  else post.likes.splice(idx, 1);

  if (nowLiked && post.user_id !== req.user.id) {
    const captionSnippet = quoteSnippet(post.caption);
    addNotification(post.user_id, 'like', `${req.user.name} liked your post${captionSnippet ? `: ${captionSnippet}` : ''}`);
  }
  save();

  io.emit('post:like-update', { id: post.id, likes: post.likes });
  res.json({ ok: true, likes: post.likes });

  if (nowLiked && post.user_id !== req.user.id) {
    sendPushToUsers({
      excludeUserId: req.user.id,
      title: `${req.user.name} liked your post`,
      body: post.caption || '❤️',
      tag: 'gp-feed-like',
    }).catch(() => {});
  }
});

app.post('/api/posts/:id/comments', authMiddleware, (req, res) => {
  const post = db.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });

  const { text } = req.body || {};
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'Comment cannot be empty.' });

  const comment = {
    id: uuid(),
    user_id: req.user.id,
    user_name: req.user.name,
    text: trimmed.slice(0, 500),
    created_at: Date.now(),
  };
  post.comments.push(comment);

  if (post.user_id !== req.user.id) {
    addNotification(post.user_id, 'comment', `${req.user.name} commented on your post: ${quoteSnippet(comment.text)}`);
  }
  save();

  io.emit('post:comment-new', { postId: post.id, comment });
  res.json({ ok: true, comment });

  if (post.user_id !== req.user.id) {
    sendPushToUsers({
      excludeUserId: req.user.id,
      title: `${req.user.name} commented on your post`,
      body: comment.text,
      tag: 'gp-feed-comment',
    }).catch(() => {});
  }
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const user = getUserByToken(token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = publicUser(user);
  next();
});

// ---------- Chat typing indicator ----------
// Map of socket.id -> { userId, userName, avatarUrl }, everyone currently typing in chat.
const typingUsers = new Map();

function broadcastTyping() {
  // De-dupe by userId in case someone has the app open on two devices.
  const seen = new Map();
  for (const info of typingUsers.values()) seen.set(info.userId, info);
  io.emit('chat:typing-users', [...seen.values()]);
}

function stopTyping(socket) {
  if (typingUsers.has(socket.id)) {
    typingUsers.delete(socket.id);
    broadcastTyping();
  }
}

// ---------- Voice/video call room (WebRTC signaling only — no media passes through this server) ----------
// Map of socket.id -> { userId, userName }, everyone currently in the shared call.
const callParticipants = new Map();

function leaveCall(socket) {
  if (!callParticipants.has(socket.id)) return;
  callParticipants.delete(socket.id);
  socket.to('call-room').emit('call:peer-left', { socketId: socket.id });
  socket.leave('call-room');
}

io.on('connection', (socket) => {
  // `payload` is either a plain string (older/text-only clients) or
  // { text, attachment: { url, name, mime, kind } } for messages with media.
  socket.on('chat:send', (payload) => {
    const isObject = payload && typeof payload === 'object';
    const text = (isObject ? payload.text : payload) || '';
    const attachment = isObject && payload.attachment && typeof payload.attachment.url === 'string'
      ? {
          url: payload.attachment.url,
          name: typeof payload.attachment.name === 'string' ? payload.attachment.name.slice(0, 200) : '',
          mime: typeof payload.attachment.mime === 'string' ? payload.attachment.mime : '',
          kind: ['image', 'video', 'file'].includes(payload.attachment.kind) ? payload.attachment.kind : 'file',
        }
      : null;

    const trimmedText = typeof text === 'string' ? text.trim() : '';
    if (!trimmedText && !attachment) return; // nothing to send

    // Sending a message implies they're done typing.
    stopTyping(socket);

    // Swipe-to-reply: snapshot the quoted message's text/sender at send time,
    // so the quote still reads correctly even if the original is ever deleted.
    let replyTo = null;
    const replyToId = isObject && typeof payload.replyTo === 'string' ? payload.replyTo : null;
    if (replyToId) {
      const original = db.messages.find(m => m.id === replyToId);
      if (original) {
        replyTo = {
          id: original.id,
          userId: original.user_id,
          userName: original.user_name,
          text: original.text || '',
          attachmentKind: original.attachment ? original.attachment.kind : null,
        };
      }
    }

    const message = {
      id: uuid(),
      user_id: socket.user.id,
      user_name: socket.user.name,
      text: trimmedText,
      attachment,
      reply_to: replyTo,
      created_at: Date.now(),
    };
    db.messages.push(message);
    save();
    io.emit('chat:message', message);

    sendPushToUsers({
      excludeUserId: socket.user.id,
      title: socket.user.name,
      body: trimmedText || (attachment?.kind === 'image' ? '📷 Photo' : attachment?.kind === 'video' ? '🎥 Video' : '📎 Attachment'),
      tag: 'gp-chat',
    }).catch(() => {});
  });

  // A device asks to join the shared call room. We reply (via ack callback)
  // with the list of people already in it, so the joiner can initiate a
  // WebRTC connection to each of them.
  socket.on('call:join', (_data, callback) => {
    const wasEmpty = callParticipants.size === 0;
    const existingPeers = [...callParticipants.entries()].map(([socketId, info]) => ({
      socketId,
      userName: info.userName,
    }));

    callParticipants.set(socket.id, { userId: socket.user.id, userName: socket.user.name });
    socket.join('call-room');

    if (typeof callback === 'function') callback({ peers: existingPeers });

    socket.to('call-room').emit('call:peer-joined', {
      socketId: socket.id,
      userName: socket.user.name,
    });

    if (wasEmpty) {
      // Drop a "call started" entry into the group chat thread itself, WhatsApp-style,
      // so it's part of the permanent chat history and shows up even for people
      // who open the app later instead of tapping the notification.
      const callMessage = {
        id: uuid(),
        user_id: socket.user.id,
        user_name: socket.user.name,
        text: '',
        attachment: null,
        type: 'call-start',
        created_at: Date.now(),
      };
      db.messages.push(callMessage);
      save();
      io.emit('chat:message', callMessage);

      sendPushToUsers({
        excludeUserId: socket.user.id,
        title: `📞 ${socket.user.name} is calling Gujjar Penthouse`,
        body: 'Join or decline the house call.',
        tag: 'gp-call',
        type: 'call-invite',
        data: { callerName: socket.user.name },
      }).catch(() => {});
    }
  });

  // WhatsApp-style typing indicator. The client sends "start" on keystroke
  // (throttled) and "stop" after a short pause or on send/blur.
  socket.on('chat:typing-start', () => {
    typingUsers.set(socket.id, { userId: socket.user.id, userName: socket.user.name, avatarUrl: socket.user.avatarUrl || null });
    broadcastTyping();
  });

  socket.on('chat:typing-stop', () => stopTyping(socket));

  socket.on('call:leave', () => leaveCall(socket));

  // Pure relay: forward WebRTC offers/answers/ICE candidates to the intended peer only.
  socket.on('call:offer', ({ to, offer }) => {
    if (!to || !offer) return;
    io.to(to).emit('call:offer', { from: socket.id, userName: socket.user.name, offer });
  });

  socket.on('call:answer', ({ to, answer }) => {
    if (!to || !answer) return;
    io.to(to).emit('call:answer', { from: socket.id, answer });
  });

  socket.on('call:ice-candidate', ({ to, candidate }) => {
    if (!to || !candidate) return;
    io.to(to).emit('call:ice-candidate', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    leaveCall(socket);
    stopTyping(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Gujjar Penthouse app running on http://localhost:${PORT}`);
});
