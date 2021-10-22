'use strict';

const tap = require('tap');
const sinon = require('sinon');
const main = require('./index');

tap.beforeEach(async t => {
  const inputs = {
    github_token: '',
    pr_source_branch: 'PR-Automation-Description',
    pr_destination_branch: 'master',
    describe_merges_into_branch: 'PR-Automation-Description'
  };
  t.context = {
    core: {
      getInput: sinon.stub().callsFake(x => inputs[x]),
      setOutput: sinon.stub(),
      setFailed: sinon.stub(),
    },
    owner: 'knockaway',
    repo: 'gh-action-promotion-pr-params',
  };
});

tap.test(async t => {
  await main(t.context);
});
