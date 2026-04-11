# FE-1: 프로젝트 셋업 + Naive UI — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Next.js App Router 기반 게시판 프론트엔드를 셋업하고, 의도적으로 비최적화된 naive CRUD UI를 구현한다. 이후 Phase에서 개선할 기준값(baseline)을 측정한다.

**Architecture:** 백엔드 Phase 1이 완료될 때까지 msw(Mock Service Worker)로 API를 모킹. App Router Server Components + Client Components 혼합. 의도적으로 React.memo, useMemo 없이 구현하여 re-render 폭풍을 허용한다.

**Tech Stack:** Next.js 16.x, TypeScript 5.x (strict), Tailwind CSS 4.x, msw 2.x

**학습 목표:**
- Next.js App Router 구조 이해 (Server Component vs Client Component)
- Hydration이란 무엇인가 (서버 HTML → 클라이언트 React 이벤트 연결)
- React Rendering Pipeline: Reconciliation → Commit
- "왜 의도적으로 naive하게 만드는가?" → 병목을 직접 체험하기 위해

---

## 파일 구조

```
frontend/
├── src/
│   ├── app/
│   │   ├── layout.tsx                    # 루트 레이아웃 (새로 생성)
│   │   ├── page.tsx                      # 게시글 목록 (새로 생성)
│   │   ├── posts/
│   │   │   ├── [id]/
│   │   │   │   └── page.tsx              # 게시글 상세 (새로 생성)
│   │   │   └── new/
│   │   │       └── page.tsx              # 게시글 작성 (새로 생성)
│   ├── components/
│   │   └── posts/
│   │       ├── PostCard.tsx              # 목록 아이템 (새로 생성)
│   │       ├── PostList.tsx              # 목록 컨테이너 (새로 생성)
│   │       ├── PostForm.tsx              # 작성/수정 폼 (새로 생성)
│   │       └── PostDetail.tsx            # 상세 뷰 (새로 생성)
│   ├── lib/
│   │   └── api/
│   │       ├── client.ts                 # fetch wrapper (새로 생성)
│   │       └── posts.ts                  # 게시글 API 함수 (새로 생성)
│   ├── mocks/
│   │   ├── handlers.ts                   # msw 핸들러 (새로 생성)
│   │   ├── browser.ts                    # msw 브라우저 설정 (새로 생성)
│   │   └── data.ts                       # mock 데이터 생성 (새로 생성)
│   └── types/
│       └── post.ts                       # 타입 정의 (새로 생성)
├── public/
│   └── mockServiceWorker.js              # msw SW 파일 (msw init 자동 생성)
├── next.config.ts                        # 새로 생성
├── tailwind.config.ts                    # 새로 생성
├── tsconfig.json                         # 자동 생성
└── package.json                          # 자동 생성
```

---

## Task 1: Next.js 프로젝트 초기화

**Files:**
- Create: `frontend/` (디렉토리 전체)
- Create: `frontend/next.config.ts`
- Create: `frontend/src/types/post.ts`

### 1-1. 프로젝트 생성

- [ ] **Step 1: Next.js 프로젝트 생성**

프로젝트 루트(`extreme-challenge-with-claude/`)에서 실행:

```bash
cd /path/to/extreme-challenge-with-claude
npx create-next-app@latest frontend \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir \
  --no-turbopack \
  --import-alias "@/*"
```

> 프롬프트가 나오면: TypeScript → Yes, ESLint → Yes, Tailwind → Yes, src/ directory → Yes, App Router → Yes, Turbopack → No (안정성 우선)

- [ ] **Step 2: 의존성 설치 확인**

```bash
cd frontend
node --version   # v20+ 필요
npm --version
cat package.json | grep '"next"'  # 16.x 확인
```

- [ ] **Step 3: msw 설치**

```bash
npm install msw --save-dev
npx msw init public/ --save
```

Expected: `public/mockServiceWorker.js` 파일 생성

- [ ] **Step 4: TypeScript strict 설정 확인**

`tsconfig.json`에서 아래 옵션이 있는지 확인:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

없으면 `tsconfig.json`에 `"noUncheckedIndexedAccess": true` 추가.

- [ ] **Step 5: next.config.ts 설정**

