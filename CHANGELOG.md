# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Worktree isolation for parallel dispatch (`isolation: "worktree"`)
- CI/CD pipeline (GitHub Actions)
- Type safety improvements (type guard, DeepSeekMessage interface)
- Pre-commit hooks (husky + lint-staged)
- Biome linter and formatter
- English and Chinese README with Mermaid architecture diagram

### Fixed
- Shell injection vulnerability in git command execution
- LLM API calls now have try/catch and timeout protection (120s)
- Write/read tools handle errors gracefully
- Memory log race condition (atomic append)
- Memory filename uses ASCII only (`dialogue_` instead of `对话_`)
- Build system: scripts, lockfile dedup, tsconfig exclude

### Changed
- `todayFile()` renamed to `getTodayFilePath()`
- SubAgent LLM calls now timeout after 120s
- Harness refactored into 5 modules (plan-manager, message-assembler, tool-executor, dispatcher)
- project structure: tests grew from 26 → 43

## [0.1.0] — 2026-07-13

### Added
- Initial release
- ReAct loop with tool calling
- dispatch sub-agent orchestration
- Plan-driven execution (plan.md injection)
- Sub-agent structured output (keyFindings, decisions, summary)
- Dialogue persistence to JSONL
- MIT license

[Unreleased]: https://github.com/evenli0/Relay-Code/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/evenli0/Relay-Code/releases/tag/v0.1.0
