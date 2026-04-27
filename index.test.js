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
      pulls: {
        list: sinon.stub().resolves({ data: [] }),
        get: overrides.pullsGet || sinon.stub().rejects(new Error('unexpected pulls.get call')),
      },
      repos: {
        compareCommitsWithBasehead:
          overrides.compareCommitsWithBasehead || sinon.stub().resolves({ data: { commits: [] } }),
      },
    },
    owner: 'knockaway',
    repo: 'gh-action-promotion-pr-params',
  };
}

function fakeMergeCommit({ sha, prNumber, branch = 'pkat/something', author = 'pkat', date = '2026-04-27T17:00:00Z' }) {
  return {
    sha,
    commit: { author: { date }, message: `Merge pull request #${prNumber} from knockaway/${branch}` },
    author: { login: author },
    parents: [{}, {}],
  };
}

function fakeAuthorCommit({ sha, msg, author = 'dependabot', date = '2026-04-27T17:00:00Z' }) {
  return {
    sha,
    commit: { author: { date }, message: msg },
    author: { login: author },
    parents: [{}],
  };
}

tap.test('emits {} when no commits are in the diff', async t => {
  const ctx = buildContext();
  await main({ ctx });

  t.notOk(ctx.core.setFailed.called, 'setFailed not called');
  const summaryJsonCall = ctx.core.setOutput.getCalls().find(c => c.args[0] === 'merge_commits_summary_json');
  t.equal(summaryJsonCall.args[1], '{}', 'no commits → {}');
  t.notOk(ctx.githubRest.pulls.get.called, 'pulls.get is not called when there are no commits');
});