`frontend/next.config.ts`를 다음으로 교체:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // FE-1: naive 구현 — 최적화 설정 없음
  // 이미지 최적화는 FE-8에서, 번들 분석은 FE-9에서 추가
};

export default nextConfig;
```

- [ ] **Step 6: 개발 서버 기동 확인**

```bash
npm run dev
```

Expected: `http://localhost:3000` 에서 Next.js 기본 페이지 렌더링

- [ ] **Step 7: 기본 파일 정리**

`src/app/page.tsx`의 기본 내용을 모두 삭제하고 placeholder로 교체:

```typescript
export default function Home() {
  return <main>게시판 준비 중</main>;
}
```

`src/app/globals.css`에서 기본 CSS 변수 블록을 유지하되 아래 내용만 남김:

```css
@import "tailwindcss";
```

### 1-2. 타입 정의

- [ ] **Step 8: Post 타입 정의 작성**

`src/types/post.ts` 생성:

```typescript
export interface Post {
  id: string;
  title: string;
  content: string;
  author: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export interface PostListItem {
  id: string;
  title: string;
  author: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  createdAt: string;
}

export interface PostListResponse {
  items: PostListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

export interface CreatePostInput {
  title: string;
  content: string;
  author: string;
}

export interface UpdatePostInput {
  title?: string;
  content?: string;
}

export interface Comment {
  id: string;
  postId: string;
  content: string;
  author: string;
  createdAt: string;
}
```

- [ ] **Step 9: 커밋**

```bash
git add frontend/
git commit -m "feat(fe): FE-1 Next.js 프로젝트 초기화 (App Router, TypeScript strict, Tailwind, msw)"
```

---

## Task 2: msw Mock API 설정

**Files:**
- Create: `frontend/src/mocks/data.ts`
- Create: `frontend/src/mocks/handlers.ts`
- Create: `frontend/src/mocks/browser.ts`
- Modify: `frontend/src/app/layout.tsx`

**학습**: msw는 Service Worker를 이용해 브라우저의 fetch 요청을 가로챈다. 백엔드 없이 프론트엔드를 독립적으로 개발할 수 있는 이유.

- [ ] **Step 1: Mock 데이터 생성 유틸 작성**

`src/mocks/data.ts` 생성:

```typescript
import type { Post, PostListItem, Comment } from "@/types/post";

let postIdCounter = 1;
let commentIdCounter = 1;

export function generatePost(overrides?: Partial<Post>): Post {
  const id = String(postIdCounter++);
  return {
    id,
    title: `테스트 게시글 ${id}`,
    content: `이것은 게시글 ${id}의 내용입니다. 극한 성능 챌린지를 위한 테스트 데이터입니다.`,
    author: `user${Math.floor(Math.random() * 100)}`,
    viewCount: Math.floor(Math.random() * 1000),
    likeCount: Math.floor(Math.random() * 100),
    commentCount: Math.floor(Math.random() * 50),
    createdAt: new Date(Date.now() - Math.random() * 86400000 * 30).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function generatePostListItem(overrides?: Partial<PostListItem>): PostListItem {
  const post = generatePost();
  return {
    id: post.id,
    title: post.title,
    author: post.author,
    viewCount: post.viewCount,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    createdAt: post.createdAt,
    ...overrides,
  };
}

// 인메모리 DB 역할
export const db = {
  posts: Array.from({ length: 20 }, () => generatePost()),

  findPostById(id: string): Post | undefined {
    return this.posts.find((p) => p.id === id);
  },

  createPost(input: { title: string; content: string; author: string }): Post {
    const post = generatePost(input);
    this.posts.unshift(post);
    return post;
  },

  updatePost(id: string, input: { title?: string; content?: string }): Post | undefined {
    const post = this.posts.find((p) => p.id === id);
    if (!post) return undefined;
    Object.assign(post, input, { updatedAt: new Date().toISOString() });
    return post;
  },

  deletePost(id: string): boolean {
    const idx = this.posts.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.posts.splice(idx, 1);
    return true;
  },

  getPaginatedPosts(page: number, pageSize: number) {
    const start = (page - 1) * pageSize;
    const items = this.posts.slice(start, start + pageSize).map((p) => ({
      id: p.id,
      title: p.title,
      author: p.author,
      viewCount: p.viewCount,
      likeCount: p.likeCount,
      commentCount: p.commentCount,
      createdAt: p.createdAt,
    }));
    return {
      items,
      total: this.posts.length,
      page,
      pageSize,
      hasNext: start + pageSize < this.posts.length,
    };
  },
};
```

