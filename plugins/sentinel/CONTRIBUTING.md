# Contributing to Sentinel

Thanks for your interest in contributing to Sentinel! This guide covers how to set up, develop, test, and submit changes.

## Getting Started

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/sentinel-sweep.git
   cd sentinel-sweep
   ```

2. Install as a local plugin:
   ```bash
   claude plugin marketplace add /path/to/sentinel-sweep
   claude plugin install sentinel
   ```

3. Verify your setup:
   ```
   /sentinel setup
   ```

## Repository Structure

```
sentinel-sweep/
  VERSION                          # Single source of truth for version
  commands/sentinel.md             # Legacy command (must stay in sync with skill)
  skills/run/SKILL.md              # Main orchestrator (Skills 2.0)
  skills/sentinel-setup/SKILL.md   # Environment setup skill
  agents/                          # Sweeper and manifest agents
  plugins/sentinel/                # Installable mirror (must match root)
  schemas/                         # JSON Schema definitions
  tests/                           # Integration test suites
  scripts/                         # Utility scripts (bump-version.sh)
  docs/                            # Design documents
```

## Development Guidelines

### Editing the Orchestrator

The orchestrator logic lives in **two** files that must stay identical:
- `commands/sentinel.md` (legacy command format)
- `skills/run/SKILL.md` (Skills 2.0 format)

Only the YAML frontmatter differs. After editing one, copy the body to the other. The CI test `test-structure.sh` verifies parity.

### Plugin Mirror

The `plugins/sentinel/` directory is the installable copy. After any change to root-level files, copy them to the mirror:

```bash
cp agents/*.md plugins/sentinel/agents/
cp skills/run/SKILL.md plugins/sentinel/skills/run/SKILL.md
cp skills/sentinel-setup/SKILL.md plugins/sentinel/skills/sentinel-setup/SKILL.md
cp settings.json plugins/sentinel/settings.json
cp README.md plugins/sentinel/README.md
cp LICENSE plugins/sentinel/LICENSE
```

The `test-mirror-parity.sh` test catches drift.

### Hello Protocol

Every agent and skill must implement the Hello Protocol:
- `hello` -> short greeting (1-2 lines)
- `hello <name> ID` -> full capability profile

See any agent file for the pattern.

### Version Consistency

The `VERSION` file at the project root is the single source of truth. Use the bump script to update all files at once:

```bash
./scripts/bump-version.sh 1.3.0
```

This updates VERSION, all JSON/MD files, and syncs the plugin mirror. The `test-version-consistency.sh` test verifies all locations match the VERSION file.

## Running Tests

```bash
# Run the full test suite (106+ tests)
./tests/run-all.sh

# Run individual suites
./tests/test-structure.sh         # File structure, Hello Protocol, parity
./tests/test-frontmatter.sh       # YAML frontmatter validation
./tests/test-manifest-schema.sh   # JSON Schema validation
./tests/test-mirror-parity.sh     # Root vs plugins/sentinel/ diff
./tests/test-version-consistency.sh # Cross-file version match
./tests/test-runtime-behavior.sh  # Runtime logic (risk scoring, dedup, etc.)
```

All tests must pass before submitting a PR. The same suite runs in GitHub Actions CI.

## Adding a New Subcommand

1. Add the subcommand to the argument parser in Step 1 (valid values list)
2. Add it to the usage block with description and example
3. Add a `### Subcommand: \`name\`` section with implementation steps
4. Update the `hello ID` profile to list the new command
5. Update the `argument-hint` in frontmatter
6. Mirror changes: command -> skill -> plugins/sentinel/
7. Update README.md commands table
8. Run tests

## Adding a New Sweeper Agent

1. Create agent file in `agents/` with:
   - YAML frontmatter (name, description, model, tools, version, triggers, references)
   - Hello Protocol section
   - Complete sweep instructions
2. Add dispatch logic in the orchestrator (both command and skill)
3. Follow the findings JSON schema (`schemas/findings.schema.json`)
4. Mirror to `plugins/sentinel/agents/`
5. Update report generation if new finding categories are introduced
6. Add tests

## Extending Framework Support

Currently v1 supports Vue 3 + FastAPI. To add a new framework:

1. Update `sentinel-setup` to detect the framework
2. Update `manifest-generator` with parsing rules for the framework's router/endpoint patterns
3. Add framework to the README "Framework Support" table
4. Add detection tests

## Commit Messages

Follow conventional commits:
- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation only
- `test:` adding/updating tests
- `chore:` maintenance, CI, mirror sync

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make changes following the guidelines above
3. Run the full test suite: `./tests/run-all.sh`
4. Ensure plugin mirror is in sync
5. Submit a PR with a clear description of what changed and why

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 license.
