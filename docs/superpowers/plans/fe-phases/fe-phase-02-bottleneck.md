# FE-2: 렌더링 병목 체험 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/benchmark` 페이지에 1K/10K/100K 프리셋 버튼을 두고, MSW로 N건 데이터를 생성해 페이지네이션 없이 한번에 렌더링하며 `<Profiler>` + `performance.now()`로 측정한 수치를 UI에 표시한다.

**Architecture:** MSW GET 핸들러에 `pageSize > 500` 분기를 추가해 on-demand 데이터 생성. `NaiveBulkList`가 `<Profiler onRender>`로 `PostCard × N`을 감싸 렌더 시간을 콜백으로 올린다. `RenderingBench`가 fetch/render 타이밍을 조율하고 결과를 표시한다.

**Tech Stack:** Next.js 16 App Router, React 19 `<Profiler>`, MSW 2, TypeScript strict, Biome, pnpm

---

## 파일 맵

| 액션 | 경로 | 역할 |
|------|------|------|
| Modify | `mocks/data.ts` | `generateNPostListItems(n)` 추가 |
| Modify | `mocks/handlers.ts` | `pageSize > 500` → benchmark 분기 |
| Create | `components/benchmark/naive-bulk-list.tsx` | `<Profiler>` + `PostCard × N` |
| Create | `components/benchmark/rendering-bench.tsx` | 버튼·타이머·결과 UI |
| Create | `app/benchmark/page.tsx` | 페이지 진입점 |
| Create | `benchmarks/phase-2/benchmark_compare.md` | 측정 결과 기록 |

---

## Task 1: 브랜치 생성 + generateNPostListItems 추가

**Files:**
- Create branch: `feat/fe-phase-02-bottleneck`
- Modify: `mocks/data.ts`

- [ ] **Step 1: 브랜치 생성**

```bash
git checkout -b feat/fe-phase-02-bottleneck
```

- [ ] **Step 2: `mocks/data.ts`에 `generateNPostListItems` 추가**

`generatePostListItem` 함수 아래, `db` 객체 위에 추가한다.

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

- [ ] **Step 3: 타입 검사**

```bash
cd frontend && pnpm check
```

Expected: 오류 없음. `PostListItem` 인터페이스(`types/post.ts`)의 필드를 모두 채우고 있는지 확인. 필드: `id, title, author, viewCount, likeCount, commentCount, createdAt`.

- [ ] **Step 4: 커밋**

```bash
git add frontend/mocks/data.ts
git commit -m "feat(fe-2): generateNPostListItems on-demand 생성 함수 추가"
```

---

## Task 2: MSW 핸들러 — benchmark 분기 추가

**Files:**
- Modify: `mocks/handlers.ts`

- [ ] **Step 1: `handlers.ts` 상단에 import 추가**

`db` import 옆에 `generateNPostListItems`를 추가한다.

```ts
import { db, generateNPostListItems } from "./data";
```

- [ ] **Step 2: GET `/api/v1/posts` 핸들러 교체**

기존 핸들러:
```ts
http.get(`${API_BASE}/api/v1/posts`, ({ request }) => {
  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("page_size") ?? "20");
  return HttpResponse.json(db.getPaginatedPosts(page, pageSize));
}),
```

교체 후:
```ts
http.get(`${API_BASE}/api/v1/posts`, ({ request }) => {
  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("page_size") ?? "20");

  if (pageSize > 500) {
    return HttpResponse.json({
      items: generateNPostListItems(pageSize),
      total: pageSize,
      page: 1,
      pageSize,
      hasNext: false,
    });
  }

  return HttpResponse.json(db.getPaginatedPosts(page, pageSize));
}),
```

- [ ] **Step 3: 타입 검사**

```bash
cd frontend && pnpm check
```

Expected: 오류 없음. 반환 객체가 `PostListResponse` 구조(`items, total, page, pageSize, hasNext`)와 일치하는지 확인.

