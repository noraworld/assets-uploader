'use strict'

import { Base64 } from 'js-base64'
import { Buffer } from 'buffer'
import crypto from 'crypto'
import { execSync } from 'child_process'
import fs from 'fs'
import { Octokit } from '@octokit/rest'
import path from 'path'
import sharp from 'sharp'

const tmpFile = 'tmp.md'
const cache = new Map()

async function run() {
  const content = await getContentFromComments()
  const files = await getAttachedFiles(content)
  const body = buildBody(files)
  post(body)
  deleteComment()
}

async function getContentFromComments() {
  const octokit = process.env.PERSONAL_ACCESS_TOKEN ?
                  new Octokit({ auth: process.env[process.env.PERSONAL_ACCESS_TOKEN] }) :
                  new Octokit({ auth: process.env.GITHUB_TOKEN })
  const repository = process.env.ISSUE_REPO
  const [ owner, repo ] = repository.split('/')
  const issueNumber = process.env.ISSUE_NUMBER

  let comments = []
  let page = 1
  const perPage = 100
  let response = null

  do {
    response = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      page,
      per_page: perPage
    })

    comments = comments.concat(response.data)
    page++
  } while (response.data.length === perPage);

  const content = comments.map(comment => comment.body).join('\n')

  return content
}

// https://chatgpt.com/share/67a6fe0a-c510-8004-9ed8-7b106493bb4a
// https://chatgpt.com/share/67dc00c4-4b0c-8004-9e30-4cd77023249a
async function getAttachedFiles(content) {
  // a simple way to detect links like ![foo](https://example.com) and ignore `![foo](https://example.com)` at the same time
  // but not perfect because it doesn't ignore the case like `hello ![foo](https://example.com) world`
  const regex = /(?<!`)(?:!\[.*?\]\((https?:\/\/[^\s)]+)\)|<img.*?src="(https?:\/\/[^\s"]+)"(?!.*exclude).*>)(?!`)/g
  let matches
  const replacements = []
  const files = []

  while ((matches = regex.exec(content)) !== null) {
    const original = matches[0]
    const url = matches[1] || matches[2]

    // to avoid downloading the same URL
    if (!cache.has(url)) {
      cache.set(url, downloadAndUploadAttachedFile(url))
    }

    replacements.push({ original, url, newUrl: cache.get(url) })
  }

  const resolvedReplacements = await Promise.all(
    [...cache.entries()].map(async ([url, promise]) => [url, await promise])
  )

  for (const [url, newUrl] of resolvedReplacements) {
    cache.set(url, newUrl)
  }

  for (const { original, url } of replacements) {
    files.push({
      original: url,
      uploaded: cache.get(url)
    })
  }

  return files
}

function buildBody(files) {
  let content = ''

  for (const [index, file] of files.entries()) {
    content = content.concat(
`| 🏷️ | 🔗 File ${index + 1} |
| :---: | :---: |
| 📷 | ![](${file.uploaded}) |
| 🕸️ | \`${file.original}\` |
| ✨ | \`${file.uploaded}\` |

\`\`\`
![](${file.uploaded})
\`\`\`

`)
  }

  return content.trim()
}

function post(body) {
  fs.writeFileSync(tmpFile, body)

  if (process.env.DRY_RUN !== 'true') {
    execSync(`gh issue edit --repo "${process.env.ISSUE_REPO}" "${process.env.ISSUE_NUMBER}" --body-file "${tmpFile}"`)
  }
  else {
    console.info(fs.readFileSync(tmpFile, 'utf8'))
  }

  fs.unlinkSync(tmpFile)
}

async function deleteComment() {
  if (process.env.DELETE_AFTER !== 'true') return

  const octokit = process.env.PERSONAL_ACCESS_TOKEN ?
                  new Octokit({ auth: process.env[process.env.PERSONAL_ACCESS_TOKEN] }) :
                  new Octokit({ auth: process.env.GITHUB_TOKEN })
  const repository = process.env.ISSUE_REPO
  const [ owner, repo ] = repository.split('/')
  const issueNumber = process.env.ISSUE_NUMBER

  const comments = await octokit.paginate(
    octokit.issues.listComments,
    {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100
    }
  )

  for (const comment of comments) {
    if (process.env.DRY_RUN !== 'true') {
      await octokit.issues.deleteComment({
        owner,
        repo,
        comment_id: comment.id
      })
    }
    else {
      console.info(`comment https://github.com/${repository}/issues/${issueNumber}#issuecomment-${comment.id} was supposed to be deleted unless DRY_RUN was set`)
    }
  }
}

