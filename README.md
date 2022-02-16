# gh-action-promotion-pr-params

This GitHub Action generates some values that can be useful when creating a PR that promotes master
to staging, or staging to production, for example.

## Usage

Create a workflow file (e.g. `.github/workflows/promotion-prs.yml`) like this:

```yaml
name: Automatic PRs for master -> staging and staging -> production
on:
  push:
    branches:
      - staging
      - master
jobs:
  Create-Promotion-PR:
    runs-on: ubuntu-latest
    env:
      BASE_BRANCH: ${{ github.ref == 'refs/heads/master' && 'staging' || github.ref == 'refs/heads/staging' && 'production' || 'master' }}
    steps:
      - name: Determine HEAD_BRANCH
        run: |
          GITHUB_REF="${{ github.ref }}"
          HEAD_BRANCH="${GITHUB_REF/refs\/heads\//}"
          echo "HEAD_BRANCH=$HEAD_BRANCH" >> $GITHUB_ENV

      - name: Check out repository code
        uses: actions/checkout@v2

      - name: Build Promotion PR Params
        id: promotion_pr_params
        uses: knockaway/gh-action-promotion-pr-params@v1.2.0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          pr_source_branch: ${{ env.HEAD_BRANCH }}
          pr_destination_branch: ${{ env.BASE_BRANCH }}

      - name: Create or Update PR
        id: upsert_pr
        uses: knockaway/gh-action-upsert-pr@v1.1.0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          pr_source_branch: ${{ env.HEAD_BRANCH }}
          pr_destination_branch: ${{ env.BASE_BRANCH }}
          create_pr_title: '${{ env.HEAD_BRANCH }} -> ${{ env.BASE_BRANCH }}'
          create_pr_body: '<!-- PROMOTION_PR_COMMIT_SUMMARY_START --><!-- PROMOTION_PR_COMMIT_SUMMARY_END -->'
          create_pr_reviewers: ${{ steps.promotion_pr_params.outputs.committers_csv }}
          update_pr_reviewers: ${{ steps.promotion_pr_params.outputs.committers_csv }}
          update_pr_rerequest_reviewers: ${{ steps.promotion_pr_params.outputs.approvers_with_new_commits_csv }}
          create_pr_body_template_vars: ${{ steps.promotion_pr_params.outputs.merge_commits_summary_json }}
          update_pr_body_template_vars: ${{ steps.promotion_pr_params.outputs.merge_commits_summary_json }}
```

## Parameters

### `github_token` (required)

Token to be used in the GitHub API calls.

### `pr_source_branch` (required)

The branch to use as the "from" / "head" side of the PR.

### `pr_destination_branch` (required)

The branch to use as the "to" / "base" side of the PR.

### `describe_merges_into_branch`

Focus the summary on merges into this branch. Default: 'master'

## Outputs

### `merge_commits_summary`

The summary of merge commits into {describe_merges_into_branch}. Example:

 - [#1](https://github.com/knockaway/gh-action-promotion-pr-params/pull/1) by @user1: Add example section to merge_commits_summary
 - [#2](https://github.com/knockaway/gh-action-promotion-pr-params/pull/2) by @user2: Update example section in merge_commits_summary

### `merge_commits_summary_json`

`merge_commits_summary` in JSON format: 

```json
{ "PROMOTION_PR_COMMIT_SUMMARY": merge_commits_summary } 
```

This is to be used with https://github.com/knockaway/upsert-pr-action#pr-body-templates

### `committers_csv`

A comma separated list of the GitHub users who committed in the diff between 
pr_source_branch and pr_destination_branch.

Intended to be used with [create_pr_reviewers](https://github.com/knockaway/upsert-pr-action#create_pr_reviewers)
/ [update_pr_reviewers](https://github.com/knockaway/upsert-pr-action#update_pr_reviewers).

### `approvers_with_new_commits_csv`

A comma separated list of the GitHub users who approved the promotion of their commits, but
since the time of their review submitted new commits to the promotion PR.

Intended to be used with [update_pr_rerequest_reviewers](
https://github.com/knockaway/gh-action-upsert-pr#update_pr_rerequest_reviewers).