- [ ] **Step 4: 커밋**

```bash
git add frontend/mocks/handlers.ts
git commit -m "feat(fe-2): MSW pageSize>500 benchmark 분기 추가"
```

---

## Task 3: NaiveBulkList 컴포넌트

**Files:**
- Create: `frontend/components/benchmark/naive-bulk-list.tsx`

- [ ] **Step 1: 디렉토리 생성 확인**

```bash
ls frontend/components/
```

`benchmark/` 디렉토리가 없으면 파일 생성 시 자동 생성된다.

- [ ] **Step 2: `naive-bulk-list.tsx` 작성**

```tsx
"use client";

import { Profiler, type ProfilerOnRenderCallback } from "react";
import { PostCard } from "@/components/posts/post-card";
import type { PostListItem } from "@/types/post";

interface Props {
  items: PostListItem[];
  onRenderComplete: (actualDurationMs: number) => void;
}

export function NaiveBulkList({ items, onRenderComplete }: Props) {
  const handleRender: ProfilerOnRenderCallback = (
    _id,
    _phase,
    actualDuration,
  ) => {
    onRenderComplete(actualDuration);
  };

  return (
    <Profiler id="naive-bulk-list" onRender={handleRender}>
      <div>
        {items.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>
    </Profiler>
  );
}
```

`Profiler`는 React 개발 모드에서만 `onRender`를 호출한다. 프로덕션 빌드에서는 no-op이 된다. 벤치마크는 `pnpm dev`(개발 서버)에서 측정한다.

- [ ] **Step 3: 타입 검사**

```bash
cd frontend && pnpm check
```

Expected: 오류 없음.

- [ ] **Step 4: 커밋**

```bash
git add frontend/components/benchmark/naive-bulk-list.tsx
git commit -m "feat(fe-2): NaiveBulkList — Profiler로 감싼 전체 목록 렌더러"
```

---

## Task 4: RenderingBench 컴포넌트

**Files:**
- Create: `frontend/components/benchmark/rendering-bench.tsx`

- [ ] **Step 1: `rendering-bench.tsx` 작성**

```tsx
"use client";

import { useRef, useState } from "react";
import { fetchPosts } from "@/lib/api/posts";
import type { PostListItem } from "@/types/post";
import { NaiveBulkList } from "./naive-bulk-list";

const PRESETS = [
  { label: "1,000건", count: 1_000 },
  { label: "10,000건", count: 10_000 },
  { label: "100,000건", count: 100_000 },
] as const;

interface Metrics {
  count: number;
  fetchMs: number;
  renderMs: number;
  heapMB: number | null;
}

export function RenderingBench() {
  const [items, setItems] = useState<PostListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const pending = useRef<{ count: number; fetchMs: number } | null>(null);

  async function runBenchmark(count: number) {
    setLoading(true);
    setItems([]);
    setMetrics(null);
    pending.current = null;

    const fetchStart = performance.now();
    const res = await fetchPosts(1, count);
    const fetchMs = performance.now() - fetchStart;

    pending.current = { count, fetchMs };
    setItems(res.items);
    setLoading(false);
  }

  function handleRenderComplete(renderMs: number) {
    const p = pending.current;
    if (!p) return;
    pending.current = null;

    const mem = (
      performance as { memory?: { usedJSHeapSize: number } }
    ).memory;
    const heapMB = mem ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : null;

    setMetrics({
      count: p.count,
      fetchMs: p.fetchMs,
      renderMs: Math.round(renderMs),
      heapMB,
    });
  }

  return (
    <main className="max-w-3xl mx-auto w-full px-4 py-10">
      {/* 헤더 */}
      <div className="flex items-end justify-between mb-1 pb-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            렌더링 병목 체험
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            FE Phase 2 — Naive Bulk Rendering
          </p>
        </div>
      </div>

      {/* 프리셋 버튼 */}
      <div className="flex gap-3 mt-6">
        {PRESETS.map(({ label, count }) => (
          <button
            key={count}
            type="button"
            onClick={() => runBenchmark(count)}
            disabled={loading}
            className="px-4 py-2 text-sm border border-border rounded-md hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-amber-600 mt-2 mb-6">
        ⚠ 100,000건 선택 시 브라우저가 수 초간 멈춥니다
      </p>

      {/* 측정 결과 */}
      {metrics && (
        <div className="border border-border rounded-lg p-4 mb-6 font-mono text-sm space-y-1.5">
          <Row label="렌더링 건수" value={metrics.count.toLocaleString()} />
          <Row label="Fetch 시간" value={`${Math.round(metrics.fetchMs)} ms`} />
          <Row label="React 렌더" value={`${metrics.renderMs} ms`} />
          <Row
            label="총 소요"
            value={`${Math.round(metrics.fetchMs + metrics.renderMs)} ms`}
          />
          <Row
            label="JS Heap"
            value={
              metrics.heapMB !== null
                ? `${metrics.heapMB} MB`
                : "측정 불가 (Chrome 전용)"
            }
          />
        </div>
      )}

      {loading && (
        <p className="text-sm text-muted-foreground mb-4 font-mono">
          fetch 중...
        </p>
      )}

      {/* 목록 */}
      {items.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <NaiveBulkList items={items} onRenderComplete={handleRenderComplete} />
        </div>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4">
      <span className="text-muted-foreground w-28 shrink-0">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
```

