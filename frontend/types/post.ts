export interface Post {
  id: string;
  title: string;
  content: string;
  author: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PostListItem {
  id: string;
  title: string;
  author: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  createdAt: string;
}

export interface PostListResponse {
  items: PostListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
}

export interface CreatePostInput {
  title: string;
  content: string;
  author: string;
}

export interface UpdatePostInput {
  title?: string;
  content?: string;
}

export interface Comment {
  id: string;
  postId: string;
  content: string;
  author: string;
  createdAt: string;
}
