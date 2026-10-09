<p align="center">
  <img src="icons/icon.svg" width="96" height="96" alt="GitHub Folder Downloader icon" />
</p>

# GitHub Folder Downloader

Select files and folders on a GitHub repository tree page and download them as a ZIP archive.

**English** · [简体中文](README.zh-CN.md)

## Features

- Adds a **Download** button to the code view header, just left of **Add file**.
- Clicking it enters **selection mode**: a checkbox appears on every file/folder row.
- Select files and/or folders (selecting a folder downloads everything inside it).
- Supports **select all**, **invert**, and folder **indeterminate** states.
- Shows download/packaging **progress**.
- Optional **Personal Access Token** to lift the GitHub API rate limit and access private repos.
- Submodules, symlinks and Git LFS pointers are skipped automatically.

## How it works

1. The content script detects a repository tree page and injects the toolbar.
2. On download, if folders were selected it fetches the full tree once via
   `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` (a `truncated` response
   means the repo has >100k files and is reported as unsupported).
3. Each file is fetched from `raw.githubusercontent.com` with a concurrency of 6
   and retry/backoff.
4. Files are packed into a ZIP (STORE, no compression) preserving
   repo-relative paths, then saved via a Blob URL.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.
4. Open any repo's code page, e.g. `https://github.com/octocat/Hello-World`.

## Configure a token (optional but recommended)

Open the extension popup → **Open settings**, or `chrome://extensions` → Details →
Extension options. Paste a fine-grained token with `Public Repositories (read-only)`
(or `Contents: Read` for private repos).

## Notes / limitations

- Anonymous GitHub API limit is ~60 requests/hour; configure a token for 5000/hour.
- Repositories with more than 100,000 files are not supported (tree is truncated).
- LFS files are downloaded as their pointer files (LFS content download is not implemented).
- Large selections are only **warned** about, never blocked.

## Language

The UI follows your browser language via `chrome.i18n`. English and Simplified Chinese
are bundled; any other language falls back to English.

## License

MIT

