import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type {
  ChangedFile,
  FetchReviewContentRequest,
  FetchReviewContentResult,
  ReviewContent,
  ReviewDocument,
} from './review-types.js';

export interface ReviewContentFetcher {
  fetchReviewContent(request: FetchReviewContentRequest): FetchReviewContentResult;
}

const fetchers: Record<FetchReviewContentRequest['source'], ReviewContentFetcher> = {
  pr: { fetchReviewContent: fetchPullRequestContent },
  'pr-markdown': { fetchReviewContent: fetchPullRequestMarkdownContent },
  'local-file': { fetchReviewContent: fetchLocalFileContent },
  slack: { fetchReviewContent: fetchSlackContent },
};

export function fetchReviewContent(
  request: FetchReviewContentRequest,
): FetchReviewContentResult {
  const fetcher = fetchers[request.source];
  if (!fetcher) {
    throw new Error(`Unsupported review source: ${request.source}`);
  }
  return fetcher.fetchReviewContent(request);
}

function fetchPullRequestContent(
  request: FetchReviewContentRequest,
): FetchReviewContentResult {
  const pr = requirePR(request);
  const repoPath = requireRepoPath(request);
  const raw = fetchPullRequestData(pr, repoPath);

  const content: ReviewContent = {
    source: 'pr',
    title: raw.title || '',
    body: raw.body || '',
    author: raw.author?.login || raw.author || '',
    summary: buildSummary(raw.title || '', raw.body || ''),
    baseBranch: raw.baseRefName || 'main',
    headBranch: raw.headRefName || '',
    diff: raw.diff,
    changedFiles: mapChangedFiles(raw.files || []),
    additions: raw.additions || 0,
    deletions: raw.deletions || 0,
    documents: [],
  };

  return {
    target: {
      kind: 'pull-request',
      label: `${pr.owner}/${pr.repo}#${pr.number}`,
      slug: `${slugify(pr.owner)}-${slugify(pr.repo)}-${pr.number}`,
      description: pr.url,
    },
    content,
    pr,
  };
}

function fetchPullRequestMarkdownContent(
  request: FetchReviewContentRequest,
): FetchReviewContentResult {
  const pr = requirePR(request);
  const repoPath = requireRepoPath(request);
  const worktreePath = request.worktreePath;
  if (!worktreePath) {
    throw new Error('Markdown PR review requires a checked-out worktree.');
  }

  const raw = fetchPullRequestData(pr, repoPath);
  const markdownFiles = (raw.files || []).filter((file: { path?: string }) =>
    isMarkdownFile(file.path || '')
  );

  if (markdownFiles.length === 0) {
    throw new Error('No markdown files found in the target PR.');
  }

  const documents = markdownFiles.map((file: { path: string }) => {
    const fullPath = path.join(worktreePath, file.path);
    return {
      label: file.path,
      path: file.path,
      content: readLocalFile(fullPath),
    };
  });

  const content: ReviewContent = {
    source: 'pr-markdown',
    title: firstDocumentTitle(documents) || raw.title || `Design doc review for ${pr.owner}/${pr.repo}#${pr.number}`,
    body: documents
      .map((document) => `## ${document.label}\n\n${document.content.trim()}`)
      .join('\n\n'),
    author: raw.author?.login || raw.author || '',
    summary: buildSummary(raw.title || '', raw.body || ''),
    baseBranch: raw.baseRefName || 'main',
    headBranch: raw.headRefName || '',
    diff: filterDiffToPaths(raw.diff, markdownFiles.map((file: { path: string }) => file.path)),
    changedFiles: mapChangedFiles(markdownFiles),
    additions: markdownFiles.reduce((sum: number, file: { additions?: number }) => sum + (file.additions || 0), 0),
    deletions: markdownFiles.reduce((sum: number, file: { deletions?: number }) => sum + (file.deletions || 0), 0),
    documents,
  };

  return {
    target: {
      kind: 'design-doc',
      label: `Design doc PR ${pr.owner}/${pr.repo}#${pr.number}`,
      slug: `${slugify(pr.owner)}-${slugify(pr.repo)}-${pr.number}-design-doc`,
      description: `Markdown documents from ${pr.url}`,
    },
    content,
    pr,
  };
}

function fetchLocalFileContent(
  request: FetchReviewContentRequest,
): FetchReviewContentResult {
  const input = request.input?.trim();
  if (!input) {
    throw new Error('Local file review requires --input <path>.');
  }

  const resolvedPath = path.resolve(input);
  const document = {
    label: path.basename(resolvedPath),
    path: resolvedPath,
    content: readLocalFile(resolvedPath),
  };

  const title = firstDocumentTitle([document]) || path.basename(resolvedPath);
  const content: ReviewContent = {
    source: 'local-file',
    title,
    body: document.content,
    author: 'local-file',
    summary: buildSummary(title, document.content),
    changedFiles: [
      {
        path: resolvedPath,
        additions: 0,
        deletions: 0,
        status: 'modified',
      },
    ],
    additions: 0,
    deletions: 0,
    documents: [document],
  };

  return {
    target: {
      kind: 'design-doc',
      label: `Local design doc ${path.basename(resolvedPath)}`,
      slug: slugify(path.basename(resolvedPath, path.extname(resolvedPath))),
      description: resolvedPath,
    },
    content,
  };
}

