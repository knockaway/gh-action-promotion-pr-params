'use strict';

const core = require('@actions/core');
const github = require('@actions/github');

module.exports = { main };

/**
 * @typedef {import("@octokit/plugin-rest-endpoint-methods/dist-types/generated/method-types").RestEndpointMethods} GitHubRest
 */
/**
 * @typedef {Object} Context
 *   @property {import("@actions/core")} core
 *   @property {GitHubRest} githubRest
 *   @property {String} owner
 *   @property {String} repo
 */

if (require.main === module) {
  const githubRest = github.getOctokit(core.getInput('github_token', { required: true })).rest;
  main({ ctx: { core, githubRest, owner: github.context.repo.owner, repo: github.context.repo.repo } }).catch();
}

/**
 * @param {Context} ctx
 */
async function main({ ctx }) {
  const { core, githubRest, owner, repo } = ctx;
  try {
    const headRef = core.getInput('pr_source_branch', { required: true });
    const baseRef = core.getInput('pr_destination_branch', { required: true });
    const mergeDescriptionBranch = core.getInput('describe_merges_into_branch') || 'master';

    const {
      data: [existingPr],
    } = await githubRest.pulls.list({ owner, repo, base: baseRef, head: headRef });
    const approvingReviewers = existingPr ? await findReviewersCurrentlyApproving({ ctx, existingPr }) : new Map();

    const committers = new Set();
    const approversWithNewCommits = new Set();
    const allCommits = [];

    let page = 1;
    const per_page = 15;
    while (true) {
      core.info(`Requesting page ${page} of commits for ${headRef}...${baseRef}`);
      const {
        data: { commits },
      } = await githubRest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${baseRef}...${headRef}`,
        page,
        per_page,
      });
      core.info(`Found ${commits.length} commits on page ${page} of commits for ${headRef}...${baseRef}`);

      for (const c of commits) {
        allCommits.push(c);

        const { author, commit } = c;
        if (author && author.login && isLoginPermissible(author.login)) {
          committers.add(author.login);
          if (
            approvingReviewers.has(author.login) &&
            commit.author.date > approvingReviewers.get(author.login).submitted_at
          ) {
            approversWithNewCommits.add(author.login);
          }
        }
      }

      if (commits.length < per_page) {
        break;
      }
      page++;
    }

    const prNumberToPr = await lookupAssociatedPRs({ ctx, commits: allCommits, mergeDescriptionBranch });

    const prLines = [];
    for (const pr of [...prNumberToPr.values()].sort(byClosedAtDesc)) {
      if (pr.user && pr.user.login && isLoginPermissible(pr.user.login)) {
        prLines.push(`[#${pr.number}](${pr.html_url}) by @${pr.user.login}: ${pr.title}`);
      } else {
        prLines.push(`[#${pr.number}](${pr.html_url}): ${pr.title}`);
      }
    }

    const commitSummary = prLines.map(line => ` - ${line}`).join('\n');
    core.info(`Generated commit summary for ${headRef}...${baseRef}:\n${commitSummary}`);

    const committersCsv = [...committers].join(',');
    core.info(`Found these committers in the diff for ${headRef}...${baseRef}:\n${committersCsv}`);

    const approversWithNewCommitsCsv = [...approversWithNewCommits].join(',');
    core.info(`Found these reviewers that approved and then added new commits:\n${approversWithNewCommitsCsv}`);

    core.setOutput('merge_commits_summary', commitSummary);
    // When no PRs were resolved, emit empty template vars so callers using gh-action-upsert-pr leave
    // the existing PR body untouched instead of clobbering a previously-populated summary.
    const summaryJson = prLines.length === 0 ? '{}' : JSON.stringify({ PROMOTION_PR_COMMIT_SUMMARY: commitSummary });
    core.setOutput('merge_commits_summary_json', summaryJson);
    core.setOutput('committers_csv', committersCsv);
    core.setOutput('approvers_with_new_commits_csv', approversWithNewCommitsCsv);
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
    process.exit(1);
  }
}

