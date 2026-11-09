/* ROYAL PALACE 공통 스크립트 (로비·게임 페이지 공용) */
(function () {
  'use strict';

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
    '<circle cx="60" cy="8" r="5" fill="#9b1b30"/></svg>ROYAL PALACE</a>' +
    '<div class="bar-right"><span class="who" id="rp-who"></span>' +
    '<span class="chips" title="보유 코인"><i class="chip-ico"></i><b id="rp-chips">–</b></span>' +
    '<button class="mini" id="rp-out" type="button">LOGOUT</button></div></header>';

  document.body.insertAdjacentHTML('afterbegin', STAGE + BAR);

  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var shown = 0, tween = null;

  var RP = {
    profile: null,
    reduceMotion: reduce,

    fmt: function (n) { return Number(n).toLocaleString('en-US'); },

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

    // 상단 칩 표시 (숫자가 올라가거나 내려가는 효과)
    setChips: function (n, instant) {
      var box = document.getElementById('rp-chips');
      if (tween) cancelAnimationFrame(tween);
      if (instant || reduce || n === shown) { shown = n; box.textContent = RP.fmt(n); return; }
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
        RP.profile = r.d;
        document.getElementById('rp-who').textContent = r.d.user;
        RP.setChips(r.d.chips, true);
        cb(r.d);
      }).catch(function () {
        document.getElementById('rp-who').textContent = '서버 연결 실패';
      });
    }
  };

  document.getElementById('rp-out').addEventListener('click', function () {
    RP.api('/api/logout', {}).then(function () { location.replace('/?out=1'); });
  });

  window.RP = RP;
})();