tap.test('extracts PR numbers from standard merge commit messages and looks them up', async t => {
  const ctx = buildContext({
    compareCommitsWithBasehead: sinon.stub().resolves({
      data: {
        commits: [
          fakeAuthorCommit({ sha: 'a'.repeat(40), msg: 'fix(deps): bump dd-trace from 5.94.0 to 5.97.0' }),
          fakeMergeCommit({ sha: 'b'.repeat(40), prNumber: 227 }),
          fakeAuthorCommit({ sha: 'c'.repeat(40), msg: 'fix(deps): bump dd-trace from 5.97.0 to 5.98.0' }),
          fakeMergeCommit({ sha: 'd'.repeat(40), prNumber: 229, date: '2026-04-27T18:00:00Z' }),
        ],
      },
    }),
    pullsGet: sinon.stub().callsFake(({ pull_number }) => {
      const data = {
        227: {
          number: 227,
          title: 'fix(deps): bump dd-trace from 5.94.0 to 5.97.0',
          html_url: 'https://example/pull/227',
          merged_at: '2026-04-23T19:01:00Z',
          closed_at: '2026-04-23T19:01:00Z',
          base: { ref: 'master' },
          user: { login: 'dependabot[bot]' },
        },
        229: {
          number: 229,
          title: 'fix(deps): bump dd-trace from 5.97.0 to 5.98.0',
          html_url: 'https://example/pull/229',
          merged_at: '2026-04-27T17:53:58Z',
          closed_at: '2026-04-27T17:53:58Z',
          base: { ref: 'master' },
          user: { login: 'dependabot[bot]' },
        },
      };
      return Promise.resolve({ data: data[pull_number] });
    }),
  });

  await main({ ctx });

  t.notOk(ctx.core.setFailed.called, 'setFailed not called');
  t.equal(ctx.githubRest.pulls.get.callCount, 2, 'pulls.get called once per unique PR number');
  const summary = ctx.core.setOutput.getCalls().find(c => c.args[0] === 'merge_commits_summary').args[1];
  t.match(summary, /#227/, 'PR #227 listed');
  t.match(summary, /#229/, 'PR #229 listed');
  t.notMatch(summary, /by @dependabot/, 'dependabot author is suppressed (isLoginPermissible)');
});

tap.test('extracts PR numbers from squash-merge commit messages', async t => {
  const ctx = buildContext({
    compareCommitsWithBasehead: sinon.stub().resolves({
      data: {
        commits: [
          {
            sha: 'e'.repeat(40),
            commit: { author: { date: '2026-04-27T17:00:00Z' }, message: 'feat: add a thing (#42)' },
            author: { login: 'pkat' },
            parents: [{}],
          },
        ],
      },
    }),
    pullsGet: sinon.stub().resolves({
      data: {
        number: 42,
        title: 'feat: add a thing',
        html_url: 'https://example/pull/42',
        merged_at: '2026-04-27T17:00:00Z',
        closed_at: '2026-04-27T17:00:00Z',
        base: { ref: 'master' },
        user: { login: 'pkat' },
      },
    }),
  });

  await main({ ctx });

  t.equal(ctx.githubRest.pulls.get.firstCall.args[0].pull_number, 42, 'extracts (#42) from squash subject');
  const summary = ctx.core.setOutput.getCalls().find(c => c.args[0] === 'merge_commits_summary').args[1];
  t.match(summary, /by @pkat/, 'non-bot author is shown');
});

tap.test('drops PRs whose base branch does not match describe_merges_into_branch', async t => {
  const ctx = buildContext({
    compareCommitsWithBasehead: sinon.stub().resolves({
      data: {
        commits: [fakeMergeCommit({ sha: 'f'.repeat(40), prNumber: 999 })],
      },
    }),
    pullsGet: sinon.stub().resolves({
      data: {
        number: 999,
        merged_at: '2026-04-27T17:00:00Z',
        closed_at: '2026-04-27T17:00:00Z',
        base: { ref: 'feature/foo' },
        user: { login: 'pkat' },
      },
    }),
  });

  await main({ ctx });

  const summaryJsonCall = ctx.core.setOutput.getCalls().find(c => c.args[0] === 'merge_commits_summary_json');
  t.equal(summaryJsonCall.args[1], '{}', 'PR with non-master base is filtered out');
});

tap.test('logs a warning and emits {} when pulls.get fails for the only PR', async t => {
  const ctx = buildContext({
    compareCommitsWithBasehead: sinon.stub().resolves({
      data: {
        commits: [fakeMergeCommit({ sha: '0'.repeat(40), prNumber: 7 })],
      },
    }),
    pullsGet: sinon.stub().rejects(new Error('500 Internal Server Error')),
  });

  await main({ ctx });

  t.notOk(ctx.core.setFailed.called, 'main does not fail');
  t.ok(ctx.core.warning.called, 'warning logged');
  const summaryJsonCall = ctx.core.setOutput.getCalls().find(c => c.args[0] === 'merge_commits_summary_json');
  t.equal(summaryJsonCall.args[1], '{}', 'preserves existing body when lookup fails');
});

tap.test('skips commits without a parseable PR ref instead of failing', async t => {
  const ctx = buildContext({
    compareCommitsWithBasehead: sinon.stub().resolves({
      data: {
        commits: [
          fakeAuthorCommit({ sha: '1'.repeat(40), msg: 'direct push to master' }),
          fakeMergeCommit({ sha: '2'.repeat(40), prNumber: 100 }),
        ],
      },
    }),
    pullsGet: sinon.stub().resolves({
      data: {
        number: 100,
        title: 'real PR',
        html_url: 'https://example/pull/100',
        merged_at: '2026-04-27T17:00:00Z',
        closed_at: '2026-04-27T17:00:00Z',
        base: { ref: 'master' },
        user: { login: 'pkat' },
      },
    }),
  });

  await main({ ctx });

  t.equal(ctx.githubRest.pulls.get.callCount, 1, 'only the parseable PR triggers a lookup');
  const summary = ctx.core.setOutput.getCalls().find(c => c.args[0] === 'merge_commits_summary').args[1];
  t.match(summary, /#100/);
});
