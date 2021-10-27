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

    const prNumbersOfMerges = new Set();
    const committers = new Set();

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

    core.setOutput('merge_commits_summary', commitSummary);
    core.setOutput('merge_commits_summary_json', JSON.stringify({ PROMOTION_PR_COMMIT_SUMMARY: commitSummary }));
    core.setOutput('committers_csv', committersCsv);
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
