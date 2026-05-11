import type { Post, PostListItem } from "@/types/post";

let postIdCounter = 1;

export function generatePost(overrides?: Partial<Post>): Post {
  const id = String(postIdCounter++);
  return {
    id,
    title: `테스트 게시글 ${id}`,
    content: `이것은 게시글 ${id}의 내용입니다. 극한 성능 챌린지를 위한 테스트 데이터입니다.`,
    author: `user${Math.floor(Math.random() * 100)}`,
    viewCount: Math.floor(Math.random() * 1000),
    likeCount: Math.floor(Math.random() * 100),
    commentCount: Math.floor(Math.random() * 50),
    createdAt: new Date(
      Date.now() - Math.random() * 86400000 * 30,
    ).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function generatePostListItem(
  overrides?: Partial<PostListItem>,
): PostListItem {
  const post = generatePost();
  return {
    id: post.id,
    title: post.title,
    author: post.author,
    viewCount: post.viewCount,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    createdAt: post.createdAt,
    ...overrides,
  };
}

export function generateNPostListItems(n: number): PostListItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    title: `벤치마크 게시글 ${i + 1}`,
    author: `user${i % 100}`,
    viewCount: i * 3,
    likeCount: i % 50,
    commentCount: i % 20,
    createdAt: new Date(Date.now() - i * 60000).toISOString(),
  }));
}

export const db = {
  posts: Array.from({ length: 20 }, () => generatePost()),

  findPostById(id: string): Post | undefined {
    return this.posts.find((p) => p.id === id);
  },

  createPost(input: { title: string; content: string; author: string }): Post {
    const post = generatePost(input);
    this.posts.unshift(post);
    return post;
  },

  updatePost(
    id: string,
    input: { title?: string; content?: string },
  ): Post | undefined {
    const post = this.posts.find((p) => p.id === id);
    if (!post) return undefined;
    Object.assign(post, input, { updatedAt: new Date().toISOString() });
    return post;
  },

  deletePost(id: string): boolean {
    const idx = this.posts.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.posts.splice(idx, 1);
    return true;
  },

  getPaginatedPosts(page: number, pageSize: number) {
    const start = (page - 1) * pageSize;
    const items: PostListItem[] = this.posts
      .slice(start, start + pageSize)
      .map((p) => ({
        id: p.id,
        title: p.title,
        author: p.author,
        viewCount: p.viewCount,
        likeCount: p.likeCount,
        commentCount: p.commentCount,
        createdAt: p.createdAt,
      }));
    return {
      items,
      total: this.posts.length,
      page,
      pageSize,
      hasNext: start + pageSize < this.posts.length,
    };
  },
};
