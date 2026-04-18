import type {
  CreatePostInput,
  Post,
  PostListResponse,
  UpdatePostInput,
} from "@/types/post";
import { apiFetch } from "./client";

export async function fetchPosts(
  page = 1,
  pageSize = 20,
): Promise<PostListResponse> {
  return apiFetch(`/api/v1/posts?page=${page}&page_size=${pageSize}`);
}

export async function fetchPost(id: string): Promise<Post> {
  return apiFetch(`/api/v1/posts/${id}`);
}

export async function createPost(input: CreatePostInput): Promise<Post> {
  return apiFetch("/api/v1/posts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updatePost(
  id: string,
  input: UpdatePostInput,
): Promise<Post> {
  return apiFetch(`/api/v1/posts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deletePost(id: string): Promise<void> {
  return apiFetch(`/api/v1/posts/${id}`, { method: "DELETE" });
}

export async function likePost(id: string): Promise<{ likeCount: number }> {
  return apiFetch(`/api/v1/posts/${id}/like`, { method: "POST" });
}
