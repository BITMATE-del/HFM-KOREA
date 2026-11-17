# HFM KOREA — 해외선물 전용 플랫폼

## 분리 원칙
이 저장소는 **해외선물 WTS/HTS/MTS 전용**입니다. 기존 **HFM KOREA 마진/CFD** 저장소 `BITMATE-del/ai-autocall-crm`와 소스·회원·DB·배포를 섞지 않습니다.

## 소스 출처
- 원본 `dlxodnjs2456-hash/veltro`
- 기준 커밋 `81acf3f7349467b94700b2def885ff6343b6620a` (2026-09-10)
- 기존 거래 화면·주문·인증·지갑·모바일 및 HTS 패치 소스를 보존해 이전
- 이전 GitHub Actions는 사고 방지를 위해 `legacy-workflows/`에 비활성 상태로 보관
- `desktop/desktop_source.zip`은 원본 ZIP이 정상 압축파일로 열리지 않아 GitHub 이전 대상에서 제외. 원본 압축 백업에만 포함됨.
- 시장 데이터 워커는 기존 VELTRO 환경 자동배포를 방지하기 위해 `render.yaml`에서 중단

## 1차 디자인 변경
- `index.html`과 `hfm-futures-theme.css`: HFM KOREA 브랜드/화이트·네이비 기반 WTS 테마
- `signup.html`: 브랜드 및 가입 폼 스타일
- `admin.html`, `wallet.html`, `wallet-admin.html`: 브랜드 표기 변경
- 기존 `index.html` 모바일 주문 확인 안내문의 JavaScript 문자열 줄바꿈 문법 오류 수정
- 기존 API/체결/원장 SQL 및 DB 데이터는 변경하지 않음

## 배포 전 차단 사항
**아직 실운영 배포 금지.** HTML/JS에는 원래 VELTRO Supabase 프로젝트(`mzjkvakigwtlibwlslhq`) API 설정이 남아 있습니다. 이를 HFM 해외선물 전용 신규 환경으로 분리·인증·마이그레이션 검증하기 전 신규 사이트를 공개하면 안 됩니다.

또한 모바일 APK와 HTS 설치파일 다운로드 경로는 기존 VELTRO 릴리스를 참조합니다. 신규 브랜드 빌드 및 재검증이 완료되기 전까지 HFM KOREA 설치파일로 안내하지 마세요.

## 테스트
- 로컬 JavaScript와 Python 문법 검사 수행
- GitHub 원본과 신규 핵심 파일 구성 비교
- **미실시:** 실제 로그인, 브라우저 E2E, 서버 접속, 주문 체결, 잔고 정산, HTS 실행/설치, Android 기기, 신규 Vercel 배포

## 다음 단계
1. 전용 Supabase/시세 서비스 준비 및 운영환경 분리
2. 로그인·회원가입 및 주문 엔진 회귀 검증
3. 거래 WTS의 차트·호가·주문·포지션 UI 고도화
4. 관리자·입출금·손익 정합성 테스트
5. HTS/MTS 빌드와 배포
