const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const DEFAULT_BRANCH = process.env.GITHUB_DEFAULT_BRANCH || 'main';

/**
 * Normalizes a user-supplied path: strips leading slashes, backslashes -> slashes,
 * collapses accidental "//" and blocks path traversal ("..").
 * GitHub's Contents API treats the path as a full route including any folders,
 * e.g. "mods/conveyor/Conveyor.java" — the folders are created implicitly,
 * there is no separate "make a folder" step.
 */
function normalizePath(rawPath) {
  let p = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  p = p.replace(/\/{2,}/g, '/');
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error('Path traversal segments ("." or "..") are not allowed.');
  }
  if (!p) throw new Error('Path cannot be empty.');
  return p;
}

/**
 * Looks up the current file's SHA if it exists, so we can overwrite it.
 * Returns null if the file does not exist yet (so we create it fresh).
 */
async function getExistingFileSha(path, branch) {
  try {
    const res = await octokit.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path,
      ref: branch,
    });
    if (Array.isArray(res.data)) {
      throw new Error(`"${path}" is a directory, not a file.`);
    }
    return res.data.sha;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Creates the file if it doesn't exist, or overwrites it if it does.
 * contentBuffer: Buffer of the raw file bytes.
 */
async function createOrOverwriteFile({ path, contentBuffer, message, branch }) {
  const cleanPath = normalizePath(path);
  const targetBranch = branch || DEFAULT_BRANCH;

  const existingSha = await getExistingFileSha(cleanPath, targetBranch);

  const res = await octokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path: cleanPath,
    message: message || (existingSha ? `Update ${cleanPath}` : `Add ${cleanPath}`),
    content: contentBuffer.toString('base64'),
    branch: targetBranch,
    sha: existingSha || undefined, // omit for new files, required to overwrite existing ones
  });

  return {
    overwritten: Boolean(existingSha),
    path: cleanPath,
    commitUrl: res.data.commit.html_url,
    commitSha: res.data.commit.sha,
  };
}

/**
 * Splits "owner/repo" into parts. Falls back to the configured OWNER/REPO
 * if nothing (or an empty string) is passed, so existing commands keep working
 * without requiring the user to type the repo every time.
 */
function resolveRepo(repoFull) {
  if (!repoFull || !repoFull.trim()) {
    return { owner: OWNER, repo: REPO };
  }
  const parts = repoFull.trim().replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Repo must be in the form "owner/repo", e.g. "Anuken/Mindustry".');
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Lists the immediate contents (files + folders) of a directory in any repo
 * the configured GITHUB_TOKEN can read (public repos are readable regardless
 * of token scope; private repos need the token to actually have access).
 */
async function listDirectory({ repoFull, path, branch }) {
  const { owner, repo } = resolveRepo(repoFull);
  const cleanPath = path ? normalizePath(path) : '';

  const res = await octokit.repos.getContent({
    owner,
    repo,
    path: cleanPath,
    ref: branch || undefined,
  });

  const entries = Array.isArray(res.data) ? res.data : [res.data];
  return entries
    .map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Full-text-ish search across every file AND folder path in a repo, using the
 * git trees API (recursive) rather than GitHub's code search — this also
 * matches folder names and doesn't require the code-search index to be built,
 * which makes it more reliable for smaller/newer repos.
 */
async function searchFiles({ repoFull, query, branch }) {
  const { owner, repo } = resolveRepo(repoFull);
  if (!query || !query.trim()) throw new Error('Search query cannot be empty.');

  const targetBranch = branch || DEFAULT_BRANCH;

  // Resolve the branch to a commit tree SHA first — the trees endpoint needs an actual SHA.
  const branchInfo = await octokit.repos.getBranch({ owner, repo, branch: targetBranch });
  const treeSha = branchInfo.data.commit.commit.tree.sha;

  const treeRes = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: '1',
  });

  const q = query.trim().toLowerCase();
  const matches = treeRes.data.tree
    .filter((item) => item.path.toLowerCase().includes(q))
    .map((item) => ({
      path: item.path,
      type: item.type === 'tree' ? 'dir' : 'file',
      size: item.size,
    }));

  return { matches, truncated: Boolean(treeRes.data.truncated), owner, repo, branch: targetBranch };
}

module.exports = {
  createOrOverwriteFile,
  normalizePath,
  resolveRepo,
  listDirectory,
  searchFiles,
  OWNER,
  REPO,
  DEFAULT_BRANCH,
};
