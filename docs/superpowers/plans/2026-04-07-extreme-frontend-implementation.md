# 극한 프론트엔드 성능 챌린지 — 마스터 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Next.js 기반 극한 트래픽 게시판 프론트엔드를 13개 Phase에 걸쳐 naive → 최적화 순서로 구현하며, 각 Phase에서 성능 병목을 체험하고 수치로 증명한다.

**Architecture:** 백엔드 12 Phase에 동기화 + 프론트엔드 전용 3개 Phase 삽입. 각 Phase는 "naive 구현 → 병목 체험 → 최적화 → 벤치마크 증명" 루프를 따른다.

**Tech Stack:** Next.js 16 (App Router), TypeScript (strict), Tailwind CSS, TanStack Query, Zustand, msw, Playwright, Lighthouse CI

**Design Spec:** `docs/superpowers/specs/2026-04-07-extreme-frontend-design.md`

---

## 학습 루프

```
naive 구현 → 병목 체험 → "왜 느린가?" 원리 이해 → 최적화 → 벤치마크로 증명
```

각 Phase를 완료하면 `docs/progress/` 에 결과를 기록한다.

---

## 프로젝트 디렉토리 구조

```
frontend/
├── src/
│   ├── app/                        # Next.js App Router
│   │   ├── layout.tsx              # 루트 레이아웃
│   │   ├── page.tsx                # 메인 (게시글 목록)
│   │   ├── posts/
│   │   │   ├── [id]/page.tsx       # 게시글 상세
│   │   │   └── new/page.tsx        # 게시글 작성
│   │   └── dashboard/page.tsx      # 성능 대시보드 (FE-10~)
│   ├── components/
│   │   ├── posts/                  # 게시글 관련 컴포넌트
│   │   ├── common/                 # 공통 UI
│   │   └── dashboard/              # 성능 대시보드
│   ├── hooks/                      # 커스텀 훅
│   ├── lib/
│   │   ├── api/                    # API 클라이언트
│   │   ├── cache/                  # 캐시 전략 (FE-4~)
│   │   └── performance/            # 성능 측정 유틸 (FE-10~)
│   ├── store/                      # Zustand 스토어 (FE-7~)
│   ├── mocks/                      # msw 핸들러
│   └── workers/                    # Service Worker (FE-9~)
├── public/
├── tests/
│   ├── e2e/                        # Playwright E2E
│   └── performance/                # 벤치마크 스크립트
├── benchmarks/                     # Phase별 벤치마크 결과
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

---

## Phase 로드맵

| Phase | 설명 | 상세 계획 | 상태 |
|-------|------|-----------|------|
| **FE-1** | 프로젝트 셋업 + Naive UI | [fe-phase-01-foundation.md](fe-phases/fe-phase-01-foundation.md) | - |
| **FE-2** | 렌더링 병목 체험 | `fe-phase-02-bottleneck.md` (상세 계획 PR 예정) | - |
| **FE-3** | 리스트 최적화 | `fe-phase-03-list-optimization.md` (상세 계획 PR 예정) | - |
| **FE-4** | 데이터 페칭 + 캐싱 | `fe-phase-04-caching.md` (상세 계획 PR 예정) | - |
| **★ FE-5** | 대량 렌더링 극한 | `fe-phase-05-virtualization.md` (상세 계획 PR 예정) | - |
| **FE-6** | 동시성 UI 패턴 | `fe-phase-06-concurrency.md` (상세 계획 PR 예정) | - |
| **FE-7** | 상태 관리 + Smart Polling | `fe-phase-07-state-polling.md` (상세 계획 PR 예정) | - |
| **FE-8** | 이미지 업로드 UX | `fe-phase-08-image-upload.md` (상세 계획 PR 예정) | - |
| **★ FE-9** | 네트워크 극한 | `fe-phase-09-network.md` (상세 계획 PR 예정) | - |
| **FE-10** | 프론트엔드 모니터링 | `fe-phase-10-monitoring.md` (상세 계획 PR 예정) | - |
| **FE-11** | 스트레스 테스트 | `fe-phase-11-stress.md` (상세 계획 PR 예정) | - |
| **★ FE-12** | 메모리/성능 극한 | `fe-phase-12-memory.md` (상세 계획 PR 예정) | - |
| **FE-13** | 프로덕션 배포 + CDN | `fe-phase-13-deploy.md` (상세 계획 PR 예정) | - |

---

## 벤치마크 기준값

각 Phase에서 측정하여 `benchmarks/phase-XX.md` 에 기록:

| 지표 | 측정 도구 | 목표 (Phase 13 기준) |
|------|-----------|---------------------|
| LCP | web-vitals | < 2.5s |
| INP | web-vitals | < 200ms |
| CLS | web-vitals | < 0.1 |
| 번들 크기 (gzipped) | @next/bundle-analyzer | < 150KB (JS) |
| 10만건 렌더링 시간 | Performance API | 가상화 후 60fps 유지 |
| 메모리 증가 (10분) | Chrome DevTools Memory | < 10MB |
| Lighthouse 성능 점수 | Lighthouse CI | > 90 |

---

## 백엔드 협업 포인트

백엔드 Phase가 완료될 때까지 msw로 mock API 사용. 전환 시점:

| 백엔드 Phase | 프론트엔드 전환 |
|-------------|----------------|
| BE-1 완료 | msw → 실제 CRUD API |
| BE-3 완료 | 커서 페이지네이션 API 연동 |
| BE-4 완료 | Cache-Control 헤더 활용 |
| BE-6 완료 | 멱등성 키 실제 API 연동 |
| BE-8 완료 | Presigned URL 실제 발급 |
| BE-12 완료 | 프로덕션 배포 |