- [ ] **Step 2: msw 핸들러 작성**

`src/mocks/handlers.ts` 생성:

```typescript
import { http, HttpResponse } from "msw";
import { db } from "./data";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export const handlers = [
  // 게시글 목록 (OFFSET 페이지네이션 — naive)
  http.get(`${API_BASE}/api/v1/posts`, ({ request }) => {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const pageSize = Number(url.searchParams.get("page_size") ?? "20");
    return HttpResponse.json(db.getPaginatedPosts(page, pageSize));
  }),

  // 게시글 상세
  http.get(`${API_BASE}/api/v1/posts/:id`, ({ params }) => {
    const post = db.findPostById(String(params["id"]));
    if (!post) {
      return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    }
    post.viewCount += 1; // 조회수 증가 (naive: 매 요청마다)
    return HttpResponse.json(post);
  }),

  // 게시글 작성
  http.post(`${API_BASE}/api/v1/posts`, async ({ request }) => {
    const body = (await request.json()) as {
      title: string;
      content: string;
      author: string;
    };
    const post = db.createPost(body);
    return HttpResponse.json(post, { status: 201 });
  }),

  // 게시글 수정
  http.patch(`${API_BASE}/api/v1/posts/:id`, async ({ params, request }) => {
    const body = (await request.json()) as { title?: string; content?: string };
    const post = db.updatePost(String(params["id"]), body);
    if (!post) {
      return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    }
    return HttpResponse.json(post);
  }),

  // 게시글 삭제
  http.delete(`${API_BASE}/api/v1/posts/:id`, ({ params }) => {
    const ok = db.deletePost(String(params["id"]));
    if (!ok) {
      return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // 좋아요 토글
  http.post(`${API_BASE}/api/v1/posts/:id/like`, ({ params }) => {
    const post = db.findPostById(String(params["id"]));
    if (!post) {
      return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    }
    post.likeCount += 1; // naive: 중복 허용
    return HttpResponse.json({ likeCount: post.likeCount });
  }),
];
```

- [ ] **Step 3: msw 브라우저 설정 작성**

`src/mocks/browser.ts` 생성:

```typescript
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);
```

- [ ] **Step 4: MSW Provider 컴포넌트 작성**

`src/mocks/MSWProvider.tsx` 생성:

```typescript
"use client";

import { useEffect, useState } from "react";

export function MSWProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") {
      setReady(true);
      return;
    }
    import("./browser").then(({ worker }) => {
      worker.start({ onUnhandledRequest: "bypass" }).then(() => setReady(true));
    });
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}
```

- [ ] **Step 5: 루트 레이아웃에 MSWProvider 연결**

`src/app/layout.tsx`를 다음으로 교체:

```typescript
import type { Metadata } from "next";
import "./globals.css";
import { MSWProvider } from "@/mocks/MSWProvider";

export const metadata: Metadata = {
  title: "극한 게시판",
  description: "극한 트래픽 게시판 프론트엔드 챌린지",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <MSWProvider>{children}</MSWProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 6: 환경변수 파일 생성**

`frontend/.env.local` 생성:

```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

`frontend/.env.local`을 `.gitignore`에 추가 (이미 있으면 skip):

```bash
echo ".env.local" >> .gitignore
```

- [ ] **Step 7: 개발 서버에서 msw 동작 확인**

```bash
npm run dev
```

브라우저 콘솔에서 확인:
```
[MSW] Mocking enabled.
```

- [ ] **Step 8: 커밋**

```bash
git add frontend/src/mocks/ frontend/src/app/layout.tsx frontend/src/types/ frontend/.gitignore
git commit -m "feat(fe): FE-1 msw mock API 설정 (게시글 CRUD 핸들러)"
```

---

## Task 3: API 클라이언트 레이어

