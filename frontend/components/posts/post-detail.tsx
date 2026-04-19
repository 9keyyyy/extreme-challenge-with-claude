"use client";

import {
  ArrowLeft,
  Eye,
  Heart,
  MessageSquare,
  Pencil,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { deletePost, fetchPost, likePost } from "@/lib/api/posts";
import type { Post } from "@/types/post";

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
      setPost((prev) =>
        prev ? { ...prev, likeCount: result.likeCount } : null,
      );
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

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-7 w-2/3" />
        <div className="flex gap-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Separator />
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!post) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        게시글을 찾을 수 없습니다
      </div>
    );
  }

  return (
    <article className="divide-y divide-border">
      {/* 헤더 */}
      <div className="px-6 py-5">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          목록으로
        </Link>
        <h1 className="text-xl font-semibold leading-snug tracking-tight mb-3">
          {post.title}
        </h1>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-mono text-muted-foreground">
            {post.author}
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs font-mono text-muted-foreground">
            {new Date(post.createdAt).toLocaleDateString("ko-KR", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="flex items-center gap-1 text-xs font-mono text-muted-foreground tabular-nums">
            <Eye className="w-3 h-3" />
            {post.viewCount.toLocaleString()}
          </span>
          <span className="flex items-center gap-1 text-xs font-mono text-muted-foreground tabular-nums">
            <MessageSquare className="w-3 h-3" />
            {post.commentCount}
          </span>
        </div>
      </div>

      {/* 본문 */}
      <div className="px-6 py-6">
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
          {post.content}
        </p>
      </div>

      {/* 액션 */}
      <div className="flex items-center justify-between px-6 py-4">
        <Button
          variant="outline"
          size="sm"
          onClick={handleLike}
          disabled={liking}
          className="gap-1.5 font-mono text-xs tabular-nums"
        >
          <Heart className={`w-3.5 h-3.5 ${liking ? "animate-pulse" : ""}`} />
          {post.likeCount}
        </Button>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            asChild
            className="gap-1.5 text-xs"
          >
            <Link href={`/posts/${post.id}/edit`}>
              <Pencil className="w-3.5 h-3.5" />
              수정
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDelete}
            className="gap-1.5 text-xs text-destructive hover:text-destructive hover:border-destructive"
          >
            <Trash2 className="w-3.5 h-3.5" />
            삭제
          </Button>
        </div>
      </div>
    </article>
  );
}
