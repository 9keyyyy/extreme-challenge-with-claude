import { PostDetail } from "@/components/posts/post-detail";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function PostDetailPage({ params }: Props) {
  const { id } = await params;
  return (
    <main className="max-w-3xl mx-auto w-full px-4 py-10">
      <div className="border border-border rounded-lg overflow-hidden">
        <PostDetail id={id} />
      </div>
    </main>
  );
}
