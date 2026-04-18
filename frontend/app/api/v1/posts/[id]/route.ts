import type { NextRequest } from "next/server";
import { db } from "@/mocks/data";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const post = db.findPostById(id);
  if (!post) return Response.json({ detail: "Not found" }, { status: 404 });
  post.viewCount += 1;
  return Response.json(post);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json()) as { title?: string; content?: string };
  const post = db.updatePost(id, body);
  if (!post) return Response.json({ detail: "Not found" }, { status: 404 });
  return Response.json(post);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = db.deletePost(id);
  if (!ok) return Response.json({ detail: "Not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