- [ ] **Step 2: 타입 검사**

```bash
cd frontend && pnpm check
```

Expected: 오류 없음. `pending.current` 흐름: `runBenchmark` 시작 시 null → fetch 완료 후 `{ count, fetchMs }` 세팅 → `handleRenderComplete` 처리 후 다시 null.

- [ ] **Step 3: 커밋**

```bash
git add frontend/components/benchmark/rendering-bench.tsx
git commit -m "feat(fe-2): RenderingBench — 프리셋 버튼·fetch/render 타이밍 측정 UI"
```

---

## Task 5: `/benchmark` 페이지 연결

**Files:**
- Create: `frontend/app/benchmark/page.tsx`

- [ ] **Step 1: `page.tsx` 작성**

```tsx
import { RenderingBench } from "@/components/benchmark/rendering-bench";

export default function BenchmarkPage() {
  return <RenderingBench />;
}
```

Server Component 페이지에서 Client Component(`RenderingBench`)를 import하는 표준 App Router 패턴.

- [ ] **Step 2: 타입 검사 + 빌드 확인**

```bash
cd frontend && pnpm check
```

Expected: 오류 없음.

- [ ] **Step 3: 커밋**

```bash
git add frontend/app/benchmark/page.tsx
git commit -m "feat(fe-2): /benchmark 페이지 추가"
```

---

## Task 6: 수동 측정 + benchmark_compare.md 작성

**Files:**
- Create: `frontend/benchmarks/phase-2/benchmark_compare.md`

- [ ] **Step 1: 개발 서버 시작**

```bash
cd frontend && pnpm dev
```

브라우저에서 `http://localhost:3000/benchmark` 접속.

- [ ] **Step 2: 1,000건 측정**

[1,000건] 버튼 클릭 → UI에 표시된 수치 기록.
추가 측정:
- Chrome DevTools → Performance 탭 → Record → [1,000건] 클릭 → Stop → "Long tasks" 확인
- Console: `document.querySelectorAll('*').length` 실행 → DOM 노드 수 기록

- [ ] **Step 3: 10,000건 측정**

[10,000건] 버튼 클릭 → 동일하게 기록.

- [ ] **Step 4: 100,000건 측정**

[100,000건] 버튼 클릭. 브라우저 프리징 체험. 완료 후 수치 기록.
100K는 Chrome Performance 탭에서 Long Task가 다수 발생하는지 확인.

- [ ] **Step 5: `benchmark_compare.md` 작성**

