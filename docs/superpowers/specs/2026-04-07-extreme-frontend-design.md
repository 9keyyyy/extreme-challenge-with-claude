# 극한 프론트엔드 성능 챌린지 — 설계 문서

## 목표

백엔드 극한 트래픽 게시판(1M CCU / 1M RPS)과 협업하여, 프론트엔드에서도 극한 상황의 성능 문제를 체험하고 최적화하는 학습 프로젝트.

**핵심 원칙**: naive 구현 → 병목 체험 → 최적화 → 벤치마크 증명

## 기술 스택

| 구분 | 선택 | 이유 |
|------|------|------|
| 프레임워크 | Next.js (App Router) | SSR/SSG/ISR, Server Components, Edge Runtime |
| 언어 | TypeScript | 타입 안전성, 리팩토링 용이 |
| 스타일링 | Tailwind CSS | 런타임 비용 없음, 빠른 개발 |
| 데이터 페칭 | TanStack Query | 서버 상태 캐싱, Optimistic Update |
| 상태 관리 | Zustand | 경량, 클라이언트 상태 전용 |
| 테스트 | Playwright + Lighthouse CI | E2E + 성능 자동 측정 |

## Phase 구조

백엔드 12 Phase에 동기화 + 프론트엔드 전용 3개 Phase 삽입 (★ 표시).

총 **13 Phase, 52 Task**.

### Phase 매핑 테이블

| Phase | BE 대응 | 프론트엔드 주제 | 핵심 챌린지 |
|-------|---------|---------------|-----------|
| FE-1 | BE-1 Foundation | 프로젝트 셋업 + Naive UI | Next.js 기본 CRUD, 의도적 비최적화 |
| FE-2 | BE-2 Bottleneck | 렌더링 병목 체험 | 10만건 렌더링, Re-render 폭풍, Profiler |
| FE-3 | BE-3 DB Opt | 리스트 최적화 | 커서 무한 스크롤, memo, Intersection Observer |
| FE-4 | BE-4 Redis Cache | 데이터 페칭 + 캐싱 | TanStack Query, SWR 패턴, Optimistic Update |
| ★ FE-5 | (전용) | 대량 렌더링 극한 | 가상 스크롤, 10만건+, DOM 재사용, rAF |
| FE-6 | BE-5~6 Counter+Idem | 동시성 UI 패턴 | Race Condition, 멱등성 키, AbortController |
| FE-7 | BE-7 CQRS+Events | 상태 관리 + Polling | Read/Write 상태 분리, Smart Polling |
| FE-8 | BE-8 Image Upload | 이미지 업로드 UX | Presigned URL, 클라이언트 압축, Lazy Loading |
| ★ FE-9 | (전용) | 네트워크 극한 | Service Worker, 오프라인, 번들 최적화 |
| FE-10 | BE-9 Monitoring | 프론트엔드 모니터링 | Web Vitals, Memory Leak, 성능 대시보드 |
| FE-11 | BE-10~11 Load+Chaos | 스트레스 테스트 | Lighthouse CI, 장애 시뮬레이션, Skeleton UI |
| ★ FE-12 | (전용) | 메모리/성능 극한 | Heap Snapshot, GC 압박, Long Task 분석 |
| FE-13 | BE-12 Cloud | 프로덕션 배포 + CDN | Vercel, ISR, CDN 캐싱, 최종 리포트 |

---

## Phase 세부 설계

### FE-1: 프로젝트 셋업 + Naive UI

**학습 키워드**: Next.js App Router, SSR vs CSR, Hydration, React Rendering Pipeline (Reconciliation → Commit)

> **참고**: 백엔드 Phase 1이 완료될 때까지 msw(Mock Service Worker)로 개발 진행, 완료 후 실제 API로 전환.

**태스크**:
- **Task 1**: Next.js 프로젝트 초기화 — App Router, TypeScript strict, Tailwind, ESLint, msw 설정
- **Task 2**: 게시글 목록 페이지 — 의도적 naive 구현 (전체 데이터 한번에 fetch, OFFSET 페이지네이션, 모든 컴포넌트 re-render 허용)
- **Task 3**: 게시글 상세/작성/수정 페이지 — 기본 CRUD UI
- **Task 4**: API 연동 레이어 — fetch wrapper, 에러 핸들링 기본 구조

