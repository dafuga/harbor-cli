import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleSocialComments, visibleSocialPosts } from './social.js';
function post(id, status) {
    return {
        id,
        author: 'alice',
        kind: 2,
        status,
        title: `Post ${id}`,
        excerpt: '',
        tags: [],
        body_object_id: id,
        body_hash: `${id}`.padStart(64, '0'),
        cover_object_id: 0,
        cover_hash: '0'.repeat(64),
        comment_count: 0,
        like_count: 0,
        created_at: '2026-05-06T00:00:00',
        updated_at: '2026-05-06T00:00:00',
    };
}
function comment(id, postId, status) {
    return {
        id,
        post_id: postId,
        author: 'bob',
        status,
        body: `Comment ${id}`,
        created_at: '2026-05-06T00:00:00',
        updated_at: '2026-05-06T00:00:00',
    };
}
test('social feed hides archived posts by default', () => {
    assert.deepEqual(visibleSocialPosts([post(1, 1), post(2, 2), post(3, 1)]).map((row) => row.id), [3, 1]);
    assert.deepEqual(visibleSocialPosts([post(1, 1), post(2, 2)], true).map((row) => row.id), [2, 1]);
});
test('social comments hide deleted comments by default', () => {
    assert.deepEqual(visibleSocialComments([comment(1, 1, 1), comment(2, 1, 2), comment(3, 2, 1)], 1).map((row) => row.id), [1]);
    assert.deepEqual(visibleSocialComments([comment(1, 1, 1), comment(2, 1, 2)], 1, true).map((row) => row.id), [1, 2]);
});
