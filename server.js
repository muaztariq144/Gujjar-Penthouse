// Gujjar Penthouse — shared expense tracker + chat
// Beginner-friendly, single-file backend. No native/compiled dependencies
// (data is stored in a plain JSON file), so `npm install` works everywhere.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { createStore } = require('./lib/jsondb');

// ---------- Setup ----------
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'app.json');
const { data: db, save } = createStore(DB_PATH);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// ---------- Helpers ----------
function publicUser(u) {
  return { id: u.id, name: u.name };
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

// Greedy debt simplification: turns net balances into a short list of
// "X owes Y amount" transactions.
function simplifyDebts(netBalances) {
  const creditors = [];
  const debtors = [];
  for (const [userId, amount] of Object.entries(netBalances)) {
    const rounded = Math.round(amount * 100) / 100;
    if (rounded > 0.01) creditors.push({ userId, amount: rounded });
    else if (rounded < -0.01) debtors.push({ userId, amount: -rounded });
  }
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const settlements = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const amount = Math.min(debtor.amount, creditor.amount);
    if (amount > 0.01) {
      settlements.push({ from: debtor.userId, to: creditor.userId, amount: Math.round(amount * 100) / 100 });
    }
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount <= 0.01) i++;
    if (creditor.amount <= 0.01) j++;
  }
  return settlements;
}

function computeBalances() {
  const net = {};
  for (const u of db.users) net[u.id] = 0;

  for (const exp of db.expenses) {
    const splitAmong = exp.split_among;
    if (!splitAmong || splitAmong.length === 0) continue;
    const share = exp.amount / splitAmong.length;
    if (net[exp.paid_by] === undefined) net[exp.paid_by] = 0;
    net[exp.paid_by] += exp.amount;
    for (const uid of splitAmong) {
      if (net[uid] === undefined) net[uid] = 0;
      net[uid] -= share;
    }
  }

  const settlements = simplifyDebts(net);
  return { net, settlements };
}

// ---------- Auth routes ----------
app.post('/api/signup', (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password || password.length < 4) {
    return res.status(400).json({ error: 'Name and a password (4+ chars) are required.' });
  }
  const trimmedName = name.trim();
  const existing = db.users.find(u => u.name === trimmedName);
  if (existing) return res.status(400).json({ error: 'That name is already taken. Try logging in instead.' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.users.push({ id, name: trimmedName, password_hash: hash, created_at: Date.now() });

  const token = uuid();
  db.sessions.push({ token, user_id: id, created_at: Date.now() });
  save();
  res.json({ token, user: { id, name: trimmedName } });
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
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ---------- Users ----------
app.get('/api/users', authMiddleware, (req, res) => {
  res.json({ users: db.users.map(publicUser) });
});

// ---------- Expenses ----------
app.get('/api/expenses', authMiddleware, (req, res) => {
  const expenses = [...db.expenses].sort((a, b) => b.created_at - a.created_at);
  res.json({ expenses });
});

app.post('/api/expenses', authMiddleware, (req, res) => {
  const { description, amount, splitAmong } = req.body || {};
  const amt = Number(amount);
  if (!description || !amt || amt <= 0) {
    return res.status(400).json({ error: 'Description and a positive amount are required.' });
  }
  const allUserIds = db.users.map(u => u.id);
  const split = Array.isArray(splitAmong) && splitAmong.length > 0
    ? splitAmong.filter(id => allUserIds.includes(id))
    : allUserIds;

  const expense = {
    id: uuid(),
    description: description.trim(),
    amount: amt,
    paid_by: req.user.id,
    split_among: split,
    created_at: Date.now(),
  };
  db.expenses.push(expense);
  save();

  const balances = computeBalances();
  io.emit('balances:update', balances);
  io.emit('expense:new', expense);
  res.json({ ok: true, id: expense.id });
});

app.delete('/api/expenses/:id', authMiddleware, (req, res) => {
  db.expenses = db.expenses.filter(e => e.id !== req.params.id);
  save();
  const balances = computeBalances();
  io.emit('balances:update', balances);
  io.emit('expense:deleted', { id: req.params.id });
  res.json({ ok: true });
});

app.get('/api/balances', authMiddleware, (req, res) => {
  res.json(computeBalances());
});

// ---------- Chat ----------
app.get('/api/messages', authMiddleware, (req, res) => {
  const messages = [...db.messages].sort((a, b) => a.created_at - b.created_at).slice(-200);
  res.json({ messages });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const user = getUserByToken(token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = publicUser(user);
  next();
});

io.on('connection', (socket) => {
  socket.on('chat:send', (text) => {
    if (typeof text !== 'string' || !text.trim()) return;
    const message = {
      id: uuid(),
      user_id: socket.user.id,
      user_name: socket.user.name,
      text: text.trim(),
      created_at: Date.now(),
    };
    db.messages.push(message);
    save();
    io.emit('chat:message', message);
  });
});

server.listen(PORT, () => {
  console.log(`Gujjar Penthouse app running on http://localhost:${PORT}`);
});