**벤치마크**: 초기 Lighthouse 점수 기록, React Profiler 렌더링 시간 기준값

---

### FE-2: 렌더링 병목 체험

**학습 키워드**: React Reconciliation O(n) diffing, Virtual DOM 비용, JavaScript 메인 스레드 블로킹, Long Task, Chrome DevTools Performance 탭

**핵심 질문**: "왜 10만건을 한번에 렌더링하면 안 되는가?" → DOM 노드 수 × Layout/Paint 비용, 메모리 사용량

**태스크**:
- **Task 5**: 시드 데이터 10만건 목록 렌더링 → 브라우저 프리징 체험
- **Task 6**: React Profiler로 불필요 re-render 시각화, Performance 탭으로 Long Task 측정
- **Task 7**: benchmark_compare.md 작성 — 1천/1만/10만건 렌더링 시간 비교

**벤치마크**: 건수별 렌더링 시간, 메모리 사용량, Long Task 횟수

---

### FE-3: 리스트 최적화

**학습 키워드**: 커서 기반 페이지네이션 UI, Intersection Observer API (vs scroll event), React.memo / useMemo / useCallback, Referential Equality

**태스크**:
- **Task 8**: 무한 스크롤 — Intersection Observer + 커서 페이지네이션
- **Task 9**: React.memo 적용, 전후 Profiler 비교
- **Task 10**: Key 전략 — index key vs stable key 성능 차이 벤치마크

**벤치마크**: FE-2 대비 렌더링 시간, 스크롤 FPS

---

### FE-4: 데이터 페칭 + 캐싱 전략

**학습 키워드**: Stale-While-Revalidate 패턴, TanStack Query 캐시 (Query Key, gcTime, staleTime), Optimistic Update + 롤백, HTTP Cache-Control vs 앱 레벨 캐시

**태스크**:
- **Task 11**: TanStack Query 도입, useInfiniteQuery로 무한 스크롤 리팩토링
- **Task 12**: 캐시 전략 — 목록(stale 30s), 상세(stale 5m), 카운터(stale 0s)
- **Task 13**: Optimistic Update — 좋아요 즉시 반영 → 실패 시 롤백
- **Task 14**: 캐시 히트율 측정, API 요청 수 전후 비교

**벤치마크**: API 호출 수 전후 비교, 체감 응답 속도(TTI)

---

### ★ FE-5: 대량 렌더링 극한 챌린지

**학습 키워드**: 가상 스크롤(Virtualization), Overscan, DOM 재사용 풀, requestAnimationFrame, 브라우저 렌더링 파이프라인 (Style → Layout → Paint → Composite), GPU 가속 (transform/opacity), will-change

**태스크**:
- **Task 15**: 가상 스크롤 직접 구현 — 라이브러리 없이 (containerHeight, itemHeight, startIndex/endIndex, transform: translateY)
- **Task 16**: 가변 높이 아이템 가상 스크롤 — 높이 추정 + 실측 보정 (ResizeObserver)
- **Task 17**: 라이브러리 비교 — 직접 구현 vs @tanstack/react-virtual vs react-window
- **Task 18**: 극한 테스트 — 100만건 리스트, 60fps 유지 목표, Memory 측정

**벤치마크**: naive(FE-2) vs 무한스크롤(FE-3) vs 가상화(FE-5) 3단계 비교 리포트

---

### FE-6: 동시성 UI 패턴

**학습 키워드**: Optimistic Update 심화, Race Condition (stale closure, 요청 순서 역전), AbortController, 멱등성 키 (UUID v4), 디바운싱/쓰로틀링

**태스크**:
- **Task 19**: 좋아요 Race Condition 재현 — 빠른 연타 시 카운트 불일치
- **Task 20**: AbortController + 멱등성 키, 요청 순서 보장 (시퀀스 넘버)
- **Task 21**: 디바운스 검색 + 쓰로틀 스크롤 — 직접 구현 후 성능 측정
- **Task 22**: 에러 시 롤백 UI — Toast 실패 알림 + 자동 복구

**벤치마크**: 100회 연타 카운트 정확도, 불필요 API 호출 수 비교

---

### FE-7: 상태 관리 + Smart Polling

