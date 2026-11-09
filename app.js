/* ROYAL PALACE 공통 스크립트 (로비·게임 페이지 공용) */
(function () {
  'use strict';

  var VERSION = '3'; // server.js 의 APP_VERSION 과 같아야 합니다

  var STAGE =
    '<div class="stage" aria-hidden="true">' +
    '<div class="col l"></div><div class="col r"></div><div class="arch"></div><div class="marble"></div>' +
    '<div class="lights"></div><div class="floor"></div>' +
    '<span class="suit g" style="left:7%;top:16%;font-size:64px;--r:-12deg">♠</span>' +
    '<span class="suit b" style="right:8%;top:22%;font-size:78px;--r:10deg;animation-delay:-3s">♥</span>' +
    '<span class="suit b" style="left:13%;bottom:22%;font-size:56px;--r:8deg;animation-delay:-5s">♦</span>' +
    '<span class="suit g" style="right:12%;bottom:18%;font-size:70px;--r:-9deg;animation-delay:-2s">♣</span>' +
    '<div class="vig"></div></div>';

  var BAR =
    '<header class="bar">' +
    '<a class="bar-logo" href="/lobby" aria-label="로비로 이동">' +
    '<svg viewBox="0 0 120 80" aria-hidden="true"><defs><linearGradient id="cg2" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#8a6a1c"/><stop offset=".45" stop-color="#f6e3a1"/><stop offset="1" stop-color="#b8922a"/></linearGradient></defs>' +
    '<path d="M10 64 L6 22 L34 42 L60 8 L86 42 L114 22 L110 64 Z" fill="url(#cg2)" stroke="#f6e3a1" stroke-width="2" stroke-linejoin="round"/>' +
    '<rect x="10" y="64" width="100" height="9" rx="2" fill="url(#cg2)" stroke="#f6e3a1" stroke-width="2"/>' +
    '<circle cx="60" cy="8" r="5" fill="#9b1b30"/></svg><span class="lt">ROYAL PALACE</span></a>' +
    '<div class="bar-right"><span class="who" id="rp-who"></span>' +
    '<button class="bank-btn" id="rp-bank" type="button" aria-haspopup="dialog" title="은행 (빌리기 · 갚기)">BANK<i class="alert-dot" id="rp-dot" hidden></i></button>' +
    '<button class="chips" id="rp-wallet" type="button" aria-haspopup="dialog" title="내 지갑 열기"><i class="chip-ico"></i><b id="rp-chips">–</b></button>' +
    '<button class="mini" id="rp-out" type="button">LOGOUT</button></div></header>' +
    '<div class="ver-warn" id="rp-warn" role="alert" hidden></div>';

  document.body.insertAdjacentHTML('afterbegin', STAGE + BAR);

  var $ = function (s) { return document.querySelector(s); };
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var shown = 0, tween = null;

  // 내 계정 상태 (개발자는 chips = Infinity)
  var S = { user: '', dev: false, chips: 0, debt: 0, tickets: 0, cost: 1000000, minBet: 10 };

  var RP = {
    version: VERSION,
    state: S,
    reduceMotion: reduce,
    onChips: null, // 페이지가 코인 변화를 알고 싶을 때 지정 (은행/교환 후 호출됨)

    fmt: function (n) { return isFinite(n) ? Number(n).toLocaleString('en-US') : '∞'; },
    coins: function (v) { return (v === null || v === undefined) ? Infinity : v; },

    // GET (body 없음) / POST (body 있음). 401이면 로그인 화면으로 이동
    api: function (path, body) {
      var opt = { credentials: 'same-origin' };
      if (body !== undefined) {
        opt.method = 'POST';
        opt.headers = { 'Content-Type': 'application/json' };
        opt.body = JSON.stringify(body);
      }
      return fetch(path, opt).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.status === 401) location.replace('/');
          return { ok: r.ok, status: r.status, d: d };
        });
      });
    },

    // 상단 코인 표시 (숫자가 올라가거나 내려가는 효과)
    setChips: function (n, instant) {
      var box = $('#rp-chips');
      if (tween) cancelAnimationFrame(tween);
      S.chips = n; refreshBar();
      if (!isFinite(n) || !isFinite(shown) || instant || reduce || n === shown) { shown = n; box.textContent = RP.fmt(n); return; }
      var from = shown, t0 = performance.now(), dur = 700;
      (function step(t) {
        var p = Math.min(1, (t - t0) / dur);
        shown = Math.round(from + (n - from) * (1 - Math.pow(1 - p, 3)));
        box.textContent = RP.fmt(shown);
        if (p < 1) tween = requestAnimationFrame(step); else shown = n;
      })(t0);
    },

    ago: function (iso) {
      var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return '방금 전';
      if (s < 3600) return Math.floor(s / 60) + '분 전';
      if (s < 86400) return Math.floor(s / 3600) + '시간 전';
      if (s < 86400 * 7) return Math.floor(s / 86400) + '일 전';
      var d = new Date(iso);
      return d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate();
    },

    // 프로필을 불러와 상단바를 채운 뒤 콜백 실행
    ready: function (cb) {
      RP.api('/api/profile').then(function (r) {
        if (!r.ok) return;
        var d = r.d;
        RP.profile = d;
        S.user = d.user; S.dev = !!d.dev; S.debt = d.debt || 0; S.tickets = d.tickets || 0; S.cost = d.exchangeCost || S.cost;
        RP.setChips(RP.coins(d.chips), true);
        if (d.version !== VERSION) {
          var w = $('#rp-warn');
          w.textContent = '일부 파일이 최신 버전이 아닙니다 (화면 v' + VERSION + ' / 서버 v' + d.version +
            '). GitHub에 모든 파일을 올렸는지, Render 배포가 Live인지 확인해 주세요.';
          w.hidden = false;
        }
        cb(d);
      }).catch(function () {
        $('#rp-who').textContent = '서버 연결 실패';
      });
    }
  };

  // 은행/교환 응답을 상태와 화면에 반영
  function apply(v) {
    if ('debt' in v) S.debt = v.debt;
    if ('tickets' in v) S.tickets = v.tickets;
    if ('chips' in v) RP.setChips(RP.coins(v.chips)); else refreshBar();
    if (RP.onChips) RP.onChips(S.chips);
  }

  function refreshBar() {
    var who = $('#rp-who');
    if (S.user) {
      who.textContent = S.user;
      if (S.dev) { var b = document.createElement('em'); b.className = 'dev-badge'; b.textContent = 'DEV'; who.appendChild(b); }
    }
    // 빚이 있거나 코인이 바닥이면 BANK 버튼에 빨간 점
    $('#rp-dot').hidden = !(!S.dev && S.user && (S.debt > 0 || S.chips < S.minBet));
  }

  // ---------- 팝업 ----------
  var active = null, lastFocus = null;
  function closeModal() {
    if (!active) return;
    active.remove(); active = null;
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }
  function openModal(title) {
    closeModal();
    lastFocus = document.activeElement;
    var back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = '<div class="modal panel" role="dialog" aria-modal="true" aria-labelledby="m-title">' +
      '<button class="m-x" type="button" aria-label="닫기">×</button><h2 id="m-title"></h2><div class="m-body"></div></div>';
    back.querySelector('#m-title').textContent = title;
    back.addEventListener('mousedown', function (e) { if (e.target === back) closeModal(); });
    back.querySelector('.m-x').addEventListener('click', closeModal);
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey);
    active = back;
    back.querySelector('.m-x').focus();
    return back.querySelector('.m-body');
  }
  function set(root, sel, text) { root.querySelector(sel).textContent = text; }

  // ----- 지갑: 코인 확인 + 교환하기 (100만 코인 이상일 때 활성화) -----
  RP.openWallet = function () {
    var body = openModal('MY WALLET'), msg = '', busy = false;
    function draw() {
      var inf = !isFinite(S.chips);
      var canEx = S.dev || (!inf && S.chips >= S.cost && S.debt === 0);
      var pct = inf ? 100 : Math.min(100, S.chips / S.cost * 100);
      var note;
      if (S.dev) note = '개발자 계정은 코인이 무한대라 비용 없이 교환을 시험할 수 있어요.';
      else if (S.debt > 0) note = '빚을 모두 갚으면 교환할 수 있어요. (BANK에서 갚기)';
      else if (S.chips < S.cost) note = RP.fmt(S.cost) + ' 코인 이상이면 교환할 수 있어요. (' + RP.fmt(S.cost - S.chips) + ' 남음)';
      else note = '교환하면 ' + RP.fmt(S.cost) + ' 코인이 교환권 1장으로 바뀌어요.';
      body.innerHTML =
        '<div class="w-big"><i class="chip-ico big"></i><b id="w-c"></b></div>' +
        (S.dev ? '<div class="w-dev">DEVELOPER · UNLIMITED</div>' : '') +
        '<div class="pg" aria-hidden="true"><i style="width:' + pct + '%"></i></div>' +
        '<dl class="m-dl"><dt>빚</dt><dd id="w-d"></dd><dt>교환권</dt><dd id="w-t"></dd></dl>' +
        '<button class="btn gold" id="w-ex" type="button">교환하기</button>' +
        '<p class="m-note" id="w-n"></p>';
      set(body, '#w-c', RP.fmt(S.chips));
      set(body, '#w-d', RP.fmt(S.debt));
      body.querySelector('#w-d').className = S.debt > 0 ? 'debt' : '';
      set(body, '#w-t', RP.fmt(S.tickets) + '장');
      set(body, '#w-n', msg || note);
      var ex = body.querySelector('#w-ex');
      ex.disabled = !canEx || busy;
      ex.addEventListener('click', function () {
        busy = true; ex.disabled = true;
        RP.api('/api/exchange', {}).then(function (r) {
          busy = false;
          if (!r.ok) { msg = r.d.error || '교환하지 못했습니다.'; draw(); return; }
          apply(r.d); msg = '교환권 1장을 받았어요!'; draw();
        }).catch(function () { busy = false; msg = '서버에 연결할 수 없습니다.'; draw(); });
      });
    }
    draw();
  };

  // ----- 은행: 코인이 바닥나면 개발자에게서 빌리고, 갚기 -----
  RP.openBank = function () {
    var body = openModal('BANK');
    body.innerHTML = '<p class="m-note">불러오는 중…</p>';
    RP.api('/api/bank').then(function (r) {
      if (!r.ok) { body.innerHTML = '<p class="m-note">은행 정보를 불러오지 못했습니다.</p>'; return; }
      if (r.d.dev) drawDev(r.d); else drawPlayer(r.d);
    }).catch(function () { body.innerHTML = '<p class="m-note">서버에 연결할 수 없습니다.</p>'; });

    function drawDev(d) {
      body.innerHTML =
        '<p class="m-lead">개발자 은행입니다.<br>코인이 바닥난 플레이어의 대출은 자동으로 승인됩니다.</p>' +
        '<dl class="m-dl"><dt>빌려간 사람</dt><dd id="d-n"></dd><dt>대출 잔액 합계</dt><dd id="d-t" class="debt"></dd></dl>' +
        '<ul class="debtors" id="d-l"></ul>';
      set(body, '#d-n', d.debtors.length + '명');
      set(body, '#d-t', RP.fmt(d.total));
      var ul = body.querySelector('#d-l');
      if (!d.debtors.length) { ul.innerHTML = '<li><span>아직 빌려간 사람이 없습니다.</span></li>'; return; }
      d.debtors.forEach(function (x) {
        var li = document.createElement('li');
        li.innerHTML = '<span></span><b></b>';
        li.firstChild.textContent = x.name; li.lastChild.textContent = RP.fmt(x.debt);
        ul.appendChild(li);
      });
    }

    function drawPlayer(d) {
      var msg = '', err = false, busy = false;
      function draw() {
        var broke = d.chips < d.minBet;
        body.innerHTML =
          '<dl class="m-dl"><dt>보유 코인</dt><dd id="b-c"></dd><dt>내 빚</dt><dd id="b-d"></dd><dt>빚 한도</dt><dd id="b-m"></dd></dl>' +
          '<h3>BORROW · 빌리기</h3><div class="m-opts" id="b-o"></div>' +
          '<p class="m-note">코인이 ' + RP.fmt(d.minBet) + ' 미만일 때만 빌릴 수 있어요. 이자는 없어요.</p>' +
          '<h3>REPAY · 갚기</h3>' +
          '<div class="m-repay"><input id="b-amt" type="number" min="1" inputmode="numeric" placeholder="갚을 금액">' +
          '<button class="mini" id="b-all" type="button">전액</button><button class="mini gold" id="b-pay" type="button">갚기</button></div>' +
          '<p class="m-msg" id="b-msg" role="status"></p>';
        set(body, '#b-c', RP.fmt(d.chips));
        set(body, '#b-d', RP.fmt(d.debt));
        body.querySelector('#b-d').className = d.debt > 0 ? 'debt' : '';
        set(body, '#b-m', RP.fmt(d.maxDebt));
        var m = body.querySelector('#b-msg'); m.textContent = msg; m.className = 'm-msg' + (err ? ' err' : '');

        var opts = body.querySelector('#b-o');
        d.options.forEach(function (a) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'm-opt'; b.textContent = RP.fmt(a);
          b.disabled = busy || !broke || d.debt + a > d.maxDebt;
          b.addEventListener('click', function () { call('/api/bank/borrow', { amount: a }, RP.fmt(a) + ' 코인을 빌렸어요. 잊지 말고 갚아 주세요!'); });
          opts.appendChild(b);
        });

        var amt = body.querySelector('#b-amt'), pay = body.querySelector('#b-pay'), all = body.querySelector('#b-all');
        var can = d.debt > 0 && d.chips > 0 && !busy;
        amt.disabled = pay.disabled = all.disabled = !can;
        all.addEventListener('click', function () { amt.value = Math.min(d.debt, d.chips); amt.focus(); });
        function doPay() {
          var v = parseInt(amt.value, 10);
          if (!(v >= 1)) { msg = '갚을 금액을 입력해 주세요.'; err = true; draw(); return; }
          call('/api/bank/repay', { amount: v }, null);
        }
        pay.addEventListener('click', doPay);
        amt.addEventListener('keydown', function (e) { if (e.key === 'Enter') doPay(); });
      }
      function call(path, payload, okText) {
        busy = true; draw();
        RP.api(path, payload).then(function (r) {
          busy = false;
          if (!r.ok) { msg = r.d.error || '처리하지 못했습니다.'; err = true; draw(); return; }
          d.chips = r.d.chips; d.debt = r.d.debt; err = false;
          msg = okText || (RP.fmt(r.d.repaid) + ' 코인을 갚았어요.' + (r.d.debt === 0 ? ' 빚을 모두 갚았어요!' : ''));
          apply(r.d); draw();
        }).catch(function () { busy = false; msg = '서버에 연결할 수 없습니다.'; err = true; draw(); });
      }
      draw();
    }
  };

  $('#rp-bank').addEventListener('click', RP.openBank);
  $('#rp-wallet').addEventListener('click', RP.openWallet);
  $('#rp-out').addEventListener('click', function () {
    RP.api('/api/logout', {}).then(function () { location.replace('/?out=1'); });
  });

  window.RP = RP;
})();
