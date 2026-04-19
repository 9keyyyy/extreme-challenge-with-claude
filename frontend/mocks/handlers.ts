import { HttpResponse, http } from "msw";
import { db } from "./data";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

function resolveParam(
  param: string | readonly string[] | undefined,
): string | undefined {
  if (typeof param === "string") return param;
  if (Array.isArray(param) && param.length > 0) return String(param[0]);
  return undefined;
}

export const handlers = [
  http.get(`${API_BASE}/api/v1/posts`, ({ request }) => {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const pageSize = Number(url.searchParams.get("page_size") ?? "20");
    return HttpResponse.json(db.getPaginatedPosts(page, pageSize));
  }),

  http.get(`${API_BASE}/api/v1/posts/:id`, ({ params }) => {
    const id = resolveParam(params.id);
    if (!id) return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    const post = db.findPostById(id);
    if (!post)
      return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    post.viewCount += 1;
    return HttpResponse.json(post);
  }),

  http.post(`${API_BASE}/api/v1/posts`, async ({ request }) => {
    const body = (await request.json()) as {
      title: string;
      content: string;
      author: string;
    };
    const post = db.createPost(body);
    return HttpResponse.json(post, { status: 201 });
  }),

  http.patch(`${API_BASE}/api/v1/posts/:id`, async ({ params, request }) => {
    const id = resolveParam(params.id);
    if (!id) return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    const body = (await request.json()) as { title?: string; content?: string };
    const post = db.updatePost(id, body);
    if (!post)
      return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    return HttpResponse.json(post);
  }),

  http.delete(`${API_BASE}/api/v1/posts/:id`, ({ params }) => {
    const id = resolveParam(params.id);
    if (!id) return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    const ok = db.deletePost(id);
    if (!ok) return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API_BASE}/api/v1/posts/:id/like`, ({ params }) => {
    const id = resolveParam(params.id);
    if (!id) return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    const post = db.findPostById(id);
    if (!post)
      return HttpResponse.json({ detail: "Not found" }, { status: 404 });
    post.likeCount += 1;
    return HttpResponse.json({ likeCount: post.likeCount });
  }),
];
