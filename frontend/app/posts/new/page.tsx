import { PostForm } from "@/components/posts/post-form";

export default function NewPostPage() {
  return (
    <main className="max-w-3xl mx-auto w-full px-4 py-10">
      <div className="border border-border rounded-lg overflow-hidden">
        <PostForm mode="create" />
      </div>
    </main>
  );
}
