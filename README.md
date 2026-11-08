# ROYAL PALACE

카지노 호텔 VIP 라운지 콘셉트의 게임 사이트. 외부 라이브러리 없이 Node.js 내장 모듈만 사용합니다.
(가상 칩으로만 즐기는 게임이며 실제 금전과 무관합니다.)

## 실행
```bash
npm start        # 또는 node server.js
```
`http://localhost:3000` 접속 (포트 변경: `PORT=8080 npm start`). Node 18 이상 필요.

## 파일 구조 (모두 루트에 두면 됩니다)
| 파일 | 설명 |
|---|---|
| `server.js` | 회원가입·로그인, 게임 API, 저장소 처리 |
| `index.html` | 로그인 / 회원가입 화면 |
| `lobby.html` | 로비 (LUCK 실력 무관 / SKILL 실력 관련, 내 기록) |
| `roulette.html` | 777 룰렛 (LUCK 카테고리) |
| `theme.css`, `app.js` | 모든 페이지 공통 디자인 / 공통 스크립트 |

새 게임을 추가할 때는 `roulette.html`처럼 페이지를 만들고, `server.js`의 `PAGES`에 주소를 등록한 뒤
`lobby.html`의 게임 목록에 카드를 추가합니다. 로그인이 필요한 페이지는 `PROTECTED`에 넣으세요.

## 데이터 저장 (중요)
회원 정보, 칩, 게임 기록은 서버 저장소에 보관됩니다.

- **Render 무료 플랜의 파일은 재시작·재배포·15분 유휴 절전 때마다 초기화**됩니다.
  그래서 배포 환경에서는 [Upstash Redis](https://upstash.com) (무료)를 연결해야 기록이 유지됩니다.
- Render 서비스의 Environment에 아래 두 값을 추가하면 자동으로 Redis를 사용합니다.

| Key | Value |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash 데이터베이스의 REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash 데이터베이스의 REST Token |

- 값이 없으면 `data/users.json` 파일에 저장합니다 (내 컴퓨터에서 테스트할 때용, Git에는 올라가지 않음).

## 777 룰렛
- 베팅 100 ~ 100,000 칩, 시작 칩 10,000 (칩이 100 미만이면 REFILL 1,000)
- 결과는 서버에서 `crypto.randomInt`로 정해지며 화면은 그 결과를 보여 줍니다.
- 배당표: ×0 50.18% / ×0.5 22% / ×1 11% / ×2 9% / ×3 4.5% / ×5 2.5% / ×10 0.8% / ×777 0.02%
- 기대 환수율 89.54%

## API
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/register` | 회원가입 (성공 시 자동 로그인) |
| POST | `/api/login` | 로그인 |
| POST | `/api/logout` | 로그아웃 |
| GET | `/api/me`, `/api/profile` | 내 정보 · 칩 · 통계 · 최근 기록 |
| GET | `/api/roulette/config` | 룰렛 배당 설정 |
| POST | `/api/roulette/spin` | 룰렛 실행 `{ "bet": 1000 }` |
| POST | `/api/refill` | 칩이 100 미만일 때 1,000칩 충전 |

## 규칙 / 보안
- 아이디: 글자·숫자·`_` (숫자만도 가능, 길이 제한 없음, 공백 불가) / 비밀번호: 영문+숫자 포함 8~64자
- 비밀번호는 scrypt + salt로 해시, 세션 쿠키는 HttpOnly + SameSite=Strict
- 허용 목록의 파일만 제공하므로 `server.js`, `data/` 등은 외부에 노출되지 않습니다.
- 세션은 서버 메모리에 있어서 서버가 재시작되면 다시 로그인해야 합니다 (칩·기록은 유지).
