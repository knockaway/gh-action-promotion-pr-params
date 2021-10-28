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

    const prNumbersOfMerges = new Set();
    const committers = new Set();
    const approversWithNewCommits = new Set();

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

      for (const { commit, author } of commits) {
        const message = commit && commit.message;
        if (message) {
          if (message.startsWith('Merge pull request #')) {
            // in standard merge commits, the PR# comes after 'Merge pull request'
            prNumbersOfMerges.add(message.match(/^Merge pull request #(\d*) /)[1]);
          } else if (message.match(/^.*\(#(\d*)\)$/m)) {
            // in squash merge commits, the PR# is at the end of the first line
            prNumbersOfMerges.add(message.match(/^.*\(#(\d*)\)$/m)[1]);
          }
        }

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

    const prLines = [];
    for (const prNumberOfMerge of prNumbersOfMerges) {
      const {
        data: { title, html_url, base },
      } = await githubRest.pulls.get({ owner, repo, pull_number: Number(prNumberOfMerge), per_page: 1 });

      if (base.ref !== mergeDescriptionBranch) {
        core.info(
          `Skipping PR #${prNumberOfMerge} because it merges into ${base.ref} instead of ${mergeDescriptionBranch}`,
        );
        continue;
      }

      prLines.push(`[#${prNumberOfMerge}](${html_url}): ${title}`);
    }

    const commitSummary = prLines.map(line => ` - ${line}`).join('\n');
    core.info(`Generated commit summary for ${headRef}...${baseRef}:\n${commitSummary}`);

    const committersCsv = [...committers].join(',');
    core.info(`Found these committers in the diff for ${headRef}...${baseRef}:\n${committersCsv}`);

    const approversWithNewCommitsCsv = [...approversWithNewCommits].join(',');
    core.info(`Found these reviewers that approved and then added new commits:\n${approversWithNewCommitsCsv}`);

    core.setOutput('merge_commits_summary', commitSummary);
    core.setOutput('merge_commits_summary_json', JSON.stringify({ PROMOTION_PR_COMMIT_SUMMARY: commitSummary }));
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
