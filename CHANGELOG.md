# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- worktree isolation for parallel dispatch (`isolation: "worktree"`)
- CI/CD pipeline (GitHub Actions)
- Type safety improvements (type guard, DeepSeekMessage interface)

### Fixed
- Shell injection vulnerability in worktree.ts
- LLM API calls now have try/catch and timeout protection
- Write/read tools now handle errors gracefully
- Memory log race condition (atomic append)
- Memory filename uses ASCII only (dialogue_ instead of 对话_)
- Build system: scripts, lockfile dedup, tsconfig exclude

### Changed
- `todayFile()` renamed to `getTodayFilePath()`
- SubAgent LLM calls now timeout after 120s
