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
