'use strict';

const tap = require('tap');
const sinon = require('sinon');
const { main } = require('./index');

tap.beforeEach(async t => {
  const inputs = {
    github_token: '',
    pr_source_branch: 'PR-Automation-Description',
    pr_destination_branch: 'master',
    describe_merges_into_branch: 'PR-Automation-Description',
  };
  t.context = {
    core: {
      getInput: sinon.stub().callsFake(x => inputs[x]),
      setOutput: sinon.stub(),
      setFailed: sinon.stub(),
      info: sinon.stub(),
      debug: sinon.stub(),
      error: sinon.stub(),
    },
    githubRest: {
      pulls: { list: sinon.stub().resolves({ data: [] }) },
      repos: {
        compareCommitsWithBasehead: sinon.stub().resolves({ data: { commits: [] } }),
        listPullRequestsAssociatedWithCommit: sinon.stub().resolves({ data: [] }),
      },
    },
    owner: 'knockaway',
    repo: 'gh-action-promotion-pr-params',
  };
});

tap.test('main runs end-to-end with no commits in the diff', async t => {
  await main({ ctx: t.context });
  t.notOk(t.context.core.setFailed.called, 'setFailed not called');
  const summaryJsonCall = t.context.core.setOutput
    .getCalls()
    .find(c => c.args[0] === 'merge_commits_summary_json');
  t.equal(summaryJsonCall.args[1], '{}', 'emits empty template vars when nothing was found');
});
