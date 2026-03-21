/**
 * PR Comment Service — gh API wrapper with guardrails
 *
 * Scoped to a single PR. Read and append only — no delete or edit methods.
 */

import { execFileSync } from 'child_process';
import type { PRIdentifier, PRComment, PRCommentThread } from './review-types.js';

// ============================================================================
// PRCommentService
// ============================================================================

export class PRCommentService {
  private pr: PRIdentifier;
  private changedFilesCache: string[] | null = null;

  constructor(pr: PRIdentifier) {
    this.pr = pr;
  }

  // ==========================================================================
  // List Comments
  // ==========================================================================

  /**
   * List all comments on the PR (both review comments and issue comments).
   * Returns a unified list sorted by creation date.
   */
  listComments(): PRComment[] {
    const repo = `${this.pr.owner}/${this.pr.repo}`;
    const comments: PRComment[] = [];

    // Fetch review comments (inline on diff)
    try {
      const reviewJson = execFileSync('gh', [
        'api', `repos/${repo}/pulls/${this.pr.number}/comments`,
        '--paginate',
      ], { encoding: 'utf-8' });
      const reviewComments = JSON.parse(reviewJson);
      for (const c of reviewComments) {
        comments.push({
          id: c.id,
          body: c.body || '',
          author: c.user?.login || '',
          file: c.path || undefined,
          line: c.line || c.original_line || undefined,
          side: c.side || undefined,
          inReplyToId: c.in_reply_to_id || undefined,
          createdAt: c.created_at || '',
          updatedAt: c.updated_at || '',
          url: c.html_url || '',
        });
      }
    } catch {
      // Review comments may not exist yet
    }

    // Fetch issue-level comments
    try {
      const issueJson = execFileSync('gh', [
        'api', `repos/${repo}/issues/${this.pr.number}/comments`,
        '--paginate',
      ], { encoding: 'utf-8' });
      const issueComments = JSON.parse(issueJson);
      for (const c of issueComments) {
        comments.push({
          id: c.id,
          body: c.body || '',
          author: c.user?.login || '',
          createdAt: c.created_at || '',
          updatedAt: c.updated_at || '',
          url: c.html_url || '',
        });
      }
    } catch {
      // Issue comments may not exist
    }

    return comments.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  // ==========================================================================
  // Post Comment
  // ==========================================================================

  /**
   * Post an inline review comment on a specific file and line.
   * Validates that the file is in the PR's changed files list.
   */
  postComment(
    file: string,
    line: number,
    body: string,
    side: 'LEFT' | 'RIGHT' = 'RIGHT',
  ): PRComment {
    const changedFiles = this.getChangedFiles();
    if (!changedFiles.includes(file)) {
      throw new Error(
        `File "${file}" is not in the PR's changed files. ` +
        `Changed files: ${changedFiles.join(', ')}`
      );
    }

    const repo = `${this.pr.owner}/${this.pr.repo}`;

    // Get the HEAD commit SHA for the PR
    const headSha = this.getHeadCommitSha();

    const result = execFileSync('gh', [
      'api', `repos/${repo}/pulls/${this.pr.number}/comments`,
      '-X', 'POST',
      '-f', `body=${body}`,
      '-f', `path=${file}`,
      '-F', `line=${line}`,
      '-f', `side=${side}`,
      '-f', `commit_id=${headSha}`,
    ], { encoding: 'utf-8' });

    const c = JSON.parse(result);
    return {
      id: c.id,
      body: c.body || '',
      author: c.user?.login || '',
      file: c.path || undefined,
      line: c.line || undefined,
      side: c.side || undefined,
      createdAt: c.created_at || '',
      updatedAt: c.updated_at || '',
      url: c.html_url || '',
    };
  }

  // ==========================================================================
  // Reply to Comment
  // ==========================================================================

  /**
   * Reply to an existing review comment.
   * Validates that the comment belongs to this PR.
   */
  replyToComment(commentId: number, body: string): PRComment {
    const repo = `${this.pr.owner}/${this.pr.repo}`;

    // Verify the comment belongs to this PR
    try {
      const commentJson = execFileSync('gh', [
        'api', `repos/${repo}/pulls/comments/${commentId}`,
      ], { encoding: 'utf-8' });
      const comment = JSON.parse(commentJson);
      if (comment.pull_request_url && !comment.pull_request_url.endsWith(`/${this.pr.number}`)) {
        throw new Error(`Comment ${commentId} does not belong to PR #${this.pr.number}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('does not belong')) throw error;
      throw new Error(`Comment ${commentId} not found or not accessible`);
    }

    const result = execFileSync('gh', [
      'api', `repos/${repo}/pulls/${this.pr.number}/comments/${commentId}/replies`,
      '-X', 'POST',
      '-f', `body=${body}`,
    ], { encoding: 'utf-8' });

    const c = JSON.parse(result);
    return {
      id: c.id,
      body: c.body || '',
      author: c.user?.login || '',
      file: c.path || undefined,
      line: c.line || undefined,
      side: c.side || undefined,
      inReplyToId: c.in_reply_to_id || undefined,
      createdAt: c.created_at || '',
      updatedAt: c.updated_at || '',
      url: c.html_url || '',
    };
  }

  // ==========================================================================
  // Comment Threads
  // ==========================================================================

  /**
   * Group comments into threads with resolution status from GraphQL.
   */
  getCommentThreads(): PRCommentThread[] {
    // Fetch thread resolution status via GraphQL
    const threadResolution = this.fetchThreadResolution();

    const comments = this.listComments();
    const rootComments = comments.filter(c => !c.inReplyToId && c.file);
    const replyMap = new Map<number, PRComment[]>();

    for (const c of comments) {
      if (c.inReplyToId) {
        const replies = replyMap.get(c.inReplyToId) || [];
        replies.push(c);
        replyMap.set(c.inReplyToId, replies);
      }
    }

    return rootComments.map(root => {
      // Match REST comment to GraphQL thread by file+line
      const threadInfo = threadResolution.find(
        t => t.path === root.file && t.line === root.line
      );
      return {
        rootComment: root,
        replies: replyMap.get(root.id) || [],
        file: root.file,
        line: root.line,
        isResolved: threadInfo?.isResolved ?? false,
        threadId: threadInfo?.threadId,
      };
    });
  }

  // ==========================================================================
  // Resolve / Unresolve Thread
  // ==========================================================================

  /**
   * Resolve a review thread by its GraphQL node ID.
   * Use getCommentThreads() to find the threadId.
   */
  resolveThread(threadId: string): boolean {
    const mutation = `mutation { resolveReviewThread(input: {threadId: "${threadId}"}) { thread { isResolved } } }`;
    try {
      const result = execFileSync('gh', [
        'api', 'graphql', '-f', `query=${mutation}`,
      ], { encoding: 'utf-8' });
      const parsed = JSON.parse(result);
      return parsed.data?.resolveReviewThread?.thread?.isResolved ?? false;
    } catch (error) {
      throw new Error(
        `Failed to resolve thread: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Unresolve a previously resolved review thread.
   */
  unresolveThread(threadId: string): boolean {
    const mutation = `mutation { unresolveReviewThread(input: {threadId: "${threadId}"}) { thread { isResolved } } }`;
    try {
      const result = execFileSync('gh', [
        'api', 'graphql', '-f', `query=${mutation}`,
      ], { encoding: 'utf-8' });
      const parsed = JSON.parse(result);
      return !(parsed.data?.unresolveReviewThread?.thread?.isResolved ?? true);
    } catch (error) {
      throw new Error(
        `Failed to unresolve thread: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Fetch review thread node IDs and resolution status via GraphQL.
   */
  private fetchThreadResolution(): { threadId: string; path: string; line: number; isResolved: boolean }[] {
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              line
              path
            }
          }
        }
      }
    }`;

    try {
      const result = execFileSync('gh', [
        'api', 'graphql',
        '-f', `query=${query}`,
        '-F', `owner=${this.pr.owner}`,
        '-F', `repo=${this.pr.repo}`,
        '-F', `number=${this.pr.number}`,
      ], { encoding: 'utf-8' });

      const parsed = JSON.parse(result);
      const threads = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
      return threads.map((t: { id: string; isResolved: boolean; line: number; path: string }) => ({
        threadId: t.id,
        path: t.path || '',
        line: t.line || 0,
        isResolved: t.isResolved || false,
      }));
    } catch {
      return [];
    }
  }

  private getChangedFiles(): string[] {
    if (this.changedFilesCache) return this.changedFilesCache;

    const repo = `${this.pr.owner}/${this.pr.repo}`;
    try {
      const filesJson = execFileSync('gh', [
        'pr', 'view', String(this.pr.number),
        '--repo', repo,
        '--json', 'files',
      ], { encoding: 'utf-8' });
      const parsed = JSON.parse(filesJson);
      this.changedFilesCache = (parsed.files || []).map((f: { path: string }) => f.path);
    } catch {
      this.changedFilesCache = [];
    }

    return this.changedFilesCache!;
  }

  private getHeadCommitSha(): string {
    const repo = `${this.pr.owner}/${this.pr.repo}`;
    try {
      const prJson = execFileSync('gh', [
        'pr', 'view', String(this.pr.number),
        '--repo', repo,
        '--json', 'headRefOid',
      ], { encoding: 'utf-8' });
      const parsed = JSON.parse(prJson);
      return parsed.headRefOid || 'HEAD';
    } catch {
      return 'HEAD';
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createPRCommentService(pr: PRIdentifier): PRCommentService {
  return new PRCommentService(pr);
}

export default PRCommentService;
