/**
 * Review Issue Service — GitHub issue creation and project filing.
 */

import { execFileSync } from 'child_process';
import type { PRIdentifier } from './review-types.js';

export interface CreatedReviewIssue {
  number: number;
  title: string;
  url: string;
  assignees: string[];
  labels: string[];
  projectNumber?: number;
  projectOwner?: string;
}

export interface CreateReviewIssueOptions {
  assignee?: string;
  labels?: string[];
  projectNumber?: number;
  projectOwner?: string;
}

export class ReviewIssueService {
  constructor(private readonly pr: PRIdentifier) {}

  createIssue(title: string, body: string, options: CreateReviewIssueOptions = {}): CreatedReviewIssue {
    const repo = `${this.pr.owner}/${this.pr.repo}`;
    const assignee = options.assignee || 'OwenQianDD';
    const labels = options.labels || [];

    let result: string;
    try {
      const args = [
        'api', `repos/${repo}/issues`,
        '-X', 'POST',
        '-f', `title=${title}`,
        '-f', `body=${body}`,
        '-f', `assignees[]=${assignee}`,
      ];
      for (const label of labels) {
        args.push('-f', `labels[]=${label}`);
      }
      result = execFileSync('gh', args, { encoding: 'utf-8' });
    } catch (error) {
      throw new Error(
        `Failed to create issue in ${repo}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const issue = JSON.parse(result);
    const created: CreatedReviewIssue = {
      number: issue.number,
      title: issue.title || title,
      url: issue.html_url,
      assignees: (issue.assignees || []).map((a: { login: string }) => a.login),
      labels: (issue.labels || []).map((l: { name: string }) => l.name),
    };

    if (options.projectNumber && options.projectOwner) {
      this.addIssueToProject(created.url, options.projectNumber, options.projectOwner);
      created.projectNumber = options.projectNumber;
      created.projectOwner = options.projectOwner;
    }

    return created;
  }

  private addIssueToProject(issueUrl: string, projectNumber: number, projectOwner: string): void {
    try {
      execFileSync('gh', [
        'project', 'item-add', String(projectNumber),
        '--owner', projectOwner,
        '--url', issueUrl,
      ], { encoding: 'utf-8' });
    } catch (error) {
      throw new Error(
        `Issue created but failed to add to project ${projectOwner}/${projectNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

export function createReviewIssueService(pr: PRIdentifier): ReviewIssueService {
  return new ReviewIssueService(pr);
}

export default ReviewIssueService;
