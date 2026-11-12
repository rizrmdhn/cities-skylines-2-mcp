/**
 * Which GitHub release the updater installs. The companion app is released from the same
 * repository as the game mod, so its releases are tagged `desktop-v<version>` (the mod's are not),
 * and "the latest release" of the repository is NOT necessarily a companion release. The updater
 * therefore lists the releases and picks the newest `desktop-v*` one itself. Electron-free, so
 * tests can load it.
 */

export const GITHUB_OWNER = "rizrmdhn"
export const GITHUB_REPO = "cities-skylines-2-mcp"
/** Keep in step with publish.tagNamePrefix in electron-builder.yml. */
export const RELEASE_TAG_PREFIX = "desktop-v"

export type UpdateChannel = "stable" | "beta"

/** A published companion release. */
export interface CompanionRelease {
  tag: string
  /** The tag without its prefix: "0.12.0", "0.12.0-beta.1". */
  version: string
  prerelease: boolean
  /** The release page (release notes). */
  url: string
}

/** The list GET /repos/{owner}/{repo}/releases answers (drafts are never visible unauthenticated). */
export const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=50`

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

interface ParsedVersion {
  core: [number, number, number]
  pre: string[]
}

export function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION.exec(version)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  }
}

/** Semantic-versioning order: negative when a < b. Unparsable versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return left ? 1 : right ? -1 : 0
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1
  }
  // A version without a prerelease part is newer than the same one with it.
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return Math.sign(left.pre.length - right.pre.length)
}

/**
 * Name of the update metadata file's channel: electron-builder writes `latest.yml` for a release
 * version and `<id>.yml` for `x.y.z-<id>.n` (e.g. `beta.yml`).
 */
export function channelOf(version: string): string {
  return parseVersion(version)?.pre[0] ?? "latest"
}

/** Where the files of a release (installer, latest.yml, blockmap) are downloaded from. */
export function releaseFeedUrl(tag: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}`
}

function releasePage(tag: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tag}`
}

/**
 * The newest published companion release for the channel: "stable" ignores prereleases, "beta"
 * takes the newest of both. `releases` is the unvalidated JSON of the releases API; anything that
 * is not a published `desktop-v<semver>` release is skipped.
 */
export function pickRelease(releases: unknown, channel: UpdateChannel): CompanionRelease | null {
  if (!Array.isArray(releases)) return null
  let best: CompanionRelease | null = null
  for (const entry of releases) {
    if (typeof entry !== "object" || entry === null) continue
    const { tag_name: tag, draft, prerelease } = entry as Record<string, unknown>
    if (typeof tag !== "string" || !tag.startsWith(RELEASE_TAG_PREFIX) || draft === true) continue
    const version = tag.slice(RELEASE_TAG_PREFIX.length)
    const parsed = parseVersion(version)
    if (!parsed) continue
    const isPrerelease = prerelease === true || parsed.pre.length > 0
    if (isPrerelease && channel === "stable") continue
    if (best && compareVersions(version, best.version) <= 0) continue
    best = { tag, version, prerelease: isPrerelease, url: releasePage(tag) }
  }
  return best
}
