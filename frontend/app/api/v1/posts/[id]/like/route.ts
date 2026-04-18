import type { NextRequest } from "next/server";
import { db } from "@/mocks/data";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const post = db.findPostById(id);
  if (!post) return Response.json({ detail: "Not found" }, { status: 404 });
  post.likeCount += 1;
  return Response.json({ likeCount: post.likeCount });
}
