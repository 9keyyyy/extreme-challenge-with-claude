"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createPost, updatePost } from "@/lib/api/posts";
import type { CreatePostInput, Post } from "@/types/post";

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
        const input: CreatePostInput = {
          title,
          content,
          author: author || "익명",
        };
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
    <form onSubmit={handleSubmit} className="divide-y divide-border">
      {/* 헤더 */}
      <div className="px-6 py-5">
        <h1 className="text-lg font-semibold tracking-tight">
          {mode === "create" ? "새 글 작성" : "글 수정"}
        </h1>
      </div>

      {/* 필드 */}
      <div className="px-6 py-6 space-y-5">
        {error && (
          <p className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {mode === "create" && (
          <div className="space-y-1.5">
            <Label
              htmlFor="author"
              className="text-xs font-medium text-muted-foreground"
            >
              작성자
            </Label>
            <Input
              id="author"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="닉네임 (비워두면 익명)"
              className="text-sm h-9"
            />
          </div>
        )}

        <div className="space-y-1.5">
          <Label
            htmlFor="title"
            className="text-xs font-medium text-muted-foreground"
          >
            제목
          </Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="제목을 입력하세요"
            className="text-sm h-9"
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="content"
            className="text-xs font-medium text-muted-foreground"
          >
            내용
          </Label>
          <Textarea
            id="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="내용을 입력하세요"
            rows={12}
            className="text-sm resize-none"
            required
          />
        </div>
      </div>

      {/* 액션 */}
      <div className="flex items-center justify-end gap-2 px-6 py-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.back()}
          className="text-xs"
        >
          취소
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={submitting}
          className="text-xs"
        >
          {submitting ? "저장 중..." : mode === "create" ? "작성" : "수정"}
        </Button>
      </div>
    </form>
  );
}
