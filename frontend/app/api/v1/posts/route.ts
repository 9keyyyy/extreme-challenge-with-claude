import type { NextRequest } from "next/server";
import { db } from "@/mocks/data";

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("page_size") ?? "20");
  return Response.json(db.getPaginatedPosts(page, pageSize));
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    title: string;
    content: string;
    author: string;
  };
  const post = db.createPost(body);
  return Response.json(post, { status: 201 });
}
