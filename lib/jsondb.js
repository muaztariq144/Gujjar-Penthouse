// Tiny zero-dependency JSON-file "database".
// Not built for huge scale, but perfect for a household's worth of data —
// and it needs no compiling, so `npm install` always just works.

const fs = require('fs');
const path = require('path');

function createStore(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let data;
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      data = null;
    }
  }
  if (!data || typeof data !== 'object') {
    data = { users: [], sessions: [], expenses: [], messages: [] };
  }
  for (const key of ['users', 'sessions', 'expenses', 'messages']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }

  function save() {
    // Write to a temp file then rename, so a crash mid-write can't corrupt the real file.
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  }

  return { data, save };
}

module.exports = { createStore };