측정한 실제 수치로 빈칸을 채운다.

```markdown
# FE-2 렌더링 병목 벤치마크

측정일: 2026-04-19
환경: MacBook (로컬), Chrome, pnpm dev (개발 서버)
측정 방법: RenderingBench UI (Profiler actualDuration + performance.now())

## 건수별 렌더링 성능

| 건수 | Fetch (ms) | React 렌더 (ms) | 총 소요 (ms) | JS Heap (MB) |
|------|-----------|----------------|-------------|-------------|
| 1,000 | | | | |
| 10,000 | | | | |
| 100,000 | | | | |

## DOM 노드 수 (document.querySelectorAll('*').length)

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

- PostCard 1건 ≈ __ms (Phase 1 기준 1.9ms)
- 100K × __ms = 이론값 __초 / 실측 __ms
- Long Task: 50ms 초과 JS 블록이 __개 발생 → 사용자 인터렉션 완전 차단
- 메모리: 20건(Phase 1, 6.63MB) → 100K건 __MB, __ 배 증가

## 다음 Phase 예고

Phase 3(커서 무한 스크롤)과 Phase 5(가상 스크롤)에서 이 수치를 기준값으로 비교한다.
```

- [ ] **Step 6: 커밋**

```bash
git add frontend/benchmarks/phase-2/benchmark_compare.md
git commit -m "docs(fe-2): benchmark_compare.md — 1K/10K/100K 렌더링 측정 결과"
```

---

## Task 7: PR 생성

- [ ] **Step 1: 브랜치 push**

```bash
git push -u origin feat/fe-phase-02-bottleneck
```

- [ ] **Step 2: PR 생성**

```bash
gh pr create \
  --title "feat: FE Phase 2 — 렌더링 병목 체험 (/benchmark 페이지)" \
  --body "$(cat <<'EOF'
## Summary

- `/benchmark` 페이지 추가: 1K/10K/100K 프리셋 버튼으로 naive 전체 렌더링 체험
- MSW에 `pageSize > 500` benchmark 분기 추가 (`generateNPostListItems`)
- `<Profiler onRender>` + `performance.now()`로 fetch/render 시간 측정, UI에 표시
- `benchmarks/phase-2/benchmark_compare.md` — 건수별 렌더링 시간·메모리·Long Task 기록

## 변경 파일

- `mocks/data.ts` — `generateNPostListItems(n)` 추가
- `mocks/handlers.ts` — benchmark 분기
- `components/benchmark/naive-bulk-list.tsx` — 신규
- `components/benchmark/rendering-bench.tsx` — 신규
- `app/benchmark/page.tsx` — 신규
- `benchmarks/phase-2/benchmark_compare.md` — 신규

## Test plan

- [ ] `http://localhost:3000` 기존 메인 페이지 정상 동작 (Phase 1 무변경)
- [ ] `http://localhost:3000/benchmark` 접속 확인
- [ ] [1,000건] 클릭 → 측정값 표시, PostCard 렌더링 확인
- [ ] [10,000건] 클릭 → 명확한 지연 체감
- [ ] [100,000건] 클릭 → 브라우저 프리징 후 결과 표시

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## 셀프 리뷰 체크리스트

- [x] **Spec 커버리지**: Task 5(10만건 렌더링) → Task 2+4+5 / Task 6(Profiler 측정) → Task 3+4 / Task 7(benchmark_compare.md) → Task 6
- [x] **Placeholder 없음**: 모든 코드 블록에 실제 코드 작성
- [x] **타입 일관성**: `PostListItem` 필드, `PostListResponse` 구조, `ProfilerOnRenderCallback` 시그니처 일치
- [x] **기존 코드 무변경**: `app/page.tsx`, `components/posts/post-list.tsx` 건드리지 않음
- [x] **MSW 경계**: `pageSize > 500`은 일반 페이지네이션(pageSize=20)과 겹치지 않음