// https://chatgpt.com/share/67a6fe0a-c510-8004-9ed8-7b106493bb4a
async function downloadAndUploadAttachedFile(url) {
  if (!process.env.ASSETS_REPO) {
    console.error('The assets repository was not set.')
    process.exit(1)
  }

  if (!process.env.ASSETS_DIRECTORY) {
    console.error('The assets directory was not set.')
    process.exit(1)
  }

  const [ owner, repo ] = process.env.ASSETS_REPO.split('/')

  // do nothing if it's already the asset URL to avoid downloading and uploading exact the same file as a different filename
  // the situation is when the content in an issue is saved to another one and the content in another issue is saved to a file
  if (url.startsWith(`https://${owner}.github.io/${repo}`)) {
    if (process.env.DRY_RUN === 'true') {
      console.info(`downloading and uploading file ${url} skipped because it might have been uploaded already`)
    }

    return url
  }

  let headers = null
  const token = process.env.PERSONAL_ACCESS_TOKEN ?
                process.env[process.env.PERSONAL_ACCESS_TOKEN] :
                process.env.GITHUB_TOKEN

  // to avoid exposing the GitHub token to somewhere else
  if (url.startsWith('https://github.com')) {
    headers = {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Node.js'
    }
  }
  else {
    headers = {
      'User-Agent': 'Node.js'
    }
  }

  // to measure how long it takes
  if (process.env.DRY_RUN === 'true') console.info(`downloading file ${url}`)
  const response = await fetch(url, { headers: headers })

  if (!response.ok) {
    throw new Error(`Failed to fetch attached file ${url}: ${response.statusText}`)
  }

  if (process.env.DRY_RUN === 'true') console.info(`file ${url} downloaded`)

  const buffer = await response.arrayBuffer()
  let fileType = await detectFileType(buffer)
  let extension = fileType ? fileType.ext : 'bin'
  let filename = `${generateFileHash(url)}.${extension}`
  let filepath = `${process.env.ASSETS_DIRECTORY}/${filename}`
  let assetsURL = `https://${owner}.github.io/${repo}/${filepath}`
  const file = await getFileFromRepo(process.env.ASSETS_REPO, filepath)

  if (file) {
    return assetsURL
  }

  const compatibleFormatBuffer = await convertIntoCompatibleFormat(Buffer.from(buffer))
  const compressedBuffer = await compressFile(compatibleFormatBuffer, extension)

  // consider refactoring!
  fileType = await detectFileType(compressedBuffer)
  extension = fileType ? fileType.ext : 'bin'
  filename = `${generateFileHash(url)}.${extension}`
  filepath = `${process.env.ASSETS_DIRECTORY}/${filename}`
  assetsURL = `https://${owner}.github.io/${repo}/${filepath}`

  if (process.env.DRY_RUN !== 'true') {
    // sha is unnecessary (null is set) because the attached files are always published as a new file
    await push(process.env.ASSETS_REPO, compressedBuffer, `Add ${filepath}`, filepath, null)

    return assetsURL
  }
  else {
    const dir = path.dirname(filepath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    console.info(`writing file ${filepath}`)
    fs.writeFileSync(filepath, compressedBuffer)
    console.info(`file ${filepath} written`)

    return `./${filepath}`
  }
}

async function convertIntoCompatibleFormat(buffer) {
  if (process.env.WITH_COMPATIBLE_FORMAT !== 'true') return buffer

  const metadata = await sharp(buffer).metadata()
  const originalFormat = metadata.format
  let compatibleFormat = originalFormat

  switch (originalFormat) {
    case 'webp':
      compatibleFormat = 'jpeg'
      break
    default:
      break
  }

  if (originalFormat === compatibleFormat) return buffer

  return await sharp(buffer).toFormat(compatibleFormat).toBuffer()
}

// https://chatgpt.com/share/67a6fe0a-c510-8004-9ed8-7b106493bb4a
async function compressFile(buffer, extension) {
  if (process.env.WITH_ASSETS_COMPRESSION !== "true") {
    return buffer
  }

  let compressedBuffer

  switch (extension) {
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'webp':
      compressedBuffer = await compressImage(buffer)
      break
    default:
      // TODO: support other file types in the future
      break
  }

  return compressedBuffer
}

// https://chatgpt.com/share/67a6fe0a-c510-8004-9ed8-7b106493bb4a
async function compressImage(buffer) {
  if (!process.env.COMPRESSION_THRESHOLD) {
    console.error('COMPRESSION_THRESHOLD is required if you want to compress the image files.')
    process.exit(1)
  }

  if (process.env.RESIZE_WIDTH && process.env.RESIZE_HEIGHT) {
    buffer = await sharp(buffer).resize({
      width: Number(process.env.RESIZE_WIDTH),
      height: Number(process.env.RESIZE_HEIGHT),
      fit: 'inside',
      withoutEnlargement: true
    }).toBuffer()
  }
  else if (process.env.RESIZE_WIDTH) {
    buffer = await sharp(buffer).resize({
      width: Number(process.env.RESIZE_WIDTH),
      fit: 'inside',
      withoutEnlargement: true
    }).toBuffer()
  }
  else if (process.env.RESIZE_HEIGHT) {
    buffer = await sharp(buffer).resize({
      height: Number(process.env.RESIZE_HEIGHT),
      fit: 'inside',
      withoutEnlargement: true
    }).toBuffer()
  }

  const metadata = await sharp(buffer).metadata()
  const format = metadata.format
  const step = 5

  let compressedBuffer = buffer
  let quality = 95
  let compressionLevel = 0

  if (process.env.DRY_RUN === 'true') {
    console.info(`${format} image information before compressing (size: ${compressedBuffer.length} bytes, quality: ${quality}, compressionLevel: ${compressionLevel}`)
  }

  switch (format) {
    case 'jpeg':
    case 'webp':
      while (compressedBuffer.length > process.env.COMPRESSION_THRESHOLD && quality >= 10) {
        let options = {}
        options.quality = quality
        compressedBuffer = await sharp(buffer).toFormat(format, options).toBuffer()

        if (process.env.DRY_RUN === 'true') {
          console.info(`compressing ${format} image... (size: ${compressedBuffer.length} bytes, quality: ${quality}, compressionLevel: ${compressionLevel}`)
        }

        quality -= step
      }
      break
    case 'png':
      while (compressedBuffer.length > process.env.COMPRESSION_THRESHOLD && compressionLevel <= 9) {
        let options = {}
        options.compressionLevel = compressionLevel
        compressedBuffer = await sharp(buffer).toFormat(format, options).toBuffer()

        if (process.env.DRY_RUN === 'true') {
          console.info(`compressing ${format} image... (size: ${compressedBuffer.length} bytes, quality: ${quality}, compressionLevel: ${compressionLevel}`)
        }

        compressionLevel++
      }
      break
    default:
      break
  }

  if (process.env.DRY_RUN === 'true') {
    console.info(`compressing ${format} image done (size: ${compressedBuffer.length} bytes, quality: ${quality}, compressionLevel: ${compressionLevel}`)
  }

  return compressedBuffer
}

// https://blog.dennisokeeffe.com/blog/2020-06-22-using-octokit-to-create-files
async function push(repoWithUsername, content, commitMessage, filepath, sha) {
  if (!process.env.COMMITTER_NAME) {
    console.error('The committer name was not supplied.')
    process.exit(1)
  }

  if (!process.env.COMMITTER_EMAIL) {
    console.error('The committer email was not supplied.')
    process.exit(1)
  }

  if (await repoArchived(repoWithUsername)) {
    console.error(`${repoWithUsername} is archived.`)
    process.exit(1)
  }

  const octokit = process.env.PERSONAL_ACCESS_TOKEN ?
                  new Octokit({ auth: process.env[process.env.PERSONAL_ACCESS_TOKEN] }) :
                  new Octokit({ auth: process.env.GITHUB_TOKEN })
  const [ owner, repo ] = repoWithUsername.split('/')

  for (let i = 1; i <= pushRetryMaximum; i++) {
    try {
      const response = await octokit.repos.createOrUpdateFileContents({
        owner: owner,
        repo: repo,
        path: filepath,
        message: commitMessage,
        content: Base64.encode(content),
        // https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#create-or-update-file-contents:~:text=Required%20if%20you%20are%20updating%20a%20file.%20The%20blob%20SHA%20of%20the%20file%20being%20replaced.
        sha: sha,
        committer: {
          name: process.env.COMMITTER_NAME,
          email: process.env.COMMITTER_EMAIL,
        },
        author: {
          name: process.env.COMMITTER_NAME,
          email: process.env.COMMITTER_EMAIL,
        },
      })

      return response // succeed
    }
    catch (error) {
      console.error(error)

      if (i === pushRetryMaximum) {
        console.error(`The attempt #${i} has failed. No more attempts will be made. Sorry, please try again.`)
      }
      else {
        console.error(`The attempt #${i} has failed. Move on to the next attempt.`)
      }
    }
  }
}

async function getFileFromRepo(repoWithUsername, path) {
  const octokit = process.env.PERSONAL_ACCESS_TOKEN ?
                  new Octokit({ auth: process.env[process.env.PERSONAL_ACCESS_TOKEN] }) :
                  new Octokit({ auth: process.env.GITHUB_TOKEN })
  const [ owner, repo ] = repoWithUsername.split('/')

  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path: path,
    })

    // A target file is found.
    return response
  }
  catch (error) {
    if (error.status === 404) {
      // A target file is not found.
      return false
    } else {
      // Something goes wrong.
      console.error(error)
      return false
    }
  }
}

async function repoArchived(repoWithUsername) {
  const octokit = process.env.PERSONAL_ACCESS_TOKEN ?
                  new Octokit({ auth: process.env[process.env.PERSONAL_ACCESS_TOKEN] }) :
                  new Octokit({ auth: process.env.GITHUB_TOKEN })
  const [ owner, repo ] = repoWithUsername.split('/')

  try {
    const { data } = await octokit.repos.get({ owner, repo })
    return data.archived
  }
  catch (error) {
    console.error(`failed to get repository info: ${error.message}`)
    process.exit(1)
  }
}

// https://chatgpt.com/share/67a6fe0a-c510-8004-9ed8-7b106493bb4a
async function detectFileType(buffer) {
  const { fileTypeFromBuffer } = await import('file-type')
  return fileTypeFromBuffer(buffer)
}

// https://chatgpt.com/share/67a6fe0a-c510-8004-9ed8-7b106493bb4a
function generateFileHash(url) {
  return crypto.createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 32)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
