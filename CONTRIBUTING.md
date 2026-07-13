# Contributing to Relay Code

Thank you for considering contributing! We welcome bug reports, feature requests, and pull requests.

## Development Setup

1. Install [Bun](https://bun.sh) 1.3+
2. Fork and clone the repository
3. Run `bun install` to install dependencies
4. Copy `.env.example` to `.env` and add your `DEEPSEEK_API_KEY`

## Code Style

- The project uses [Biome](https://biomejs.dev) for linting and formatting
- Run `bun run lint` to check your code
- Run `bun run format` to auto-format
- All code must pass `bun run type-check` (TypeScript strict mode)

## Testing

- Run `bun test` for unit tests
- Run `bun run test:integration` for integration tests
- Add tests for any new functionality
- Ensure all tests pass before submitting a PR

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Run the full test suite: `bun test`
4. Submit a PR with a clear description of changes
5. Ensure CI passes on your PR

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):
- `feat: description` — new feature
- `fix: description` — bug fix
- `refactor: description` — code restructuring
- `docs: description` — documentation only
- `test: description` — test additions/fixes
- `chore: description` — maintenance tasks
