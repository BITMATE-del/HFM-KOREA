# 2. 대상 HTS 기존 기능 및 기술 구조 분석서
작성일: 2026-11-19
대상: [BITMATE-del/HFM-KOREA](https://github.com/BITMATE-del/HFM-KOREA) 현행 Electron 데스크톱 + 운영 웹/거래 서버.
원칙: **코드 수정·DB 마이그레이션·시세 공급 교체·체결 규칙 변경 금지** (이번 분석 단계).

## 1) 코드에서 확인된 구성
| 계층 | 위치 | 역할 |
|---|---|---|
| 데스크톱 패키지 | `desktop/package.json` | Electron 45.3.4, electron-builder 26.18.0; 버전 0.2.0; NSIS + portable; 윈도우 빌드 |
| 프로그램 메인 | `desktop/main.js` | BrowserWindow, 3종 WebContentsView, 로그인 감지, 독립 창, 시장 변경/종목 동기화 IPC |
| 화면 프레임 | `desktop/workspace.html`, `desktop/workspace.js` | 상단 시장 메뉴, 좌측 종목 선택, 차트·주문·포지션 슬롯, 리사이즈/레이아웃 |
| 화면 분리 스타일 | `desktop/layout.cjs` | 기존 WTS의 영역을 각 패널에서 조건부 표시/숨김, 심볼 선택 스크립트 |
| 보안 브리지 | `desktop/preload.js`, `desktop/config.cjs` | 제한된 IPC, 거래 서버 도메인 허용 목록, 종목 검색 호출 |
| 인증/기본 서비스 | `app-api.js` | 회원 로그인/로그아웃, 세션, 계정, 공지, 지원, 관리자 일부 |
| 서버 진입점 | `server.js` | 인증/체결/자산/시세 라우터 조립 및 웹 정적 자원 제공 |
| 선물 내부 체결 | `futures-internal-engine.js`, `settlement-core.js` | 자체 선물 주문/포지션/증거금/정산. 외부 거래소 실주문 기능 아님 |
| 국내주식 내부 체결 | `stock-internal-engine.js`, `stock-directory.js` | 주문 검증·서버 시세 검사·보유 주식·원장·멱등 처리 |
| 잔고/입출금 | `funding-api.js` | 지갑/입출금 요청/상태와 계좌 자산 흐름 |
| 기타 거래 상태 | `trading-api.js` | 거래 상태, 보류 주문, 기존 조회·관리 처리. 내부 체결 엔진과 혼동 금지 |
| WTS 표현 | `index.html`, `hfm-*.css`, `hfm-market-chart.js` | 기존 웹 화면 및 차트 표시 |
| Windows 빌드 | `.github/workflows/desktop-hts-windows.yml` | `npm test` + 설치형/portable EXE 빌드 + Actions Artifact 등록 |

## 2) 현재 HTS 프로그램 흐름
1. `workspace.html`을 **로컬 프레임**으로 띄운다.
2. 차트 WebContentsView가 기존 거래 서버 `https://hfm-futures-web-production.up.railway.app/`을 열어 로그인한다.
3. 로그인 상태를 확인하면 주문/포지션용 WebContentsView를 생성하여 동일한 사이트를 각 화면에 로드한다.
4. `layout.cjs`의 CSS로 패널별 불필요한 WTS 영역을 가린다. 종목·페이지 이동은 메인 프로세스에서 제한된 JS/IPC로 전달한다.
5. '별도 창'도 새 BrowserWindow에 같은 서버 페이지를 로드하는 구조다.
6. 따라서 거래 로직은 Electron에 있지 않다. **기존 웹 API가 회원 인증, 주문과 잔고 정산을 수행한다.**

## 3) 기존 기능 보존 대상
- 로그인/세션/회원 계정
- 선물: 시장가·지정가 주문, 취소, 보유 포지션/손익/청산, 수수료·증거금 및 원장
- 국내주식: 종목 검색/정보, 시장가 내부 체결, 매수·매도, 주식 보유/잔고/체결 내역
- 기존 웹 차트, 시세 공급자, 요청·검증 타이밍
- 지갑, 입출금, 관리자, 공지, 고객센터 및 기존 특화 기능
- 실제 DB 구조 및 모든 기존 회원·잔고·주문·체결 기록
- 서버의 입력 검증/멱등성/감사 기록/권한 검사

주의: 본 보고서는 각 기능이 *소스에 존재하는 것*을 확인한 것이며 실제 Windows에서 모든 기능이 정상 동작한다고 보증하지 않는다. 대상에서 국내주식 지정가가 선물과 동일한 내부 자동체결로 구현되었다고 가정하지 않는다.

## 4) 실제 API 분리 — 소스에서 확인한 경로
| 항목 | 경로 / 모듈 | 주의 |
|---|---|---|
| 로그인·세션 | `/api/auth/login`, `/api/auth/me` (`app-api.js`) | 기존 쿠키/인증 구조 유지 |
| 거래/계정 상태 | `/api/trading/state` (`trading-api.js`) | 기존 보류 주문 상태와 신규 내부 체결 상태 구분 |
| 해외선물 주문 | `/api/futures/internal/order` | 서버 검증/원장 유지 |
| 해외선물 취소 | `/api/futures/internal/cancel` | 기존 내부 엔진 사용 |
| 해외선물 상태 | `/api/futures/internal/state` | 포지션·주문 동기화 |
| 국내주식 주문 | `/api/stocks/internal` | 서버 시세 유효성/시장 운영 시간/보유 잔고 검사 |
| 국내주식 종목 조회 | `/api/stocks/catalog` | Electron 종목 검색 브리지에서 사용 |
| 지갑/입출금 | `/api/wallet/... ` (`funding-api.js`) | 기존 승인·계정 및 원장 조건 보존 |
| 공지/고객센터 | `/api/notices`, `/api/support/messages` | 화면 재배치만 |

이 경로 외 다른 세부 응답 필드는 UI를 고치기 전 호출 부분과 원본 타입을 추가 점검한다.

## 5) 현재 문제점과 검증 상태
- 종전 Windows 스크린샷에서 각 독립 View에 웹사이트 헤더/계좌 요약/차트/주문 섹션이 중복으로 보이는 현상이 발생한 이력이 있다.
- 독립 View는 서로 다른 DOM·렌더 주기를 가지며, 페이지 변경·종목 변경·로그인 갱신 시 동기화가 지연될 수 있다.
- 별도 창에서 종목 동기화, 인증 세션, 주문 확인 모달의 가시성/초점·재사용 시 동작을 실기기로 확인해야 한다.
- 최근 `desktop/layout.cjs`/ `desktop/main.js`에서 CSS 격리 및 인증 동기화 수정이 있었지만, 실기기 화면 검증 완료를 의미하지 않는다.
- 일부 웹 선물 표시 호가의 10단계 잔량은 프런트 표현용이고, 서버 내부 체결에는 L1 기준 가격 검증을 사용한다. 표시 데이터를 실제 거래소 L2 잔량처럼 간주하면 안 된다.
- 서버 내부 체결 엔진의 거래 데이터는 외부 거래소 실주문이 아니다. 기존 설계와 무관하게 이를 바꾸지 않는다.

## 6) 자동 업데이트 현황 — 중요 결론
- `desktop/package.json` 버전: `0.2.0`.
- `desktop/package.json`에 `electron-updater` 의존성이 없음.
- `desktop/main.js`에 `autoUpdater` / `checkForUpdates` / 다운로드 완료 처리 없음.
- Windows 워크플로는 `--publish never`, `permissions: contents: read`이며 **GitHub Actions Artifact에 EXE만 보관**한다.
- 대상 저장소 GitHub Releases 조회 결과 현재 게시된 릴리스가 없음(확인 시점).
- **따라서 현재 대상 HTS는 '자동 업데이트 미구현'**. 설치 파일의 생성 성공과 프로그램 내부 자동 업데이트는 별개다.
- VELTRO 쪽 `electron-updater`/Releases 메커니즘은 참조 사례일 뿐, 대상의 배포 소유자/저장소/서명 정책을 우선 확정해야 한다.

## 7) 개발·테스트 안전 기준
- UI 전용 변경 파일: `desktop/workspace.html`, `desktop/workspace.js`, `desktop/layout.cjs`, 필요 시 Electron 창 배치만 `desktop/main.js`.
- 수정 금지(별도 명시 승인 전): 서버·체결·지갑·DB·회원정보·시세 공급 코드.
- 소스 자동 테스트 → WTS·HTS DOM 격리 검증 → Windows 설치/로그인/작동 테스트 → 실 주문 의도 확인(테스트 사용자) → 업데이트 실기기 테스트 순서.
- 프로그램 자동업데이트는 서명/HTTPS/무결성/릴리스 파일/오프라인 복구 검증 후 별도 구현하며, 거래 중 강제 종료를 기본으로 하지 않는다.
