"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchPosts } from "@/lib/api/posts";
import type { PostListItem } from "@/types/post";
import { PostCard } from "./post-card";

// 의도적으로 naive: 전체 fetch, OFFSET 페이지네이션, 캐싱 없음
export function PostList() {
  const [posts, setPosts] = useState<PostListItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pageSize = 20;
  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);

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
  }, [page]);

  if (error) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-destructive">
        {error}
      </div>
    );
  }

  return (
    <div>
      {/* 헤더 메타 */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-border bg-muted/30">
        <span className="text-xs text-muted-foreground font-mono">
          총{" "}
          <span className="text-foreground font-semibold tabular-nums">
            {total.toLocaleString()}
          </span>
          개
        </span>
        <span className="text-xs text-muted-foreground font-mono">
          {page} / {totalPages} 페이지
        </span>
      </div>

      {/* 목록 */}
      <div>
        {loading
          ? Array.from({ length: 8 }, (_, i) => `skeleton-${i}`).map((key) => (
              <div
                key={key}
                className="grid grid-cols-[1fr_auto] items-center gap-6 px-5 py-3.5 border-b border-border"
              >
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
                <div className="flex gap-4">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 w-8" />
                  <Skeleton className="h-3 w-8" />
                </div>
              </div>
            ))
          : posts.map((post) => <PostCard key={post.id} post={post} />)}
      </div>

      {/* 페이지네이션 */}
      <div className="flex items-center justify-center gap-2 px-5 py-4 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          className="h-7 w-7 p-0"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </Button>

        <div className="flex items-center gap-1">
          {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
            const pageNum = i + 1;
            return (
              <Button
                key={pageNum}
                variant={page === pageNum ? "default" : "ghost"}
                size="sm"
                onClick={() => setPage(pageNum)}
                className="h-7 w-7 p-0 text-xs font-mono"
              >
                {pageNum}
              </Button>
            );
          })}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          className="h-7 w-7 p-0"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}
