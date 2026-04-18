"use client";

import { use, useEffect, useState } from "react";
import { PostForm } from "@/components/posts/post-form";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchPost } from "@/lib/api/posts";
import type { Post } from "@/types/post";

interface Props {
  params: Promise<{ id: string }>;
}

export default function EditPostPage({ params }: Props) {
  const { id } = use(params);
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPost(id)
      .then(setPost)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <main className="max-w-3xl mx-auto w-full px-4 py-10">
        <div className="border border-border rounded-lg overflow-hidden p-6 space-y-4">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </main>
    );
  }

  if (!post) {
    return (
      <main className="max-w-3xl mx-auto w-full px-4 py-10">
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          게시글을 찾을 수 없습니다
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-3xl mx-auto w-full px-4 py-10">
      <div className="border border-border rounded-lg overflow-hidden">
        <PostForm mode="edit" post={post} />
      </div>
    </main>
  );
}
