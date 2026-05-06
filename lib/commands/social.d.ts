import { Command } from 'commander';
export interface SocialPostRow {
    id: number;
    author: string;
    kind: number;
    status: number;
    title: string;
    excerpt: string;
    tags: string[];
    body_object_id: number;
    body_hash: string;
    cover_object_id: number;
    cover_hash: string;
    comment_count: number;
    like_count: number;
    created_at: string;
    updated_at: string;
}
export interface SocialCommentRow {
    id: number;
    post_id: number;
    author: string;
    status: number;
    body: string;
    created_at: string;
    updated_at: string;
}
export declare function visibleSocialPosts(posts: SocialPostRow[], includeArchived?: boolean): SocialPostRow[];
export declare function visibleSocialComments(comments: SocialCommentRow[], postId: number, includeDeleted?: boolean): SocialCommentRow[];
export declare function createSocialCommand(): Command;
