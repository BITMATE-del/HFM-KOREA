# VELTRO HTS — Windows 데스크톱

현재 `HFM-KOREA` 운영 WTS를 기반으로 실행하는 Windows 데스크톱 HTS 1차 버전입니다.
데스크톱 앱과 서버 체결엔진은 분리되어 있습니다. 기존 회원정보·시세·주문 API를
Electron 프로세스에 복제하지 않으며, **기존 운영 사이트에 HTTPS로 접속**합니다.

## 포함된 기능
- Windows 전용 독립 창, 작업 표시줄 등록, 단일 실행(중복 창 방지)
- 기존 회원 로그인 세션 / 해외선물 / 국내주식 / 차트 / 포지션 / 입출금 화면 공유
- 거래 메뉴와 단축키: Ctrl+1 해외선물, Ctrl+2 국내주식, Ctrl+3 시세,
  Ctrl+4 주문·포지션, Ctrl+5 지갑
- F5 새로고침, Ctrl+Shift+R 서버 재연결, F11 전체 화면
- 서버 연결 끊김 시 한국어 재연결 화면
- 외부 웹사이트 임의 탐색 방지, Node.js 브라우저 접근 차단,
  sandbox + context isolation, 불필요한 사이트 권한 차단

## 윈도우에서 실행
Node.js 24 이상 권장:

```powershell
cd desktop
npm install
npm test
npm start
```

## Windows 설치 프로그램 및 무설치 EXE
```powershell
cd desktop
npm install
npm run dist:win
```

출력 파일:
- `dist/VELTRO-HTS-Setup-0.1.0-x64.exe` — 설치형
- `dist/VELTRO-HTS-Portable-0.1.0-x64.exe` — 무설치형

GitHub Actions의 **VELTRO HTS Windows** 워크플로가 윈도우 빌드를
수행한 후 `VELTRO-HTS-Windows`라는 빌드 아티팩트로 EXE를 보관합니다.
커밋 또는 수동 실행으로 빌드하며 웹 Railway 운영 서버를 재배포하지 않습니다.

## 배포·운영 참고
- 운영 URL: https://hfm-futures-web-production.up.railway.app/
- 데스크톱 앱은 서버에 직접 DB 연결이나 외부 거래소 주문을 하지 않습니다.
- 서버가 다운되면 로그인·주문·시세도 함께 이용할 수 없습니다.
- OS 인증서로 코드 서명하기 전까지 Windows SmartScreen 경고가 나타날 수 있습니다.
- 현재 단계는 **운영 웹 기능을 데스크톱 창으로 통합하는 1차 기반**입니다.
  HTS 고유의 분리형 다중 창·호가 단축주문·멀티 모니터·실시간 스트리밍
  기능은 이 단계에서 독립 구현되지 않았습니다.
- 실제 체결·장부 동작은 서버에서 검증해야 합니다. 데스크톱 설치 성공만으로
  운영 거래의 정합성이 확인된 것은 아닙니다.