function fetchSlackContent(
  request: FetchReviewContentRequest,
): FetchReviewContentResult {
  const input = request.input?.trim();
  if (!input) {
    throw new Error('Slack review requires --input <path-to-thread>.');
  }

  const resolvedPath = path.resolve(input);
  const raw = readLocalFile(resolvedPath);
  const parsed = parseSlackMessages(raw);
  const transcript = parsed.messages.length > 0
    ? parsed.messages
        .map((message) => `[${message.author}] ${message.text}`.trim())
        .join('\n\n')
    : raw;

  const document: ReviewDocument = {
    label: parsed.title || path.basename(resolvedPath),
    path: resolvedPath,
    content: transcript,
  };

  const title = parsed.title || path.basename(resolvedPath);
  const content: ReviewContent = {
    source: 'slack',
    title,
    body: transcript,
    author: parsed.author || 'slack',
    summary: buildSummary(title, transcript),
    changedFiles: [],
    additions: 0,
    deletions: 0,
    documents: [document],
  };

  return {
    target: {
      kind: 'design-doc',
      label: `Slack thread ${title}`,
      slug: slugify(title),
      description: resolvedPath,
    },
    content,
  };
}

function fetchPullRequestData(
  pr: NonNullable<FetchReviewContentRequest['pr']>,
  repoPath: string,
): {
  title?: string;
  body?: string;
  author?: { login?: string } | string;
  baseRefName?: string;
  headRefName?: string;
  additions?: number;
  deletions?: number;
  files?: Array<{ path: string; additions?: number; deletions?: number; status?: string }>;
  diff: string;
} {
  const prJson = execFileSync(
    'gh',
    [
      'pr',
      'view',
      String(pr.number),
      '--repo',
      `${pr.owner}/${pr.repo}`,
      '--json',
      'title,body,author,baseRefName,headRefName,additions,deletions,files',
    ],
    { encoding: 'utf-8', cwd: repoPath },
  );

  const raw = JSON.parse(prJson);
  let diff = '';
  try {
    diff = execFileSync(
      'gh',
      ['pr', 'diff', String(pr.number), '--repo', `${pr.owner}/${pr.repo}`],
      { encoding: 'utf-8', cwd: repoPath },
    );
  } catch {
    diff = '';
  }

  return { ...raw, diff };
}

function mapChangedFiles(
  files: Array<{ path: string; additions?: number; deletions?: number; status?: string }>,
): ChangedFile[] {
  return files.map((file) => ({
    path: file.path,
    additions: file.additions || 0,
    deletions: file.deletions || 0,
    status: mapFileStatus(file.status),
  }));
}

function mapFileStatus(status?: string): ChangedFile['status'] {
  switch ((status || '').toLowerCase()) {
    case 'added':
    case 'a':
      return 'added';
    case 'deleted':
    case 'd':
    case 'removed':
      return 'deleted';
    case 'renamed':
    case 'r':
      return 'renamed';
    default:
      return 'modified';
  }
}

function requirePR(
  request: FetchReviewContentRequest,
): NonNullable<FetchReviewContentRequest['pr']> {
  if (!request.pr) {
    throw new Error(`Review source "${request.source}" requires a PR identifier.`);
  }
  return request.pr;
}

function requireRepoPath(request: FetchReviewContentRequest): string {
  if (!request.repoPath) {
    throw new Error(`Review source "${request.source}" requires a local repository path.`);
  }
  return request.repoPath;
}

function readLocalFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Review input not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

function isMarkdownFile(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

function filterDiffToPaths(diff: string, wantedPaths: string[]): string {
  if (!diff.trim() || wantedPaths.length === 0) return '';
  const wanted = new Set(wantedPaths);
  const parts: string[] = [];
  const chunks = diff.split(/^diff --git /m);

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const header = `diff --git ${chunk}`;
    const firstLine = header.split('\n', 1)[0];
    const match = firstLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match && wanted.has(match[2])) {
      parts.push(header.trimEnd());
    }
  }

  return parts.join('\n\n');
}

function firstDocumentTitle(documents: ReviewDocument[]): string | undefined {
  for (const document of documents) {
    const match = document.content.match(/^#\s+(.+)$/m);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

function buildSummary(title: string, body: string): string {
  const text = [title, body]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 280);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'review';
}

function parseSlackMessages(
  raw: string,
): {
  title?: string;
  author?: string;
  messages: Array<{ author: string; text: string }>;
} {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const messages = parsed
        .map((item) => normalizeSlackMessage(item))
        .filter((item): item is { author: string; text: string } => item !== null);
      return {
        title: firstNonEmpty(messages.map((message) => message.text.split('\n')[0] || '')),
        author: messages[0]?.author,
        messages,
      };
    }

    if (parsed && typeof parsed === 'object') {
      const messages = Array.isArray(parsed.messages)
        ? parsed.messages
            .map((item: unknown) => normalizeSlackMessage(item))
            .filter((item: unknown): item is { author: string; text: string } => item !== null)
        : [];

      return {
        title:
          (typeof parsed.title === 'string' ? parsed.title : undefined) ||
          firstNonEmpty(messages.map((message) => message.text.split('\n')[0] || '')),
        author:
          (typeof parsed.author === 'string' ? parsed.author : undefined) ||
          messages[0]?.author,
        messages,
      };
    }
  } catch {
    // Treat as plain text below.
  }

  return {
    title: raw.split('\n', 1)[0]?.trim() || undefined,
    messages: [{ author: 'slack', text: raw.trim() }],
  };
}

function normalizeSlackMessage(
  value: unknown,
): { author: string; text: string } | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const text = firstNonEmpty([
    typeof item.text === 'string' ? item.text : '',
    typeof item.message === 'string' ? item.message : '',
  ]);

  if (!text) return null;

  return {
    author: firstNonEmpty([
      typeof item.user === 'string' ? item.user : '',
      typeof item.username === 'string' ? item.username : '',
      typeof item.author === 'string' ? item.author : '',
      'slack-user',
    ]) || 'slack-user',
    text,
  };
}

function firstNonEmpty(values: string[]): string | undefined {
  return values.map((value) => value.trim()).find(Boolean);
}
