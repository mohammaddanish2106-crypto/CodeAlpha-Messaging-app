// ============================================================
//  GupShup - mini social media backend (Express + SQLite + WS)
// ============================================================
const express = require('express');
const http    = require('http');
const path    = require('path');
const Database = require('better-sqlite3');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'social.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, post_id)
);
CREATE TABLE IF NOT EXISTS follows (
  follower_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT    NOT NULL,
  read_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_user      ON posts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_post   ON comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_follows_target  ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_messages_convo  ON messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_inbox  ON messages(recipient_id, created_at);
`);

// ---------- Helpers ----------
const POST_SELECT = `
  SELECT p.id, p.content, p.created_at, u.username, u.display_name,
    (SELECT COUNT(*) FROM likes    WHERE post_id = p.id) AS like_count,
    (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
    EXISTS (SELECT 1 FROM likes WHERE post_id = p.id AND user_id = @me) AS liked
  FROM posts p JOIN users u ON u.id = p.user_id`;

const cleanPost = (r) => ({ ...r, liked: !!r.liked });

const signToken = (user) =>
  jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in first.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(req.user.id)) throw new Error('gone');
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------- App ----------
const app    = express();
const server = http.createServer(app);   // raw HTTP server — shared with WS

app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => { req.body = req.body || {}; next(); });
app.use(express.static(path.join(__dirname, 'public')));

// ----- Auth -----
app.post('/api/auth/register', (req, res) => {
  const username    = String(req.body.username     || '').trim();
  const displayName = String(req.body.display_name || '').trim() || username;
  const password    = String(req.body.password     || '');

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username))
    return bad(res, 'Username must be 3-20 characters: letters, numbers, underscore.');
  if (password.length < 6)    return bad(res, 'Password must be at least 6 characters.');
  if (displayName.length > 40) return bad(res, 'Display name is too long (max 40).');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username))
    return bad(res, 'That username is already taken.', 409);

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)')
    .run(username, hash, displayName);
  const user = { id: info.lastInsertRowid, username };
  res.status(201).json({ token: signToken(user), user: { username, display_name: displayName } });
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !bcrypt.compareSync(password, row.password_hash))
    return bad(res, 'Wrong username or password.', 401);
  res.json({ token: signToken(row), user: { username: row.username, display_name: row.display_name } });
});

app.get('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT username, display_name, bio FROM users WHERE id = ?').get(req.user.id);
  res.json(u);
});

// ----- Posts -----
app.get('/api/feed', auth, (req, res) => {
  const followingOnly = req.query.scope === 'following';
  const where = followingOnly
    ? `WHERE p.user_id = @me OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = @me)`
    : '';
  const rows = db
    .prepare(`${POST_SELECT} ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT 50`)
    .all({ me: req.user.id });
  res.json(rows.map(cleanPost));
});

app.post('/api/posts', auth, (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content)              return bad(res, 'Write something first.');
  if (content.length > 280)  return bad(res, 'Posts are limited to 280 characters.');
  const info = db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(req.user.id, content);
  const row  = db.prepare(`${POST_SELECT} WHERE p.id = @id`).get({ me: req.user.id, id: info.lastInsertRowid });
  res.status(201).json(cleanPost(row));
});

app.delete('/api/posts/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return bad(res, 'Post not found, or it is not yours.', 404);
  res.json({ ok: true });
});

// ----- Likes (toggle) -----
app.post('/api/posts/:id/like', auth, (req, res) => {
  const postId = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId))
    return bad(res, 'Post not found.', 404);

  const existing = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?').get(req.user.id, postId);
  if (existing) db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, postId);
  else          db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user.id, postId);

  const count = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?').get(postId).c;
  res.json({ liked: !existing, like_count: count });
});

// ----- Comments -----
app.get('/api/posts/:id/comments', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.content, c.created_at, u.username, u.display_name
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.post_id = ? ORDER BY c.created_at ASC, c.id ASC`
  ).all(req.params.id);
  res.json(rows);
});

