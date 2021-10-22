'use strict';

const actionsCore = require('@actions/core');
const actionsGithub = require('@actions/github');

module.exports = main;

if (require.main === module) {
  main().catch();
}

async function main({
  core = actionsCore,
  github = actionsGithub,
  owner = github.context.repo.owner,
  repo = github.context.repo.repo,
} = {}) {
  try {
    const headRef = core.getInput('pr_source_branch');
    if (!headRef) {
      throw new Error('pr_source_branch is required');
    }

    const baseRef = core.getInput('pr_destination_branch');
    if (!baseRef) {
      throw new Error('pr_destination_branch is required');
    }

    const mergeDescriptionBranch = core.getInput('describe_merges_into_branch') || 'master';

    const octokit = github.getOctokit(core.getInput('github_token'));

    /** @type import("@octokit/plugin-rest-endpoint-methods/dist-types/generated/method-types").RestEndpointMethods */
    const githubRest = octokit.rest;

    const prNumbersOfMerges = new Set();
    const committers = new Set();

    let page = 1;
    const per_page = 15;
    while (true) {
      console.log(`Requesting page ${page} of commits for ${headRef}...${baseRef}`);
      const {
        data: { commits },
      } = await githubRest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${baseRef}...${headRef}`,
        page,
        per_page,
      });
      console.log(`Found ${commits.length} commits on page ${page} of commits for ${headRef}...${baseRef}`);

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
        console.log(
          `Skipping PR #${prNumberOfMerge} because it merges into ${base.ref} instead of ${mergeDescriptionBranch}`,
        );
        continue;
      }

      prLines.push(`[#${prNumberOfMerge}](${html_url}): ${title}`);
    }

    const commitSummary = prLines.map(line => ` - ${line}`).join('\n');
    console.log(`Generated commit summary for ${headRef}...${baseRef}:\n${commitSummary}`);

    const committersCsv = [...committers].join(',');
    console.log(`Found these committers in the diff for ${headRef}...${baseRef}:\n${committersCsv}`);

    core.setOutput('merge_commits_summary', commitSummary);
    core.setOutput('merge_commits_summary_json', JSON.stringify({ PROMOTION_PR_COMMIT_SUMMARY: commitSummary }));
    core.setOutput('committers_csv', committersCsv);
  } catch (error) {
    console.error(error);
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
