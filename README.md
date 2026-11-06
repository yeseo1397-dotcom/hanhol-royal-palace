# ROYAL PALACE

카지노 호텔 VIP 라운지 콘셉트의 로그인 화면 (회원가입 / 로그인 / 로그아웃).
외부 라이브러리 없이 Node.js 내장 모듈만 사용합니다.

## 실행
```bash
npm start        # 또는 node server.js
```
`http://localhost:3000` 접속 (포트 변경: `PORT=8080 npm start`). Node 18 이상 필요.

## 구조
- `server.js` : 회원가입·로그인 API, scrypt 해시, 세션 쿠키, 요청 제한
- `public/index.html` : 로그인 화면 (HTML + CSS + JS)
- `data/users.json` : 실행 시 자동 생성되는 회원 정보 (Git 제외)

## API
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/register` | 회원가입 (성공 시 자동 로그인) |
| POST | `/api/login` | 로그인 |
| POST | `/api/logout` | 로그아웃 |
| GET | `/api/me` | 현재 로그인 사용자 |

## 참고
- 아이디: 영문·숫자·`_` 4~20자 / 비밀번호: 영문+숫자 포함 8~64자
- HTTPS 프록시 뒤에서 운영하면 `X-Forwarded-Proto: https`로 쿠키에 Secure가 붙습니다.
- 세션은 메모리 저장이라 서버 재시작 시 로그아웃됩니다.
