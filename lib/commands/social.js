import { Command } from 'commander';
import { getTableRows } from '../lib/chain.js';
import { addJsonActionCommand } from './action-fields.js';
const SOCIAL_CONTRACT = process.env.HARBOR_SOCIAL_CONTRACT ?? 'harborsocial';
const DEFAULT_URL = process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888';
export function visibleSocialPosts(posts, includeArchived = false) {
    return posts
        .filter((post) => includeArchived || Number(post.status) === 1)
        .sort((a, b) => Number(b.id) - Number(a.id));
}
export function visibleSocialComments(comments, postId, includeDeleted = false) {
    return comments
        .filter((comment) => Number(comment.post_id) === postId)
        .filter((comment) => includeDeleted || Number(comment.status) === 1)
        .sort((a, b) => Number(a.id) - Number(b.id));
}
async function loadPosts(options) {
    const response = await getTableRows(options.url, options.contract, 'posts', { limit: 1000 });
    return response.rows;
}
async function loadComments(options) {
    const response = await getTableRows(options.url, options.contract, 'comments', { limit: 1000 });
    return response.rows;
}
function printRows(rows, json) {
    if (json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
    }
    console.table(rows);
}
function addReadOptions(command) {
    return command
        .option('-u, --url <url>', 'Harbor chain API URL', DEFAULT_URL)
        .option('-c, --contract <account>', 'social contract account', SOCIAL_CONTRACT)
        .option('--json', 'print JSON');
}
function addSocialReadCommands(social) {
    addReadOptions(social
        .command('feed')
        .description('Read the public social feed')
        .option('--include-archived', 'include archived posts')).action(async (options) => {
        printRows(visibleSocialPosts(await loadPosts(options), options.includeArchived), options.json);
    });
    addReadOptions(social
        .command('post <id>')
        .description('Read one public social post')
        .option('--include-archived', 'include archived posts')).action(async (id, options) => {
        const post = visibleSocialPosts(await loadPosts(options), options.includeArchived).find((row) => Number(row.id) === Number(id));
        if (!post) {
            throw new Error(`post not found: ${id}`);
        }
        printRows(post, options.json);
    });
    addReadOptions(social
        .command('comments <post_id>')
        .description('Read comments for one public social post')
        .option('--include-deleted', 'include deleted comments')).action(async (postId, options) => {
        printRows(visibleSocialComments(await loadComments(options), Number(postId), options.includeDeleted), options.json);
    });
}
function addSocialActionCommands(social) {
    addJsonActionCommand(social, SOCIAL_CONTRACT, {
        command: 'configure',
        action: 'setparams',
        fields: [
            'storage_contract',
            ['max_title_size', 'number'],
            ['max_excerpt_size', 'number'],
            ['max_tags', 'number'],
            ['max_tag_size', 'number'],
            ['max_comment_size', 'number'],
        ],
    });
    addJsonActionCommand(social, SOCIAL_CONTRACT, {
        command: 'publish',
        action: 'publish',
        fields: ['author', ['kind', 'number'], 'title', 'excerpt', ['tags', 'json'], ['body_object_id', 'number'], 'body_hash', ['cover_object_id', 'number'], 'cover_hash'],
        signerField: 'author',
    });
    addJsonActionCommand(social, SOCIAL_CONTRACT, {
        command: 'edit',
        action: 'edit',
        fields: ['author', ['post_id', 'number'], 'title', 'excerpt', ['tags', 'json'], ['body_object_id', 'number'], 'body_hash', ['cover_object_id', 'number'], 'cover_hash'],
        signerField: 'author',
    });
    addJsonActionCommand(social, SOCIAL_CONTRACT, {
        command: 'archive',
        action: 'archive',
        fields: ['author', ['post_id', 'number']],
        signerField: 'author',
    });
    addJsonActionCommand(social, SOCIAL_CONTRACT, {
        command: 'comment',
        action: 'comment',
        fields: ['author', ['post_id', 'number'], 'body'],
        signerField: 'author',
    });
    addJsonActionCommand(social, SOCIAL_CONTRACT, {
        command: 'delete-comment',
        action: 'delcomment',
        fields: ['actor', ['comment_id', 'number']],
        signerField: 'actor',
    });
    addJsonActionCommand(social, SOCIAL_CONTRACT, {
        command: 'like',
        action: 'like',
        fields: ['account', ['post_id', 'number']],
        signerField: 'account',
    });
    addJsonActionCommand(social, SOCIAL_CONTRACT, {
        command: 'unlike',
        action: 'unlike',
        fields: ['account', ['post_id', 'number']],
        signerField: 'account',
    });
}
export function createSocialCommand() {
    const social = new Command('social');
    social.description('Manage Harbor Social posts and articles');
    addSocialReadCommands(social);
    addSocialActionCommands(social);
    return social;
}
