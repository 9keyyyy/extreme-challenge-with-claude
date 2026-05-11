# FE-2: 렌더링 병목 체험 — 설계 문서

작성일: 2026-04-19  
연관 스펙: `docs/superpowers/specs/2026-04-07-extreme-frontend-design.md` (FE-2 섹션)

---

## 목표

1K / 10K / 100K 건의 게시글을 페이지네이션 없이 한번에 렌더링해 React DOM 렌더링 병목을 직접 체험하고, 건수별 렌더링 시간·메모리를 측정해 `benchmark_compare.md`에 기록한다.

**핵심 원칙**: 의도적 naive 구현. 최적화하지 않는다.

---

## 태스크 매핑

| 태스크 | 내용 |
|--------|------|
| Task 5 | MSW + `/benchmark` 페이지로 10만건 렌더링 → 브라우저 프리징 체험 |
| Task 6 | `<Profiler onRender>` + `performance.now()`로 렌더 시간 측정, UI에 표시 |
| Task 7 | `benchmarks/phase-2/benchmark_compare.md` 작성 (1K/10K/100K 비교) |

---

## 파일 구조

### 신규 파일

```
frontend/
├── app/benchmark/page.tsx
├── components/benchmark/
│   ├── rendering-bench.tsx        # 버튼·타이머·결과 표시 UI
│   └── naive-bulk-list.tsx        # Profiler로 감싼 전체 목록 렌더러
└── benchmarks/phase-2/
    └── benchmark_compare.md       # 측정 후 직접 작성
```

### 수정 파일

```
mocks/data.ts      generateNPostListItems(n) 추가
mocks/handlers.ts  page_size > 500 시 on-demand 생성 분기
```

### 무변경 파일

- `components/posts/post-list.tsx` — Phase 1 구현 보존
- `app/page.tsx` — 메인 페이지 그대로

---

## 데이터 레이어

### `mocks/data.ts` 추가

```ts
export function generateNPostListItems(n: number): PostListItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    title: `벤치마크 게시글 ${i + 1}`,
    author: `user${i % 100}`,
    viewCount: i * 3,
    likeCount: i % 50,
    commentCount: i % 20,
    createdAt: new Date(Date.now() - i * 60000).toISOString(),
  }));
}
```

기존 `db.posts`(20건)는 변경하지 않는다.

### `mocks/handlers.ts` 분기

```ts
// GET /api/v1/posts
const pageSize = Number(url.searchParams.get("page_size") ?? "20");

if (pageSize > 500) {
  // benchmark 모드: db 무관, on-demand 생성
  return HttpResponse.json({
    items: generateNPostListItems(pageSize),
    total: pageSize,
    page: 1,
    pageSize,
    hasNext: false,
  });
}
// 기존 로직
return HttpResponse.json(db.getPaginatedPosts(page, pageSize));
```

`page_size > 500`을 benchmark 모드 기준으로 삼는다. 일반 페이지네이션(pageSize=20)에는 영향 없다.

---

## 측정 아키텍처

```
fetch 시작(performance.now())
  │
  ▼ GET /api/v1/posts?page_size=N
  │
fetch 완료 → fetchTime 확정
  │
  ▼ setState(items)
  │
React 렌더 시작 (<Profiler onRender actualDuration>)
  │
  ▼ PostCard × N 렌더링
  │
렌더 완료 → renderTime 확정
  │
totalTime = fetchTime + renderTime
메모리: (performance as any).memory?.usedJSHeapSize (Chrome 전용)
```

### `<Profiler>` 사용

```tsx
<Profiler id="bulk-list" onRender={(_, __, actualDuration) => {
  setRenderTime(actualDuration);
}}>
  <NaiveBulkList items={items} />
</Profiler>
```

`actualDuration`: 해당 렌더 사이클에서 React가 실제 소비한 ms.

---

## UI 설계 (`/benchmark`)

```
┌─────────────────────────────────────────────┐
│  렌더링 병목 체험 벤치마크               FE-2 │
│                                             │
│  [1,000건]  [10,000건]  [100,000건]         │
│   ⚠ 100,000건: 브라우저가 수 초 멈춥니다    │
│                                             │
│  렌더링 건수: 10,000                         │
│  Fetch 시간:   45 ms                         │
│  React 렌더:  1,234 ms                       │
│  총 소요:     1,279 ms                       │
│  JS Heap:     245 MB  (Chrome 전용)          │
│                                             │
│  ─────────────────────────────────────────  │
│  PostCard × N 렌더링 영역 (스크롤 가능)      │
└─────────────────────────────────────────────┘
```

- 버튼 클릭 시 이전 결과·목록 초기화 후 새 fetch 시작
- 측정 중 버튼 비활성화 (중복 요청 방지)
- 결과 영역: 측정 전에는 `-` 표시

---

## 벤치마크 문서 (`benchmark_compare.md`)

측정 후 직접 작성. 항목:

| 건수 | Fetch (ms) | React 렌더 (ms) | 총 소요 (ms) | JS Heap (MB) |
|------|-----------|----------------|-------------|-------------|
| 1,000 | | | | |
| 10,000 | | | | |
| 100,000 | | | | |

추가 관찰 항목:
- Long Task 횟수 (Chrome Performance 탭)
- DOM 노드 수 (`document.querySelectorAll('*').length`)
- 체감 프리징 시간

---

## 학습 포인트

- PostCard 1건 렌더 ≈ 1.9ms (Phase 1 기준) → 100K × 1.9ms = 약 190초 이론값
- 실제 브라우저는 일부 배치 최적화로 이론값보다 빠르지만 수 초 ~ 수십 초 프리징 발생
- Long Task(50ms 초과 JS 블로킹)가 수백 개 발생, 사용자 인터렉션 완전 차단
- Phase 3(가상 스크롤)과의 비교 기준값으로 활용
