"use client";

import { Eye, Heart, MessageSquare } from "lucide-react";
import Link from "next/link";
import type { PostListItem } from "@/types/post";

// 의도적으로 React.memo 없음 — FE-2에서 re-render 측정 예정
export function PostCard({ post }: { post: PostListItem }) {
  const date = new Date(post.createdAt).toLocaleDateString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
  });

  return (
    <div className="group grid grid-cols-[1fr_auto] items-center gap-6 px-5 py-3.5 border-b border-border last:border-0 hover:bg-muted/40 transition-colors">
      <div className="min-w-0">
        <Link
          href={`/posts/${post.id}`}
          className="text-sm font-medium leading-snug hover:text-primary transition-colors line-clamp-1"
        >
          {post.title}
        </Link>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-xs text-muted-foreground font-mono">
            {post.author}
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground font-mono">
            {date}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4 shrink-0">
        <span className="flex items-center gap-1 text-xs text-muted-foreground font-mono tabular-nums">
          <Eye className="w-3 h-3" />
          {post.viewCount.toLocaleString()}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground font-mono tabular-nums">
          <Heart className="w-3 h-3" />
          {post.likeCount}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground font-mono tabular-nums">
          <MessageSquare className="w-3 h-3" />
          {post.commentCount}
        </span>
      </div>
    </div>
  );
}
