'use strict';
// ROYAL PALACE 서버 (외부 라이브러리 없음, Node 18+)
// 저장소: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 이 설정되면 Redis(영구 저장),
//         없으면 data/users.json 파일(로컬 테스트용, Render 무료 플랜에서는 재시작 시 초기화됨)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const SESSION_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[\p{L}\p{N}_]+$/u; // 글자·숫자·_ (길이 제한 없음, 공백 불가)

// ---------- 게임 설정 ----------
const START_CHIPS = 10000, REFILL_CHIPS = 1000;
const MIN_BET = 100, MAX_BET = 100000, HISTORY_MAX = 30;
// 777 룰렛 배당: weight 합계 = 10000, 환수율(RTP) = 89.54%
const ROULETTE_TOTAL = 10000;
const ROULETTE = [
  { mult: 0,   weight: 5018 },
  { mult: 0.5, weight: 2200 },
  { mult: 1,   weight: 1100 },
  { mult: 2,   weight: 900 },
  { mult: 3,   weight: 450 },
  { mult: 5,   weight: 250 },
  { mult: 10,  weight: 80 },
  { mult: 777, weight: 2 }
];
if (ROULETTE.reduce((a, o) => a + o.weight, 0) !== ROULETTE_TOTAL) throw new Error('룰렛 확률 합계 오류');
function drawRoulette() {
  let n = crypto.randomInt(ROULETTE_TOTAL);
  for (const o of ROULETTE) { if (n < o.weight) return o; n -= o.weight; }
  return ROULETTE[0];
}

// ---------- 저장소 ----------
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const store = (REDIS_URL && REDIS_TOKEN) ? redisStore() : fileStore();

function fileStore() {
  const dir = path.join(__dirname, 'data'), file = path.join(dir, 'users.json');
  fs.mkdirSync(dir, { recursive: true });
  const db = Object.create(null); // '__proto__' 같은 아이디가 객체를 오염시키지 않도록
  try { Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* 새 DB */ }
  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    kind: 'file',
    async get(k) { return db[k] || null; },
    async create(k, u) { if (db[k]) return false; db[k] = u; save(); return true; },
    async put(k, u) { db[k] = u; save(); }
  };
}

function redisStore() {
  const cache = new Map(); // 같은 서버 안에서의 읽기 횟수 절약
  const K = k => 'rp:u:' + k;
  const remember = (k, u) => { if (cache.size > 2000) cache.clear(); cache.set(k, u); return u; };
  async function call(cmd) {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(8000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error('redis: ' + (j.error || r.status));
    return j.result;
  }
  return {
    kind: 'redis',
    async get(k) {
      if (cache.has(k)) return cache.get(k);
      const v = await call(['GET', K(k)]);
      return v ? remember(k, JSON.parse(v)) : null;
    },
    async create(k, u) {
      const ok = await call(['SET', K(k), JSON.stringify(u), 'NX']); // 이미 있으면 null
      if (ok !== 'OK') return false;
      remember(k, u); return true;
    },
    async put(k, u) {
      try { await call(['SET', K(k), JSON.stringify(u)]); remember(k, u); }
      catch (e) { cache.delete(k); throw e; }
    }
  };
}

function ensureGame(u) {
  if (typeof u.chips !== 'number') u.chips = START_CHIPS;
  if (!u.stats) u.stats = { spins: 0, wagered: 0, won: 0, biggestWin: 0, jackpots: 0 };
  if (!Array.isArray(u.history)) u.history = [];
  return u;
}

// ---------- 비밀번호 ----------
const hashPw = (pw, salt) => scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
const DUMMY_SALT = crypto.randomBytes(16); // 없는 아이디도 같은 연산 시간 소요

// ---------- 유틸 ----------
const sessions = new Map(); // token -> { name, key, exp }
const hits = new Map();     // `${ip}:${bucket}` -> { n, reset }
const locks = new Map();    // 사용자별 순차 처리(칩 계산 꼬임 방지)

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}
function limited(ip, bucket, max) {
  const k = ip + ':' + bucket, now = Date.now();
  let h = hits.get(k);
  if (!h || h.reset < now) { h = { n: 0, reset: now + 10 * 60 * 1000 }; hits.set(k, h); }
  return h.n >= max;
}
function addHit(ip, bucket) { const h = hits.get(ip + ':' + bucket); if (h) h.n++; }
function clientIp(req) { // Render 같은 프록시 뒤에서는 X-Forwarded-For 의 첫 값이 접속자
  const f = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return f || req.socket.remoteAddress || 'x';
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
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
function startSession(req, name, key) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { name, key, exp: Date.now() + SESSION_MS });
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `rp_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`;
}
const fmt = n => Number(n).toLocaleString('en-US');

