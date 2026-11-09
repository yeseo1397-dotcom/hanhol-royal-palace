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
const APP_VERSION = '3'; // 화면 파일(app.js)과 같아야 합니다. 다르면 화면 위에 안내가 뜹니다.
const START_CHIPS = 1000; // 가입 시 1,000 코인
const MIN_BET = 10, MAX_BET = 100000, HISTORY_MAX = 30;
// 특정 계정에 딱 한 번 지급하는 보너스 코인. names = 아이디(대소문자 무시, 공백은 쓸 수 없음).
// 새 보너스를 줄 때는 id를 새로 지어 한 줄 추가하세요. (같은 id는 계정당 1번만 지급됩니다)
const GRANTS = [
  { id: 'bonus-1000-a', names: ['도박좋아'], amount: 1000 }
];
// 개발자 계정: 코인이 무한대이고, 다른 플레이어의 은행(대출) 역할을 합니다. (아이디, 대소문자 무시)
const DEV_NAMES = ['19'];
// 은행: 코인이 MIN_BET 미만일 때만 빌릴 수 있고, 이자는 없습니다.
const BANK_OPTIONS = [500, 1000, 5000], MAX_DEBT = 20000;
// 교환: 코인이 EXCHANGE_COST 이상이고 빚이 없을 때 교환권 1장으로 바꿀 수 있습니다.
const EXCHANGE_COST = 1000000;
const LEDGER_KEY = ' ledger'; // 공백이 있어서 아이디와 겹치지 않음 (개발자가 보는 대출 장부)
const isDev = u => DEV_NAMES.includes(String(u.name || '').toLowerCase());
const GAME_VERSION = 2; // 게임 규칙이 바뀌면 올려서 모두 새로 시작
// 777 룰렛(슬롯)
//  - 777 (릴 3개 모두 7): 확률 1/777, 지급 = 베팅액 x 50
//  - 같은 모양 2개:        777을 제외한 나머지 중 PAIR_PERMILLE/1000 의 확률, 지급 = 베팅액 x 3
//  - 그 외(세 릴이 모두 다른 모양): 꽝
const WIN_ODDS = 777, PAYOUT_MULT = 50, SYMBOL_COUNT = 6; // 심볼 0 = '7'
const PAIR_MULT = 3, PAIR_PERMILLE = 280;                 // 28%
const PAIR_CHANCE = (1 - 1 / WIN_ODDS) * PAIR_PERMILLE / 1000; // 전체 기준 같은 모양 2개 확률
function shuffle(a) { // 암호학적 난수로 섞기
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function drawSpin() {
  if (crypto.randomInt(WIN_ODDS) === 0) return { kind: 'jackpot', mult: PAYOUT_MULT, reels: [0, 0, 0] };
  if (crypto.randomInt(1000) < PAIR_PERMILLE) {
    const a = crypto.randomInt(SYMBOL_COUNT);
    let b; do { b = crypto.randomInt(SYMBOL_COUNT); } while (b === a);
    return { kind: 'pair', mult: PAIR_MULT, reels: shuffle([a, a, b]) };
  }
  const pool = shuffle([...Array(SYMBOL_COUNT).keys()]);
  return { kind: 'miss', mult: 0, reels: pool.slice(0, 3) };
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
  if (u.gv !== GAME_VERSION) { // 새 게임 규칙: 코인과 기록을 처음 상태로
    u.gv = GAME_VERSION; u.chips = START_CHIPS;
    u.stats = { spins: 0, wagered: 0, won: 0, biggestWin: 0, jackpots: 0, pairs: 0 };
    u.history = [];
  }
  if (u.stats.pairs === undefined) u.stats.pairs = 0;
  if (typeof u.debt !== 'number') u.debt = 0;
  if (typeof u.tickets !== 'number') u.tickets = 0;
  if (!Array.isArray(u.grants)) u.grants = [];
  const nm = String(u.name || '').toLowerCase();
  for (const g of GRANTS) {
    if (g.names.includes(nm) && !u.grants.includes(g.id)) { u.grants.push(g.id); u.chips += g.amount; }
  }
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
// 화면에 보내는 계정 요약 (개발자는 chips: null = 무한대)
const view = u => ({ user: u.name, dev: isDev(u), chips: isDev(u) ? null : u.chips, debt: u.debt, tickets: u.tickets,
  exchangeCost: EXCHANGE_COST, version: APP_VERSION });
// 개발자가 보는 대출 장부 (빚이 있는 사람만 기록)
function updateLedger(key, name, debt) {
  return withLock(LEDGER_KEY, async () => {
    const raw = (await store.get(LEDGER_KEY)) || {};
    const list = (Array.isArray(raw.debtors) ? raw.debtors : []).filter(d => d.key !== key);
    if (debt > 0) list.push({ key, name, debt });
    await store.put(LEDGER_KEY, { debtors: list });
  });
}
const notFound = { code: 401, body: { error: '계정을 찾을 수 없습니다. 다시 로그인해 주세요.' } };

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
  if (url === '/api/me' || url === '/api/profile' || url.startsWith('/api/roulette') || url.startsWith('/api/bank') || url === '/api/exchange') {
    const s = getSession(req);
    if (!s) return send(res, 401, { error: '로그인이 필요합니다.' });

    if (req.method === 'GET' && (url === '/api/me' || url === '/api/profile')) {
      const u = await store.get(s.key);
      if (!u) { sessions.delete(cookie(req, 'rp_sid')); return send(res, 401, { error: '계정을 찾을 수 없습니다. 다시 로그인해 주세요.' }); }
      ensureGame(u);
      return send(res, 200, { ...view(u), stats: u.stats, history: u.history.slice(0, 10) });
    }

    if (req.method === 'GET' && url === '/api/roulette/config')
      return send(res, 200, { winOdds: WIN_ODDS, payoutMult: PAYOUT_MULT, pairMult: PAIR_MULT, pairChance: PAIR_CHANCE, minBet: MIN_BET, maxBet: MAX_BET, symbols: SYMBOL_COUNT });

    if (req.method === 'POST' && url === '/api/roulette/spin') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: '잘못된 요청입니다.' }); }
      const bet = body.bet;
      if (!Number.isInteger(bet) || bet < MIN_BET || bet > MAX_BET)
        return send(res, 400, { error: `베팅은 ${fmt(MIN_BET)} ~ ${fmt(MAX_BET)} 코인 사이여야 합니다.` });
      const out = await withLock(s.key, async () => {
        const u = await store.get(s.key);
        if (!u) return { code: 401, body: { error: '계정을 찾을 수 없습니다. 다시 로그인해 주세요.' } };
        ensureGame(u);
        const dev = isDev(u);
        if (!dev && bet > u.chips) return { code: 400, body: { error: '코인이 부족합니다.' } };
        const r = drawSpin();
        const payout = bet * r.mult, delta = payout - bet;
        if (!dev) u.chips += delta;
        u.stats.spins++; u.stats.wagered += bet; u.stats.won += payout;
        if (delta > u.stats.biggestWin) u.stats.biggestWin = delta;
        if (r.kind === 'jackpot') u.stats.jackpots++;
        if (r.kind === 'pair') u.stats.pairs++;
        u.history.unshift({ t: new Date().toISOString(), game: 'roulette', bet, mult: r.mult, delta });
        u.history.length = Math.min(u.history.length, HISTORY_MAX);
        await store.put(s.key, u);
        return { code: 200, body: { reels: r.reels, kind: r.kind, mult: r.mult, bet, payout, delta, chips: dev ? null : u.chips, jackpot: r.kind === 'jackpot' } };
      });
      return send(res, out.code, out.body);
    }

    // ----- 은행 -----
    if (req.method === 'GET' && url === '/api/bank') {
      const u = await store.get(s.key);
      if (!u) return send(res, 401, notFound.body);
      ensureGame(u);
      if (isDev(u)) {
        const raw = (await store.get(LEDGER_KEY)) || {};
        const debtors = (Array.isArray(raw.debtors) ? raw.debtors : []).map(d => ({ name: d.name, debt: d.debt })).sort((a, b) => b.debt - a.debt);
        return send(res, 200, { dev: true, debtors, total: debtors.reduce((a, d) => a + d.debt, 0) });
      }
      return send(res, 200, { dev: false, chips: u.chips, debt: u.debt, options: BANK_OPTIONS, maxDebt: MAX_DEBT, minBet: MIN_BET });
    }

    if (req.method === 'POST' && url === '/api/bank/borrow') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: '잘못된 요청입니다.' }); }
      const amt = body.amount;
      if (!BANK_OPTIONS.includes(amt)) return send(res, 400, { error: '대출 금액이 올바르지 않습니다.' });
      const out = await withLock(s.key, async () => {
        const u = await store.get(s.key);
        if (!u) return notFound;
        ensureGame(u);
        if (isDev(u)) return { code: 400, body: { error: '개발자 계정은 코인이 무한대라 빌릴 필요가 없습니다.' } };
        if (u.chips >= MIN_BET) return { code: 400, body: { error: `코인이 ${fmt(MIN_BET)} 미만일 때만 빌릴 수 있습니다.` } };
        if (u.debt + amt > MAX_DEBT) return { code: 400, body: { error: `빚은 최대 ${fmt(MAX_DEBT)} 코인까지입니다. 먼저 갚아 주세요.` } };
        u.chips += amt; u.debt += amt;
        await store.put(s.key, u);
        try { await updateLedger(s.key, u.name, u.debt); } catch (e) { console.error('ledger', e); }
        return { code: 200, body: { chips: u.chips, debt: u.debt } };
      });
      return send(res, out.code, out.body);
    }

    if (req.method === 'POST' && url === '/api/bank/repay') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: '잘못된 요청입니다.' }); }
      if (!Number.isInteger(body.amount) || body.amount < 1) return send(res, 400, { error: '갚을 금액을 1 이상의 정수로 입력해 주세요.' });
      const out = await withLock(s.key, async () => {
        const u = await store.get(s.key);
        if (!u) return notFound;
        ensureGame(u);
        if (u.debt <= 0) return { code: 400, body: { error: '갚을 빚이 없습니다.' } };
        const amt = Math.min(body.amount, u.debt);
        if (isDev(u) || amt > u.chips) return { code: 400, body: { error: '코인이 부족합니다.' } };
        u.chips -= amt; u.debt -= amt;
        await store.put(s.key, u);
        try { await updateLedger(s.key, u.name, u.debt); } catch (e) { console.error('ledger', e); }
        return { code: 200, body: { chips: u.chips, debt: u.debt, repaid: amt } };
      });
      return send(res, out.code, out.body);
    }

    // ----- 교환 (코인 100만 → 교환권 1장) -----
    if (req.method === 'POST' && url === '/api/exchange') {
      const out = await withLock(s.key, async () => {
        const u = await store.get(s.key);
        if (!u) return notFound;
        ensureGame(u);
        const dev = isDev(u);
        if (!dev) {
          if (u.debt > 0) return { code: 400, body: { error: '빚을 모두 갚아야 교환할 수 있습니다.' } };
          if (u.chips < EXCHANGE_COST) return { code: 400, body: { error: `교환은 ${fmt(EXCHANGE_COST)} 코인부터 가능합니다.` } };
          u.chips -= EXCHANGE_COST;
        }
        u.tickets++;
        await store.put(s.key, u);
        return { code: 200, body: { chips: dev ? null : u.chips, tickets: u.tickets } };
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
