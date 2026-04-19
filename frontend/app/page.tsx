import { Pencil } from "lucide-react";
import Link from "next/link";
import { PostList } from "@/components/posts/post-list";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="max-w-3xl mx-auto w-full px-4 py-10">
      {/* 헤더 */}
      <div className="flex items-end justify-between mb-1 pb-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">극한 게시판</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            FE Phase 1 — Naive UI
          </p>
        </div>
        <Button asChild size="sm" className="gap-1.5 text-xs h-8">
          <Link href="/posts/new">
            <Pencil className="w-3.5 h-3.5" />글 작성
          </Link>
        </Button>
      </div>

      {/* 목록 */}
      <div className="border border-border rounded-lg overflow-hidden">
        <PostList />
      </div>
    </main>
  );
}
