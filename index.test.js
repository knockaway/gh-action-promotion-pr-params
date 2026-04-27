'use strict';

const tap = require('tap');
const sinon = require('sinon');
const { main } = require('./index');

function buildContext(overrides = {}) {
  const inputs = {
    github_token: '',
    pr_source_branch: 'master',
    pr_destination_branch: 'production',
    describe_merges_into_branch: 'master',
    ...(overrides.inputs || {}),
  };
  return {
    core: {
      getInput: sinon.stub().callsFake(x => inputs[x] || ''),
      setOutput: sinon.stub(),
      setFailed: sinon.stub(),
      info: sinon.stub(),
      debug: sinon.stub(),
      warning: sinon.stub(),
      error: sinon.stub(),
    },
    githubRest: {
      pulls: { list: sinon.stub().resolves({ data: [] }) },
      repos: {
        compareCommitsWithBasehead:
          overrides.compareCommitsWithBasehead || sinon.stub().resolves({ data: { commits: [] } }),
      },
    },
    graphql: overrides.graphql || sinon.stub().resolves({ repository: {} }),
    owner: 'knockaway',
    repo: 'gh-action-promotion-pr-params',
  };
}

tap.test('emits empty template vars when no commits are in the diff', async t => {
  const ctx = buildContext();
  await main({ ctx });

  t.notOk(ctx.core.setFailed.called, 'setFailed not called');
  const summaryJsonCall = ctx.core.setOutput.getCalls().find(c => c.args[0] === 'merge_commits_summary_json');
  t.equal(summaryJsonCall.args[1], '{}', 'no commits → {}');
  t.notOk(ctx.graphql.called, 'graphql is not called when there are no commits');
});

tap.test('emits empty template vars when GraphQL throws (preserves existing PR body)', async t => {
  const ctx = buildContext({
    compareCommitsWithBasehead: sinon.stub().resolves({
      data: {
        commits: [
          {
            sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            commit: { author: { date: '2026-04-27T17:00:00Z' } },
            author: { login: 'pkat' },
          },
        ],
      },
    }),
    graphql: sinon.stub().rejects(new Error('500 Internal Server Error')),
  });

  await main({ ctx });

  t.notOk(ctx.core.setFailed.called, 'main does not fail when GraphQL is down');
  t.ok(ctx.core.warning.called, 'logs a warning about the failed lookup');
  const summaryJsonCall = ctx.core.setOutput.getCalls().find(c => c.args[0] === 'merge_commits_summary_json');
  t.equal(summaryJsonCall.args[1], '{}', 'emits {} so the upsert action preserves the existing body');
});

tap.test('builds a summary line for each PR returned by GraphQL', async t => {
  const ctx = buildContext({
    compareCommitsWithBasehead: sinon.stub().resolves({
      data: {
        commits: [
          {
            sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            commit: { author: { date: '2026-04-27T17:00:00Z' } },
            author: { login: 'pkat' },
          },
          {
            sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            commit: { author: { date: '2026-04-27T17:05:00Z' } },
            author: { login: 'pkat' },
          },
        ],
      },
    }),
    graphql: sinon.stub().resolves({
      repository: {
        c0: {
          associatedPullRequests: {
            nodes: [
              {
                number: 227,
                title: 'fix(deps): bump dd-trace from 5.94.0 to 5.97.0',
                url: 'https://example/pull/227',
                mergedAt: '2026-04-23T19:01:00Z',
                closedAt: '2026-04-23T19:01:00Z',
                baseRefName: 'master',
                author: { login: 'dependabot' },
              },
            ],
          },
        },
        c1: {
          associatedPullRequests: {
            nodes: [
              {
                number: 229,
                title: 'fix(deps): bump dd-trace from 5.97.0 to 5.98.0',
                url: 'https://example/pull/229',
                mergedAt: '2026-04-27T17:53:58Z',
                closedAt: '2026-04-27T17:53:58Z',
                baseRefName: 'master',
                author: { login: 'dependabot' },
              },
            ],
          },
        },
      },
    }),
  });

  await main({ ctx });

  t.notOk(ctx.core.setFailed.called, 'setFailed not called');
  const summaryCall = ctx.core.setOutput.getCalls().find(c => c.args[0] === 'merge_commits_summary');
  t.match(summaryCall.args[1], /#227/, 'PR #227 listed');
  t.match(summaryCall.args[1], /#229/, 'PR #229 listed');
  t.notMatch(summaryCall.args[1], /by @dependabot/, 'dependabot author tag is suppressed');
});

tap.test('drops PRs that targeted a different base branch', async t => {
  const ctx = buildContext({
    compareCommitsWithBasehead: sinon.stub().resolves({
      data: {
        commits: [
          {
            sha: 'cccccccccccccccccccccccccccccccccccccccc',
            commit: { author: { date: '2026-04-27T17:00:00Z' } },
            author: { login: 'pkat' },
          },
        ],
      },
    }),
    graphql: sinon.stub().resolves({
      repository: {
        c0: {
          associatedPullRequests: {
            nodes: [
              {
                number: 999,
                title: 'merged into a feature branch, not master',
                url: 'https://example/pull/999',
                mergedAt: '2026-04-27T17:00:00Z',
                closedAt: '2026-04-27T17:00:00Z',
                baseRefName: 'feature/foo',
                author: { login: 'pkat' },
              },
            ],
          },
        },
      },
    }),
  });

  await main({ ctx });

  const summaryJsonCall = ctx.core.setOutput.getCalls().find(c => c.args[0] === 'merge_commits_summary_json');
  t.equal(summaryJsonCall.args[1], '{}', 'PR with non-master base is filtered out');
});