**Files:**
- Create: `frontend/src/lib/api/client.ts`
- Create: `frontend/src/lib/api/posts.ts`

**학습**: fetch wrapper를 직접 만드는 이유 — 에러 처리 일관성, 베이스 URL 중앙화, 향후 인터셉터 추가 용이성.

- [ ] **Step 1: fetch 기본 클라이언트 작성**

`src/lib/api/client.ts` 생성:

```typescript
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(response.status, body);
  }

  // 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
```

- [ ] **Step 2: 게시글 API 함수 작성**

`src/lib/api/posts.ts` 생성:

```typescript
import { apiFetch } from "./client";
import type {
  Post,
  PostListResponse,
  CreatePostInput,
  UpdatePostInput,
} from "@/types/post";

export async function fetchPosts(
  page = 1,
  pageSize = 20,
): Promise<PostListResponse> {
  return apiFetch(`/api/v1/posts?page=${page}&page_size=${pageSize}`);
}

export async function fetchPost(id: string): Promise<Post> {
  return apiFetch(`/api/v1/posts/${id}`);
}

export async function createPost(input: CreatePostInput): Promise<Post> {
  return apiFetch("/api/v1/posts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updatePost(
  id: string,
  input: UpdatePostInput,
): Promise<Post> {
  return apiFetch(`/api/v1/posts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deletePost(id: string): Promise<void> {
  return apiFetch(`/api/v1/posts/${id}`, { method: "DELETE" });
}

export async function likePost(id: string): Promise<{ likeCount: number }> {
  return apiFetch(`/api/v1/posts/${id}/like`, { method: "POST" });
}
```

- [ ] **Step 3: API 클라이언트 수동 테스트**

개발 서버(`npm run dev`)가 실행 중인 상태에서, 브라우저 콘솔에서:

```javascript
fetch("http://localhost:8000/api/v1/posts")
  .then(r => r.json())
  .then(console.log)
```

Expected: msw가 가로채서 mock 데이터 반환 (items 배열 20개)

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/lib/
git commit -m "feat(fe): FE-1 API 클라이언트 레이어 (fetch wrapper, posts API)"
```

---

## Task 4: Naive 게시글 목록 페이지

**Files:**
- Create: `frontend/src/components/posts/PostCard.tsx`
- Create: `frontend/src/components/posts/PostList.tsx`
- Modify: `frontend/src/app/page.tsx`

**핵심 의도**: 의도적으로 비최적화. React.memo 없음, useCallback 없음, 모든 컴포넌트가 부모 re-render 시 함께 re-render됨. FE-2에서 이 문제를 측정한다.

- [ ] **Step 1: PostCard 컴포넌트 작성 (naive)**

`src/components/posts/PostCard.tsx` 생성:

```typescript
"use client";

import type { PostListItem } from "@/types/post";
import Link from "next/link";

// 의도적으로 React.memo 없음 — FE-2에서 re-render 측정 예정
export function PostCard({ post }: { post: PostListItem }) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors">
      <Link href={`/posts/${post.id}`}>
        <h2 className="text-lg font-semibold text-gray-900 mb-1 hover:text-blue-600">
          {post.title}
        </h2>
      </Link>
      <div className="flex items-center gap-4 text-sm text-gray-500">
        <span>{post.author}</span>
        <span>조회 {post.viewCount.toLocaleString()}</span>
        <span>좋아요 {post.likeCount}</span>
        <span>댓글 {post.commentCount}</span>
        <span>{new Date(post.createdAt).toLocaleDateString("ko-KR")}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: PostList 컴포넌트 작성 (naive)**

`src/components/posts/PostList.tsx` 생성:

```typescript
"use client";

import { useState, useEffect } from "react";
import { fetchPosts } from "@/lib/api/posts";
import type { PostListItem } from "@/types/post";
import { PostCard } from "./PostCard";