function isLoginPermissible(login) {
  if (!login) {
    return false;
  }
  if (login === 'github-actions[bot]') {
    return false;
  }
  if (login === 'web-flow') {
    return false;
  }
  return !login.includes('dependabot');
}

function byClosedAtDesc(a, b) {
  if (a.closed_at < b.closed_at) {
    return -1;
  }
  if (a.closed_at > b.closed_at) {
    return 1;
  }
  return 0;
}

/**
 * Resolve which merged PRs introduced the given commits.
 *
 * We extract PR numbers directly from merge commit messages rather than calling
 * `repos.listPullRequestsAssociatedWithCommit` or GraphQL `associatedPullRequests`.
 * Both endpoints depend on a backend index that lags 20+ minutes after a merge and
 * also returns intermittent 500s, so just-merged PRs would be silently dropped from
 * the summary. Commit messages are git data — present immediately and never flaky.
 *
 * Standard merge commits ("Merge pull request #N from ...") and squash-merge commits
 * ("Title (#N)") are both matched. Rebase merges (which don't preserve a PR ref in
 * any commit message) are not detected; this action's primary use case is promotion
 * PRs in repos that use merge or squash strategies.
 *
 * @param {Object} args
 * @param {Context} args.ctx
 * @param {Array} args.commits  raw items from compareCommitsWithBasehead
 * @param {String} args.mergeDescriptionBranch
 */
async function lookupAssociatedPRs({ ctx, commits, mergeDescriptionBranch }) {
  const { core, githubRest, owner, repo } = ctx;
  const prNumbers = new Set();

  for (const c of commits) {
    const subject = c.commit && c.commit.message ? c.commit.message.split('\n')[0] : '';
    const standardMerge = subject.match(/^Merge pull request #(\d+)/);
    const squashMerge = subject.match(/\(#(\d+)\)\s*$/);
    if (standardMerge) {
      prNumbers.add(Number(standardMerge[1]));
    } else if (squashMerge) {
      prNumbers.add(Number(squashMerge[1]));
    }
  }

  const prNumberToPr = new Map();
  for (const num of prNumbers) {
    let pr;
    try {
      const result = await githubRest.pulls.get({ owner, repo, pull_number: num });
      pr = result.data;
    } catch (err) {
      core.warning(`Failed to fetch PR #${num}: ${err.message}`);
      continue;
    }
    if (pr.merged_at && pr.base && pr.base.ref === mergeDescriptionBranch) {
      prNumberToPr.set(pr.number, pr);
    }
  }

  return prNumberToPr;
}

/**
 * @param {Context} ctx
 * @param {object} existingPr
 */
async function findReviewersCurrentlyApproving({ ctx, existingPr }) {
  const { core, githubRest, owner, repo } = ctx;
  const reviewerToLatestReview = new Map();

  let page = 1;
  const per_page = 15;
  while (true) {
    core.info(`Requesting page ${page} of pr reviews for PR #${existingPr.number}`);

    // after a review has been requested and given, that user is no longer listed as in the PR's requested_reviewers,
    // but we don't necessarily want to re-request reviews from them.
    const { data: reviews } = await githubRest.pulls.listReviews({
      owner,
      repo,
      pull_number: existingPr.number,
      page,
      per_page,
    });
    for (const review of reviews) {
      if (review.user && review.user.login) {
        if (
          !reviewerToLatestReview.has(review.user.login) ||
          reviewerToLatestReview.get(review.user.login).submitted_at < review.submitted_at
        ) {
          reviewerToLatestReview.set(review.user.login, review);
        }
      }
    }

    if (reviews.length < per_page) {
      break;
    }
    page++;
  }

  return new Map([...reviewerToLatestReview].filter(([, v]) => v.state === 'APPROVED'));
}
