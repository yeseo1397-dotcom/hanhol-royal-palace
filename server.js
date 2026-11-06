'use strict';
// ROYAL PALACE - 로그인 서버 (외부 라이브러리 없음, Node 18+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');
const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'users.json');
const SESSION_MS = 24 * 60 * 60 * 1000;

const ID_RE = /^[A-Za-z0-9_]{4,20}$/;
const sessions = new Map(); // token -> { name, exp }
const hits = new Map();     // `${ip}:${bucket}` -> { n, reset }

// ---------- 저장소 ----------
fs.mkdirSync(DB_DIR, { recursive: true });
let users = {};
try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { users = {}; }
function saveUsers() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

// ---------- 비밀번호 ----------
async function hashPw(pw, salt) {
  return scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
}
const DUMMY_SALT = crypto.randomBytes(16); // 존재하지 않는 아이디도 같은 연산 시간 소요

// ---------- 유틸 ----------
function limited(ip, bucket, max) {
  const k = ip + ':' + bucket, now = Date.now();
  let h = hits.get(k);
  if (!h || h.reset < now) { h = { n: 0, reset: now + 10 * 60 * 1000 }; hits.set(k, h); }
  return h.n >= max;
}
function addHit(ip, bucket) {
  const h = hits.get(ip + ':' + bucket);
  if (h) h.n++;
}
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return reject(new Error('type'));
    let data = '';
    req.on('data', c => { data += c; if (data.length > 4096) { reject(new Error('size')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('json')); } });
    req.on('error', reject);
  });
}
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}
function getSession(req) {
  const t = cookie(req, 'rp_sid');
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  return s;
}
function startSession(req, res, name) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { name, exp: Date.now() + SESSION_MS });
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `rp_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`;
}
const ip = req => req.socket.remoteAddress || 'x';

// ---------- 라우터 ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return fs.readFile(INDEX, (e, buf) => {
      if (e) { res.writeHead(500); return res.end('Server error'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  if (req.method === 'GET' && url === '/api/me') {
    const s = getSession(req);
    return send(res, 200, { user: s ? s.name : null });
  }

  if (req.method === 'POST' && url === '/api/logout') {
    const t = cookie(req, 'rp_sid');
    if (t) sessions.delete(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'rp_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (req.method === 'POST' && (url === '/api/register' || url === '/api/login')) {
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: '잘못된 요청입니다.' }); }
    const name = typeof body.username === 'string' ? body.username.trim() : '';
    const pw = typeof body.password === 'string' ? body.password : '';
    const key = name.toLowerCase();
    const addr = ip(req);

    if (url === '/api/register') {
      if (limited(addr, 'reg', 5)) return send(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
      addHit(addr, 'reg');
      if (!ID_RE.test(name)) return send(res, 400, { field: 'username', error: '아이디는 영문, 숫자, _ 조합 4~20자로 입력해 주세요.' });
      if (pw.length < 8 || pw.length > 64 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw))
        return send(res, 400, { field: 'password', error: '비밀번호는 영문과 숫자를 포함한 8~64자로 입력해 주세요.' });
      const salt = crypto.randomBytes(16);
      const hash = await hashPw(pw, salt);
      if (Object.prototype.hasOwnProperty.call(users, key))
        return send(res, 409, { field: 'username', error: '이미 사용 중인 아이디입니다.' });
      users[key] = { name, salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: new Date().toISOString() };
      saveUsers();
      return send(res, 201, { user: name }, { 'Set-Cookie': startSession(req, res, name) });
    }

    // 로그인
    if (limited(addr, 'login', 10)) return send(res, 429, { error: '로그인 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.' });
    if (!name || !pw) return send(res, 400, { field: !name ? 'username' : 'password', error: !name ? '아이디를 입력해 주세요.' : '비밀번호를 입력해 주세요.' });
    const u = Object.prototype.hasOwnProperty.call(users, key) ? users[key] : null;
    const salt = u ? Buffer.from(u.salt, 'hex') : DUMMY_SALT;
    const hash = await hashPw(pw.slice(0, 64), salt);
    const ok = u && crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'));
    if (!ok) { addHit(addr, 'login'); return send(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' }); }
    return send(res, 200, { user: u.name }, { 'Set-Cookie': startSession(req, res, u.name) });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`ROYAL PALACE → http://localhost:${PORT}`));