// 의도적으로 naive: 전체 fetch, OFFSET 페이지네이션, 캐싱 없음
export function PostList() {
  const [posts, setPosts] = useState<PostListItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pageSize = 20;
  const totalPages = Math.ceil(total / pageSize);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchPosts(page, pageSize)
      .then((res) => {
        setPosts(res.items);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "오류가 발생했습니다");
      })
      .finally(() => setLoading(false));
  }, [page]); // page 변경마다 전체 목록 재요청 (naive)

  if (loading) return <div className="text-center py-8">로딩 중...</div>;
  if (error) return <div className="text-center py-8 text-red-500">{error}</div>;

  return (
    <div>
      <div className="flex flex-col gap-3">
        {posts.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>

      {/* OFFSET 페이지네이션 (naive) */}
      <div className="flex justify-center items-center gap-2 mt-8">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          className="px-4 py-2 border rounded disabled:opacity-50"
        >
          이전
        </button>
        <span className="text-sm text-gray-600">
          {page} / {totalPages} 페이지 (총 {total.toLocaleString()}개)
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          className="px-4 py-2 border rounded disabled:opacity-50"
        >
          다음
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 게시글 목록 페이지 작성**

`src/app/page.tsx`를 다음으로 교체:

```typescript
import Link from "next/link";
import { PostList } from "@/components/posts/PostList";

export default function HomePage() {
  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">극한 게시판</h1>
        <Link
          href="/posts/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          글 작성
        </Link>
      </div>
      <PostList />
    </main>
  );
}
```

- [ ] **Step 4: 브라우저에서 목록 동작 확인**

```bash
npm run dev
```

`http://localhost:3000` 접속 → 게시글 20개 목록, 페이지네이션 동작 확인

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/components/ frontend/src/app/page.tsx
git commit -m "feat(fe): FE-1 naive 게시글 목록 (OFFSET 페이지네이션, 캐싱 없음)"
```

---

## Task 5: 게시글 상세 + 작성 페이지

**Files:**
- Create: `frontend/src/components/posts/PostDetail.tsx`
- Create: `frontend/src/components/posts/PostForm.tsx`
- Create: `frontend/src/app/posts/[id]/page.tsx`
- Create: `frontend/src/app/posts/new/page.tsx`

- [ ] **Step 1: PostDetail 컴포넌트 작성**

`src/components/posts/PostDetail.tsx` 생성:

```typescript
"use client";

import { useState, useEffect } from "react";
import { fetchPost, likePost, deletePost } from "@/lib/api/posts";
import type { Post } from "@/types/post";
import { useRouter } from "next/navigation";
import Link from "next/link";

export function PostDetail({ id }: { id: string }) {
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liking, setLiking] = useState(false);
  const router = useRouter();

  useEffect(() => {
    fetchPost(id)
      .then(setPost)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "오류가 발생했습니다");
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function handleLike() {
    if (!post) return;
    setLiking(true);
    try {
      const result = await likePost(post.id);
      setPost((prev) => prev ? { ...prev, likeCount: result.likeCount } : null);
    } catch {
      alert("좋아요 실패");
    } finally {
      setLiking(false);
    }
  }

  async function handleDelete() {
    if (!post || !confirm("삭제하시겠습니까?")) return;
    try {
      await deletePost(post.id);
      router.push("/");
    } catch {
      alert("삭제 실패");
    }
  }

  if (loading) return <div className="text-center py-8">로딩 중...</div>;
  if (error) return <div className="text-center py-8 text-red-500">{error}</div>;
  if (!post) return <div className="text-center py-8">게시글을 찾을 수 없습니다</div>;

  return (
    <article className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          ← 목록으로
        </Link>
      </div>

      <h1 className="text-2xl font-bold mb-4">{post.title}</h1>

      <div className="flex items-center gap-4 text-sm text-gray-500 mb-6 pb-4 border-b">
        <span>{post.author}</span>
        <span>조회 {post.viewCount.toLocaleString()}</span>
        <span>{new Date(post.createdAt).toLocaleDateString("ko-KR")}</span>
      </div>

      <div className="prose max-w-none mb-8 whitespace-pre-wrap">
        {post.content}
      </div>

      <div className="flex gap-4">
        <button
          onClick={handleLike}
          disabled={liking}
          className="flex items-center gap-2 px-4 py-2 border rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          👍 좋아요 {post.likeCount}
        </button>
        <Link
          href={`/posts/${post.id}/edit`}
          className="px-4 py-2 border rounded-lg hover:bg-gray-50"
        >
          수정
        </Link>
        <button
          onClick={handleDelete}
          className="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50"
        >
          삭제
        </button>
      </div>
    </article>
  );
}
```

- [ ] **Step 2: PostForm 컴포넌트 작성 (작성/수정 공용)**

`src/components/posts/PostForm.tsx` 생성:

```typescript
"use client";

import { useState } from "react";
import { createPost, updatePost } from "@/lib/api/posts";
import { useRouter } from "next/navigation";
import type { Post, CreatePostInput } from "@/types/post";

interface PostFormProps {
  mode: "create" | "edit";
  post?: Post;
}

export function PostForm({ mode, post }: PostFormProps) {
  const router = useRouter();
  const [title, setTitle] = useState(post?.title ?? "");
  const [content, setContent] = useState(post?.content ?? "");
  const [author, setAuthor] = useState(post?.author ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim()) {
      setError("제목과 내용을 입력해주세요");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (mode === "create") {
        const input: CreatePostInput = { title, content, author: author || "익명" };
        const created = await createPost(input);
        router.push(`/posts/${created.id}`);
      } else if (post) {
        await updatePost(post.id, { title, content });
        router.push(`/posts/${post.id}`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "오류가 발생했습니다");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">
        {mode === "create" ? "글 작성" : "글 수정"}
      </h1>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-300 text-red-600 rounded">
          {error}
        </div>
      )}

      {mode === "create" && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            작성자
          </label>
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="작성자 이름"
            className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          제목
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="제목을 입력하세요"
          className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          내용
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="내용을 입력하세요"
          rows={10}
          className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          required
        />
      </div>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "저장 중..." : mode === "create" ? "작성" : "수정"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="border px-6 py-2 rounded-lg hover:bg-gray-50"
        >
          취소
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: 상세 페이지 작성**

`src/app/posts/[id]/page.tsx` 생성:

```typescript
import { PostDetail } from "@/components/posts/PostDetail";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function PostDetailPage({ params }: Props) {
  const { id } = await params;
  return <PostDetail id={id} />;
}
```

- [ ] **Step 4: 작성 페이지 작성**

`src/app/posts/new/page.tsx` 생성:

```typescript
import { PostForm } from "@/components/posts/PostForm";

export default function NewPostPage() {
  return <PostForm mode="create" />;
}
```

- [ ] **Step 5: 수정 페이지 추가**

`src/app/posts/[id]/edit/page.tsx` 생성:

```typescript
import { PostForm } from "@/components/posts/PostForm";
import { fetchPost } from "@/lib/api/posts";
import { notFound } from "next/navigation";

interface Props {
  params: Promise<{ id: string }>;
}

// Server Component — params를 async로 처리 (Next.js 16)
export default async function EditPostPage({ params }: Props) {
  const { id } = await params;
  let post;
  try {
    post = await fetchPost(id);
  } catch {
    notFound();
  }
  return <PostForm mode="edit" post={post} />;
}
```

> **주의**: msw는 브라우저 Service Worker 기반이라 브라우저에서 발생한 요청만 가로챈다. 따라서 Server Component에서 `fetchPost`를 직접 호출하면 FE-1의 기본 msw 설정으로는 인터셉트되지 않는다. 다만 `PostForm`이 Client Component라는 이유만으로 초기 데이터를 props로 주입할 수 없는 것은 아니다. Server Component에서 가져온 직렬화 가능한 데이터(plain object)는 `mode="edit"`와 함께 `post` props로 전달할 수 있다. 실제 제약은 "어디서 fetch가 실행되느냐"이다. 해결 방법은 (1) 서버에서도 모킹이 필요하면 `msw/node` 등으로 서버측 요청까지 모킹하거나, (2) FE-1에서는 edit 페이지 또는 수정 폼에서 클라이언트에서 직접 fetch하도록 구성하는 것이다.
>
> **FE-1에서의 실용적 접근**: `src/app/posts/[id]/edit/page.tsx`를 Client Component로 작성:

```typescript
"use client";

import { useState, useEffect, use } from "react";
import { fetchPost } from "@/lib/api/posts";
import type { Post } from "@/types/post";
import { PostForm } from "@/components/posts/PostForm";

interface Props {
  params: Promise<{ id: string }>;
}

export default function EditPostPage({ params }: Props) {
  const { id } = use(params);
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPost(id).then(setPost).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="text-center py-8">로딩 중...</div>;
  if (!post) return <div className="text-center py-8">게시글을 찾을 수 없습니다</div>;

  return <PostForm mode="edit" post={post} />;
}
```

- [ ] **Step 6: 전체 CRUD 동작 확인**

브라우저에서 순서대로 확인:
1. `http://localhost:3000` → 목록 20개 표시
2. 게시글 클릭 → 상세 페이지 이동, 조회수 증가
3. 좋아요 버튼 클릭 → 카운트 증가
4. 글 작성 → 목록에 추가 확인
5. 수정 → 내용 변경 확인
6. 삭제 → 목록에서 제거 확인

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/components/posts/PostDetail.tsx \
        frontend/src/components/posts/PostForm.tsx \
        frontend/src/app/posts/
git commit -m "feat(fe): FE-1 게시글 상세/작성/수정/삭제 페이지 (naive CRUD)"
```

---

## Task 6: 기준값 측정 (Baseline Benchmark)

**Files:**
- Create: `frontend/benchmarks/fe-phase-01-baseline.md`

**목적**: FE-2에서 병목을 체험하고 FE-3~에서 최적화 후 비교할 기준값 확보.

- [ ] **Step 1: Lighthouse 기준값 측정**

```bash
# 프로덕션 빌드로 측정 (개발 서버는 번들이 최적화되지 않아 결과 왜곡)
npm run build
npm run start
```

Chrome에서 `http://localhost:3000` 열고 DevTools → Lighthouse → Performance 실행.

결과를 기록: Performance 점수, LCP, TBT, CLS 수치

- [ ] **Step 2: React Profiler 기준값 측정**

개발 서버(`npm run dev`)에서:
1. React DevTools 설치 (Chrome 확장)
2. Profiler 탭 → Record 시작
3. 페이지 목록 렌더링 → Record 중지
4. PostList, PostCard 렌더링 시간 기록

- [ ] **Step 3: 기준값 문서 작성**

`frontend/benchmarks/fe-phase-01-baseline.md` 생성:

```markdown
# FE-1 기준값 (Baseline)

측정일: 2026-04-07
환경: MacBook (로컬), Chrome, 3G 없음

## Lighthouse (프로덕션 빌드)

| 지표 | 값 |
|------|-----|
| Performance 점수 | [측정값] |
| LCP | [측정값] |
| TBT | [측정값] |
| CLS | [측정값] |

## React Profiler (개발 서버)

| 컴포넌트 | 렌더링 시간 | 렌더링 횟수 |
|---------|-----------|-----------|
| PostList | [측정값] | [측정값] |
| PostCard (×20) | [측정값] | [측정값] |

## 번들 크기 (빌드 결과)

| 파일 | 크기 |
|------|------|
| page.js (메인) | [측정값] |
| 전체 JS | [측정값] |

## 메모리 사용량

초기 로딩 후: [측정값] MB

---

다음 측정: FE-2 (10만건 렌더링 시 병목 체험)
```

- [ ] **Step 4: 최종 커밋**

```bash
git add frontend/benchmarks/
git commit -m "feat(fe): FE-1 기준값 측정 완료 (Lighthouse, Profiler, 번들 크기)"
```

---

## Phase 완료 체크리스트

- [ ] `npm run dev` 실행 시 msw 정상 동작
- [ ] 게시글 목록 → 상세 → 작성 → 수정 → 삭제 CRUD 전체 동작
- [ ] TypeScript 에러 없음 (`npx tsc --noEmit`)
- [ ] ESLint 에러 없음 (`npm run lint`)
- [ ] `benchmarks/fe-phase-01-baseline.md`에 기준값 기록 완료
- [ ] 커밋 4개 이상 완료

## 다음 Phase

→ **FE-2**: msw mock 데이터를 10만건으로 늘리고, 목록 전체를 렌더링하여 브라우저 프리징을 체험한다.

**학습 예습**: React Reconciliation은 O(n)이다. 10만개의 DOM 노드가 생성될 때 Layout/Paint 비용이 어떻게 되는지 미리 생각해보자.
