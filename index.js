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
  const octokit = github.getOctokit(core.getInput('github_token', { required: true }));
  main({
    ctx: {
      core,
      githubRest: octokit.rest,
      graphql: octokit.graphql,
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
    },
  }).catch();
}

/**
 * @param {Context} ctx
 */
async function main({ ctx }) {
  const { core, githubRest, graphql, owner, repo } = ctx;
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
    const commitShas = [];

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

      for (const { sha, commit, author } of commits) {
        commitShas.push(sha);

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

    const prNumberToPr = await lookupAssociatedPRs({ ctx, commitShas, mergeDescriptionBranch });

    const prLines = [];
    for (const pr of [...prNumberToPr.values()].sort(byClosedAtDesc)) {
      if (pr.author && pr.author.login && isLoginPermissible(pr.author.login)) {
        prLines.push(`[#${pr.number}](${pr.url}) by @${pr.author.login}: ${pr.title}`);
      } else {
        prLines.push(`[#${pr.number}](${pr.url}): ${pr.title}`);
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
  if (a.closedAt < b.closedAt) {
    return -1;
  }
  if (a.closedAt > b.closedAt) {
    return 1;
  }
  return 0;
}

/**
 * Resolve which merged PRs introduced the given commits, batching lookups via GraphQL.
 *
 * The REST endpoint `repos.listPullRequestsAssociatedWithCommit` is intermittently 500 on
 * some repositories (returns 200 ~half the time, 500 the other half). GraphQL
 * `associatedPullRequests` returns the same data reliably and lets us batch many commits
 * per request.
 *
 * @param {Context & {graphql: Function}} ctx.ctx
 * @param {String[]} ctx.commitShas
 * @param {String} ctx.mergeDescriptionBranch
 */
async function lookupAssociatedPRs({ ctx, commitShas, mergeDescriptionBranch }) {
  const { core, graphql, owner, repo } = ctx;
  const prNumberToPr = new Map();
  if (commitShas.length === 0) {
    return prNumberToPr;
  }

  const CHUNK_SIZE = 50;
  for (let i = 0; i < commitShas.length; i += CHUNK_SIZE) {
    const chunk = commitShas.slice(i, i + CHUNK_SIZE);
    const aliases = chunk
      .map(
        (sha, j) => `c${j}: object(oid: "${sha}") {
          ... on Commit {
            associatedPullRequests(first: 5) {
              nodes {
                number
                title
                url
                mergedAt
                closedAt
                baseRefName
                author { login }
              }
            }
          }
        }`
      )
      .join('\n');
    const query = `query { repository(owner: "${owner}", name: "${repo}") { ${aliases} } }`;

    let result;
    try {
      result = await graphql(query);
    } catch (err) {
      core.warning(`GraphQL associated-PR lookup failed for batch starting at commit index ${i}: ${err.message}`);
      continue;
    }

    const repoData = (result && result.repository) || {};
    for (const key of Object.keys(repoData)) {
      const obj = repoData[key];
      if (!obj || !obj.associatedPullRequests) {
        continue;
      }
      for (const pr of obj.associatedPullRequests.nodes) {
        if (pr.mergedAt && pr.baseRefName === mergeDescriptionBranch) {
          prNumberToPr.set(pr.number, pr);
        }
      }
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
