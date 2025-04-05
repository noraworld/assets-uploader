# Assets Uploader
⚠️ Most of the codes was copied from [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder). I need to consider refactoring or unifying shared logic.

Assets Uploader uploads the attached files like images posted on an issue to a specific repository.

Let's say you put the following YAML file on [`noraworld/images-uploader`](https://github.com/noraworld/images-uploader/blob/main/.github/workflows/assets-uploader.yml). Every time you leave a comment with attached files on [issue #1 of `noraworld/images-uploader`](https://github.com/noraworld/images-uploader/issues/1), it uploads them to a specific repository. You can now use the attached files with cache enabled if the repository uses GitHub Pages.

## Workflow example
```yaml
name: Assets Uploader

on:
  issue_comment:
    types: [created]
  workflow_dispatch:

jobs:
  build:
    if: ${{ github.event.issue.number == 1 }}
    runs-on: ubuntu-latest
    concurrency:
      group: assets-uploader
      cancel-in-progress: true
    steps:
      - name: Upload assets
        uses: noraworld/assets-uploader@main
        with:
          assets_directory: 2025/04/05
          assets_repo: octocat/assets-repo
          committer_email: actions@github.com
          committer_name: GitHub Actions
          compression_threshold: 1048576
          delete_after: false
          personal_access_token: GH_TOKEN
          resize_height: 1080
          resize_width: 1920
          with_assets_compression: true
          with_compatible_format: false
        env:
          GH_TOKEN: ${{ secrets.GH_TOKEN }}
```

### Options
| Key                       | Description                                                                                                      | Example | Type    | Required |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------- | ------- | -------- |
| `assets_directory`        | See [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder?tab=readme-ov-file#options)           |         |         |          |
| `assets_repo`             | See [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder?tab=readme-ov-file#options)           |         |         |          |
| `committer_email`         | See [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder?tab=readme-ov-file#options)           |         |         |          |
| `committer_name`          | See [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder?tab=readme-ov-file#options)           |         |         |          |
| `compression_threshold`   | See [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder?tab=readme-ov-file#options)           |         |         |          |
| `delete_after`            | If true, the comments where the attached files have been uploaded will be removed                                | `true`  | Boolean | `false`  |
| `issue_number`            | See [noraworld/comments-transferor](https://github.com/noraworld/comments-transferor?tab=readme-ov-file#options) |         |         |          |
| `issue_repo`              | See [noraworld/comments-transferor](https://github.com/noraworld/comments-transferor?tab=readme-ov-file#options) |         |         |          |
| `personal_access_token`   | See [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder?tab=readme-ov-file#options)           |         |         |          |
| `resize_height`           | See [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder?tab=readme-ov-file#options)           |         |         |          |
| `resize_width`            | See [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder?tab=readme-ov-file#options)           |         |         |          |
| `with_assets_compression` | See [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder?tab=readme-ov-file#options)           |         |         |          |
| `with_compatible_format`  | See [noraworld/issue-recorder](https://github.com/noraworld/issue-recorder?tab=readme-ov-file#options)           |         |         |          |

## Development
```shell
cp -i .env.sample .env
node --env-file=.env app.js
```
