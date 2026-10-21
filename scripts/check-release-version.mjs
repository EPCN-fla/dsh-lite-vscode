/** Fail before publishing when the tag, manifest and lockfile disagree. */
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const tag = process.env.GITHUB_REF_NAME
if (tag !== `v${manifest.version}` || lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) {
  throw new Error('Release tag must equal v<package.json version>, and package-lock.json versions must match.')
}
console.log(`Release version verified: ${tag}`)