**학습 키워드**: CQRS 프론트엔드 관점 — Read State(서버 캐시) vs Write State(로컬 mutation), Smart Polling, Document Visibility API, 상태 관리 계층 (서버 vs 클라이언트 vs UI)

**태스크**:
- **Task 23**: TanStack Query refetchOnWindowFocus, refetchInterval로 Smart Polling
- **Task 24**: Document Visibility API — 비활성 탭 폴링 중지, 복귀 시 즉시 갱신
- **Task 25**: 상태 분리 설계 — 서버 상태(TanStack Query), 클라이언트 상태(Zustand, Context 없이)
- **Task 26**: 멀티 탭 데이터 일관성 검증

**벤치마크**: 폴링 제거 전후 네트워크 요청 수, CPU/배터리 영향

---

### FE-8: 이미지 업로드 UX

**학습 키워드**: Presigned URL 업로드 흐름, File API + Blob, Canvas API 이미지 압축, OffscreenCanvas, Progressive Image Loading, Lazy Loading (loading="lazy" vs Intersection Observer)

**태스크**:
- **Task 27**: Presigned URL 업로드 — 파일 선택 → URL 발급 → XHR progress 이벤트
- **Task 28**: 이미지 미리보기 — URL.createObjectURL, 드래그앤드롭
- **Task 29**: 클라이언트 이미지 압축 — Canvas API 리사이즈/품질 조절
- **Task 30**: Lazy Loading — Intersection Observer, placeholder blur

**벤치마크**: 업로드 시간 (직접 vs 서버 경유), 압축 전후 용량/품질, LCP

---

### ★ FE-9: 네트워크 극한 챌린지

**학습 키워드**: Service Worker 라이프사이클, Cache API 전략 (Cache First, Network First, SWR), 번들 분석, Code Splitting (dynamic import, React.lazy), Tree Shaking, HTTP/2, Resource Hints (preload, prefetch, preconnect)

**태스크**:
- **Task 31**: 번들 분석 — @next/bundle-analyzer로 크기 측정, 큰 의존성 식별
- **Task 32**: Code Splitting — 페이지별 dynamic import, 에디터/이미지 lazy loading
- **Task 33**: Service Worker 직접 구현 — API 캐싱(Network First), 정적 자원(Cache First)
- **Task 34**: 오프라인 모드 — 캐시 게시글 표시, 오프라인 작성 → 동기화 큐
- **Task 35**: 3G 시뮬레이션 — Chrome Throttling으로 극한 네트워크 UX 검증

**벤치마크**: 번들 크기 전후, 3G FCP/LCP, 오프라인→온라인 동기화 성공률

---

### FE-10: 프론트엔드 모니터링

**학습 키워드**: Core Web Vitals (LCP, INP, CLS), PerformanceObserver API, Long Animation Frame API, Memory API, Error Boundary, 프론트엔드 에러 수집 (window.onerror, unhandledrejection)

**태스크**:
- **Task 36**: Web Vitals 수집 — web-vitals + 커스텀 PerformanceObserver
- **Task 37**: 성능 대시보드 — 실시간 Web Vitals, 메모리, Long Task 시각화
- **Task 38**: Error Boundary 계층 — 페이지/컴포넌트/API 레벨 분리, Fallback UI
- **Task 39**: 에러 리포팅 — 글로벌 핸들러, 구조화된 에러 리포트

**벤치마크**: 전 Phase 최적화 전후 Web Vitals 변화 리포트

---

### FE-11: 프론트엔드 스트레스 테스트

**학습 키워드**: Lighthouse CI 자동화, Playwright E2E 성능 테스트, 네트워크 장애 시뮬레이션, Graceful Degradation vs Progressive Enhancement, Skeleton UI

**태스크**:
- **Task 40**: Lighthouse CI — GitHub Actions PR별 자동 성능 측정
- **Task 41**: Playwright 성능 시나리오 — 100개 스크롤, 이미지 로딩, 좋아요 연타
- **Task 42**: 장애 시뮬레이션 — API 타임아웃, 500 에러, 네트워크 끊김 UX
- **Task 43**: Skeleton UI — 모든 로딩 상태에 Skeleton + Suspense Boundary

**벤치마크**: Lighthouse History, 장애 시 UX 연속성

---

### ★ FE-12: 메모리/성능 극한 챌린지