// ---------- 정적 파일 (허용 목록만 제공: server.js, data/ 등은 노출되지 않음) ----------
const PAGES = {
  '/': 'index.html', '/index.html': 'index.html',
  '/lobby': 'lobby.html', '/lobby.html': 'lobby.html',
  '/roulette': 'roulette.html', '/roulette.html': 'roulette.html',
  '/theme.css': 'theme.css', '/app.js': 'app.js'
};
const PROTECTED = new Set(['lobby.html', 'roulette.html']); // 로그인 필요
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function findFile(name) {
  for (const d of [path.join(__dirname, 'public'), __dirname]) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function serveStatic(res, name) {
  const f = findFile(name);
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(500); return res.end('Server error'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
const redirect = (res, to) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };

// ---------- 라우터 ----------
async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");

  const url = req.url.split('?')[0];

  // 페이지
  if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(PAGES, url)) {
    const name = PAGES[url], s = getSession(req);
    if (name === 'index.html' && s) return redirect(res, '/lobby');
    if (PROTECTED.has(name) && !s) return redirect(res, '/');
    return serveStatic(res, name);
  }

  if (req.method === 'POST' && url === '/api/logout') {
    const t = cookie(req, 'rp_sid');
    if (t) sessions.delete(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'rp_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  // 로그인이 필요한 API
  if (url === '/api/me' || url === '/api/profile' || url.startsWith('/api/roulette') || url === '/api/refill') {
    const s = getSession(req);
    if (!s) return send(res, 401, { error: '로그인이 필요합니다.' });

    if (req.method === 'GET' && (url === '/api/me' || url === '/api/profile')) {
      const u = await store.get(s.key);
      if (!u) { sessions.delete(cookie(req, 'rp_sid')); return send(res, 401, { error: '계정을 찾을 수 없습니다. 다시 로그인해 주세요.' }); }
      ensureGame(u);
      return send(res, 200, { user: u.name, chips: u.chips, stats: u.stats, history: u.history.slice(0, 10) });
    }

    if (req.method === 'GET' && url === '/api/roulette/config')
      return send(res, 200, { outcomes: ROULETTE, total: ROULETTE_TOTAL, minBet: MIN_BET, maxBet: MAX_BET });

    if (req.method === 'POST' && url === '/api/roulette/spin') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: '잘못된 요청입니다.' }); }
      const bet = body.bet;
      if (!Number.isInteger(bet) || bet < MIN_BET || bet > MAX_BET)
        return send(res, 400, { error: `베팅은 ${fmt(MIN_BET)} ~ ${fmt(MAX_BET)} 칩 사이여야 합니다.` });
      const out = await withLock(s.key, async () => {
        const u = await store.get(s.key);
        if (!u) return { code: 401, body: { error: '계정을 찾을 수 없습니다. 다시 로그인해 주세요.' } };
        ensureGame(u);
        if (bet > u.chips) return { code: 400, body: { error: '칩이 부족합니다.' } };
        const o = drawRoulette();
        const payout = Math.floor(bet * o.mult), delta = payout - bet;
        u.chips += delta;
        u.stats.spins++; u.stats.wagered += bet; u.stats.won += payout;
        if (delta > u.stats.biggestWin) u.stats.biggestWin = delta;
        if (o.mult === 777) u.stats.jackpots++;
        u.history.unshift({ t: new Date().toISOString(), game: 'roulette', bet, mult: o.mult, delta });
        u.history.length = Math.min(u.history.length, HISTORY_MAX);
        await store.put(s.key, u);
        return { code: 200, body: { mult: o.mult, bet, payout, delta, chips: u.chips, jackpot: o.mult === 777 } };
      });
      return send(res, out.code, out.body);
    }

    if (req.method === 'POST' && url === '/api/refill') {
      const out = await withLock(s.key, async () => {
        const u = await store.get(s.key);
        if (!u) return { code: 401, body: { error: '계정을 찾을 수 없습니다. 다시 로그인해 주세요.' } };
        ensureGame(u);
        if (u.chips >= MIN_BET) return { code: 400, body: { error: '아직 칩이 남아 있습니다.' } };
        u.chips = REFILL_CHIPS;
        await store.put(s.key, u);
        return { code: 200, body: { chips: u.chips } };
      });
      return send(res, out.code, out.body);
    }
    return send(res, 404, { error: 'Not found' });
  }

  // 회원가입 / 로그인
  if (req.method === 'POST' && (url === '/api/register' || url === '/api/login')) {
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: '잘못된 요청입니다.' }); }
    const name = typeof body.username === 'string' ? body.username.trim().normalize('NFC') : '';
    const pw = typeof body.password === 'string' ? body.password : '';
    const key = name.toLowerCase();
    const addr = clientIp(req);

    if (url === '/api/register') {
      if (limited(addr, 'reg', 5)) return send(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
      addHit(addr, 'reg');
      if (!name || !ID_RE.test(name)) return send(res, 400, { field: 'username', error: '아이디는 글자, 숫자, _ 만 사용할 수 있습니다. (공백 불가)' });
      if (pw.length < 8 || pw.length > 64 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw))
        return send(res, 400, { field: 'password', error: '비밀번호는 영문과 숫자를 포함한 8~64자로 입력해 주세요.' });
      const salt = crypto.randomBytes(16);
      const hash = await hashPw(pw, salt);
      const user = ensureGame({ name, salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: new Date().toISOString() });
      if (!(await store.create(key, user)))
        return send(res, 409, { field: 'username', error: '이미 사용 중인 아이디입니다.' });
      return send(res, 201, { user: name }, { 'Set-Cookie': startSession(req, name, key) });
    }

    if (limited(addr, 'login', 10)) return send(res, 429, { error: '로그인 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.' });
    if (!name || !pw) return send(res, 400, { field: !name ? 'username' : 'password', error: !name ? '아이디를 입력해 주세요.' : '비밀번호를 입력해 주세요.' });
    const u = await store.get(key);
    const hash = await hashPw(pw.slice(0, 64), u ? Buffer.from(u.salt, 'hex') : DUMMY_SALT);
    const ok = u && crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'));
    if (!ok) { addHit(addr, 'login'); return send(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' }); }
    return send(res, 200, { user: u.name }, { 'Set-Cookie': startSession(req, u.name, key) });
  }

  res.writeHead(404); res.end('Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    else res.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ROYAL PALACE → http://localhost:${PORT}`);
  console.log(store.kind === 'redis'
    ? '저장소: Upstash Redis (영구 저장)'
    : '저장소: 로컬 파일 (Render 무료 플랜에서는 재시작 시 초기화됩니다)');
});
