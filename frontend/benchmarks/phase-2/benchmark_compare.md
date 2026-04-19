# FE-2 렌더링 병목 벤치마크

측정일: 2026-04-19
환경: MacBook (로컬), Chrome, pnpm dev (개발 서버)
측정 방법: /benchmark 페이지 UI (Profiler actualDuration + performance.now())

## 건수별 렌더링 성능

| 건수 | Fetch (ms) | React 렌더 (ms) | 총 소요 (ms) | JS Heap (MB) |
|------|-----------|----------------|-------------|-------------|
| 1,000 | | | | |
| 10,000 | | | | |
| 100,000 | | | | |

## DOM 노드 수

측정: Chrome DevTools Console → `document.querySelectorAll('*').length`

| 건수 | DOM 노드 수 |
|------|------------|
| 1,000 | |
| 10,000 | |
| 100,000 | |

## Long Task 관찰 (Chrome Performance 탭)

| 건수 | Long Task 횟수 | 최대 단일 Task (ms) | 체감 |
|------|--------------|-------------------|------|
| 1,000 | | | |
| 10,000 | | | |
| 100,000 | | | 브라우저 완전 프리징 |

## 관찰 및 학습 포인트

<!-- 측정 후 작성 -->
- PostCard 1건 ≈ ms
- 100K 이론값: ms / 실측: ms
- 다음 Phase 비교 기준값으로 활용
