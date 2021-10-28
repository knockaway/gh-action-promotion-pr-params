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
      error: sinon.stub(),
    },
    githubRest: { repos: { compareCommitsWithBasehead: sinon.stub().resolves({ data: { commits: [] } }) } },
    owner: 'knockaway',
    repo: 'gh-action-promotion-pr-params',
  };
});

tap.test(async t => {
  await main({ ctx: t.context });
});