app.post('/api/posts/:id/comments', auth, (req, res) => {
  const postId  = Number(req.params.id);
  const content = String(req.body.content || '').trim();
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId)) return bad(res, 'Post not found.', 404);
  if (!content)              return bad(res, 'Write a comment first.');
  if (content.length > 200)  return bad(res, 'Comments are limited to 200 characters.');

  const info = db
    .prepare('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)')
    .run(postId, req.user.id, content);
  const row = db.prepare(
    `SELECT c.id, c.content, c.created_at, u.username, u.display_name
     FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`
  ).get(info.lastInsertRowid);
  res.status(201).json(row);
});

app.delete('/api/comments/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM comments WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return bad(res, 'Comment not found, or it is not yours.', 404);
  res.json({ ok: true });
});

// ----- Users, profiles, follow -----
app.get('/api/users/suggestions', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT u.username, u.display_name,
       (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS followers
     FROM users u
     WHERE u.id <> @me
       AND u.id NOT IN (SELECT following_id FROM follows WHERE follower_id = @me)
     ORDER BY followers DESC, u.created_at DESC LIMIT 5`
  ).all({ me: req.user.id });
  res.json(rows);
});

app.get('/api/users/:username', auth, (req, res) => {
  const user = db.prepare(
    `SELECT u.id, u.username, u.display_name, u.bio, u.created_at,
       (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS followers,
       (SELECT COUNT(*) FROM follows WHERE follower_id  = u.id) AS following,
       (SELECT COUNT(*) FROM posts   WHERE user_id      = u.id) AS post_count,
       EXISTS (SELECT 1 FROM follows WHERE follower_id = @me AND following_id = u.id) AS is_following
     FROM users u WHERE u.username = @username`
  ).get({ me: req.user.id, username: req.params.username });
  if (!user) return bad(res, 'User not found.', 404);

  const posts = db
    .prepare(`${POST_SELECT} WHERE p.user_id = @uid ORDER BY p.created_at DESC, p.id DESC LIMIT 50`)
    .all({ me: req.user.id, uid: user.id })
    .map(cleanPost);

  const { id, ...profile } = user;
  res.json({ ...profile, is_following: !!profile.is_following, is_me: id === req.user.id, posts });
});

app.put('/api/users/me', auth, (req, res) => {
  const displayName = String(req.body.display_name || '').trim();
  const bio         = String(req.body.bio          || '').trim();
  if (!displayName)           return bad(res, 'Display name cannot be empty.');
  if (displayName.length > 40) return bad(res, 'Display name is too long (max 40).');
  if (bio.length > 160)        return bad(res, 'Bio is limited to 160 characters.');
  db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(displayName, bio, req.user.id);
  res.json({ display_name: displayName, bio });
});

app.post('/api/users/:username/follow', auth, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!target)                    return bad(res, 'User not found.', 404);
  if (target.id === req.user.id)  return bad(res, "You can't follow yourself.");

  const existing = db
    .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?')
    .get(req.user.id, target.id);
  if (existing)
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user.id, target.id);
  else
    db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.user.id, target.id);

  const followers = db.prepare('SELECT COUNT(*) AS c FROM follows WHERE following_id = ?').get(target.id).c;
  res.json({ is_following: !existing, followers });
});

// ----- Messages (REST) -----

// GET /api/messages/inbox — list of conversations (one row per person, most recent first)
app.get('/api/messages/inbox', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      u.username,
      u.display_name,
      m.content      AS last_message,
      m.created_at   AS last_at,
      m.sender_id,
      (SELECT COUNT(*) FROM messages
       WHERE recipient_id = @me AND sender_id = u.id AND read_at IS NULL) AS unread
    FROM users u
    JOIN messages m ON m.id = (
      SELECT id FROM messages
      WHERE (sender_id = @me AND recipient_id = u.id)
         OR (sender_id = u.id AND recipient_id = @me)
      ORDER BY created_at DESC LIMIT 1
    )
    WHERE u.id <> @me
    ORDER BY m.created_at DESC
  `).all({ me: req.user.id });
  res.json(rows);
});