**학습 키워드**: V8 GC (Minor/Major GC, Generational), Heap Snapshot (Retained Size vs Shallow Size), Memory Leak 패턴 (이벤트 리스너, 클로저, 타이머, detached DOM), Long Task/Long Animation Frame

**태스크**:
- **Task 44**: Memory Leak 생성 → 탐지 → 수정 (이벤트 리스너, setInterval, detached DOM)
- **Task 45**: Heap Snapshot 비교 — 페이지 이동 전후 메모리 증가 분석
- **Task 46**: GC 압박 테스트 — 대량 객체 생성/해제, GC pause 측정
- **Task 47**: 성능 리포트 자동화 — 전 Phase 벤치마크 종합 리포트 생성

**벤치마크**: 10분 연속 사용 메모리 증가량, GC pause 빈도, 종합 리포트

---

### FE-13: 프로덕션 배포 + CDN

**학습 키워드**: Vercel 배포, Edge Runtime vs Node.js Runtime, ISR, CDN 캐싱 (s-maxage, stale-while-revalidate), next/image 최적화 (WebP/AVIF), 보안 헤더 (CSP, HSTS)

**태스크**:
- **Task 48**: Vercel 배포 — 환경변수, 빌드 설정
- **Task 49**: ISR 적용 — 게시글 상세 ISR, revalidate 전략
- **Task 50**: 이미지 최적화 — next/image + CDN, WebP 자동 변환
- **Task 51**: 최종 성능 리포트 — Phase 1 vs Phase 13 전체 비교
- **Task 52**: 비용 분석 — Vercel 무료 티어, CDN 비용, 총 운영비

**벤치마크**: naive(FE-1) vs 최종(FE-13) 전체 성능 비교 리포트

---

## 학습 방식

각 Phase는 백엔드와 동일한 구조를 따름:

1. **학습 섹션** — 핵심 개념, 원리, "왜 이렇게 하는가"
2. **구현 섹션** — naive → 최적화 순서로 코드 작성
3. **벤치마크 섹션** — 전후 수치 비교로 개선 증명
4. **키워드/면접 질문** — 해당 Phase 관련 핵심 키워드와 예상 면접 질문

## 프로젝트 디렉토리 구조 (예상)

```
frontend/
├── src/
│   ├── app/                    # Next.js App Router 페이지
│   │   ├── layout.tsx
│   │   ├── page.tsx            # 메인 (게시글 목록)
│   │   ├── posts/
│   │   │   ├── [id]/page.tsx   # 게시글 상세
│   │   │   └── new/page.tsx    # 게시글 작성
│   │   └── dashboard/page.tsx  # 성능 대시보드 (FE-10)
│   ├── components/
│   │   ├── posts/              # 게시글 관련 컴포넌트
│   │   ├── common/             # 공통 UI (Skeleton, ErrorBoundary 등)
│   │   └── dashboard/          # 성능 대시보드 컴포넌트
│   ├── hooks/                  # 커스텀 훅
│   ├── lib/                    # 유틸리티, API 클라이언트
│   │   ├── api/                # API fetch 함수
│   │   ├── cache/              # 캐시 전략
│   │   └── performance/        # 성능 측정 유틸
│   ├── store/                  # Zustand 스토어
│   └── workers/                # Service Worker, Web Worker
├── public/
├── tests/
│   ├── e2e/                    # Playwright E2E
│   └── performance/            # 성능 벤치마크 스크립트
├── benchmarks/                 # Phase별 벤치마크 결과
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

## 백엔드 협업 포인트

| Phase | 프론트엔드 | 백엔드 의존성 |
|-------|-----------|-------------|
| FE-1 | CRUD UI | BE-1 API 엔드포인트 |
| FE-3 | 커서 페이지네이션 | BE-3 커서 API |
| FE-4 | 캐싱 전략 | BE-4 Cache-Control 헤더 |
| FE-6 | 멱등성 키 | BE-6 Idempotency API |
| FE-8 | Presigned URL | BE-8 URL 발급 API |
| FE-13 | CDN 배포 | BE-12 클라우드 인프라 |

## 비용 전략

- Phase 1~12: 로컬 개발 ($0) — 백엔드 Docker Compose 활용
- Phase 13: Vercel Hobby (무료) + 백엔드 AWS ($43~70)
- **총 예상 비용: $0~$70 (백엔드 포함)**