// GET /api/messages/:username — full conversation, marks messages as read
app.get('/api/messages/:username', auth, (req, res) => {
  const other = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?')
    .get(req.params.username);
  if (!other) return bad(res, 'User not found.', 404);

  // mark messages from them as read
  db.prepare(`UPDATE messages SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`)
    .run(other.id, req.user.id);

  const msgs = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.read_at,
           m.sender_id = @me AS is_mine,
           u.username, u.display_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE (m.sender_id = @me AND m.recipient_id = @other)
       OR (m.sender_id = @other AND m.recipient_id = @me)
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT 200
  `).all({ me: req.user.id, other: other.id });

  res.json({ user: other, messages: msgs.map(r => ({ ...r, is_mine: !!r.is_mine })) });
});

// POST /api/messages/:username — send a message (REST fallback; WS is primary)
app.post('/api/messages/:username', auth, (req, res) => {
  const other   = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?')
    .get(req.params.username);
  if (!other)                   return bad(res, 'User not found.', 404);
  if (other.id === req.user.id) return bad(res, "You can't message yourself.");
  const content = String(req.body.content || '').trim();
  if (!content)             return bad(res, 'Message cannot be empty.');
  if (content.length > 500) return bad(res, 'Messages are limited to 500 characters.');

  const info = db
    .prepare('INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)')
    .run(req.user.id, other.id, content);
  const msg = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.read_at,
           1 AS is_mine, u.username, u.display_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(info.lastInsertRowid);

  // push via WS to both parties
  wsBroadcastMessage(req.user.id, other.id, { ...msg, is_mine: true });

  res.status(201).json({ ...msg, is_mine: true });
});

// ----- Fallbacks -----
app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ============================================================
//  WebSocket server
// ============================================================

// Map: userId (number) → Set of WebSocket clients
const wsClients = new Map();

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // --- authenticate via ?token=... query param ---
  const url   = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');
  let userId;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(payload.id)) throw new Error('gone');
    userId = payload.id;
  } catch {
    ws.close(4001, 'Unauthorized');
    return;
  }

  // register client
  if (!wsClients.has(userId)) wsClients.set(userId, new Set());
  wsClients.get(userId).add(ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- type: "message" — send a DM ----
    if (msg.type === 'message') {
      const recipientUsername = String(msg.to || '').trim();
      const content           = String(msg.content || '').trim();
      if (!recipientUsername || !content || content.length > 500) return;

      const other = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?')
        .get(recipientUsername);
      if (!other || other.id === userId) return;

      const sender = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(userId);

      const info = db
        .prepare('INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)')
        .run(userId, other.id, content);
      const saved = db.prepare(`
        SELECT id, content, created_at, read_at FROM messages WHERE id = ?
      `).get(info.lastInsertRowid);

      wsBroadcastMessage(userId, other.id, {
        ...saved,
        username:     sender.username,
        display_name: sender.display_name,
      });
    }

    // ---- type: "read" — mark conversation as read ----
    if (msg.type === 'read') {
      const senderUsername = String(msg.from || '').trim();
      const sender = db.prepare('SELECT id FROM users WHERE username = ?').get(senderUsername);
      if (!sender) return;
      db.prepare(`UPDATE messages SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                  WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`)
        .run(sender.id, userId);
    }
  });

  ws.on('close', () => {
    wsClients.get(userId)?.delete(ws);
    if (wsClients.get(userId)?.size === 0) wsClients.delete(userId);
  });
});

/**
 * Push a message event to both the sender's and recipient's connected clients.
 * The `is_mine` flag is flipped for the recipient.
 */
function wsBroadcastMessage(senderId, recipientId, msgData) {
  const recipientUser = db.prepare('SELECT username FROM users WHERE id = ?').get(recipientId);
  const senderUser    = db.prepare('SELECT username FROM users WHERE id = ?').get(senderId);

  const baseEvent = { type: 'message', message: msgData };

  // send to sender's tabs — is_mine: true
  sendToUser(senderId, {
    ...baseEvent,
    message: { ...msgData, is_mine: true,  with: recipientUser.username },
  });

  // send to recipient's tabs — is_mine: false
  sendToUser(recipientId, {
    ...baseEvent,
    message: { ...msgData, is_mine: false, with: senderUser.username },
  });
}

function sendToUser(userId, payload) {
  const sockets = wsClients.get(userId);
  if (!sockets) return;
  const text = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

// ============================================================
server.listen(PORT, () => console.log(`GupShup running -> http://localhost:${PORT}`));
