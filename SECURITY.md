# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.8.x   | Yes       |
| < 1.8   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in Sentinel, please report it responsibly:

1. **Do NOT open a public GitHub issue** for security vulnerabilities.
2. Email **info@maicore.dev** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)
3. You will receive a response within 48 hours.
4. A fix will be released as a patch version (e.g., 1.8.4) with credit to the reporter.

## Security Considerations

### Credentials in Manifests

The `sentinel-manifest.json` file may contain test credentials (email/password pairs) auto-detected from `CLAUDE.md`, seed files, or environment variables.

**Mitigations:**
- `sentinel-reports/` is in the default `.gitignore`
- Manifests are stored inside run-scoped directories
- Never commit `sentinel-manifest.json` to version control
- Use dedicated test/dev credentials, never production secrets

### Sandbox Mode

The `--sandbox` flag enables destructive operations (DELETE, bulk, cascade) with per-action approval. Pre-flight checks verify:
- `APP_ENV` is not `production`
- Database name contains `dev`, `test`, `staging`, or `local`
- API base URL is `localhost`, `127.0.0.1`, or contains `dev`/`staging`

### Destructive Operations Safety Gate

Risk levels `high` and `critical` require explicit `"yes"` confirmation (not `y` or Enter). In `--ci` mode, high/critical risk levels are blocked entirely.

### Data Handling

- Sentinel reads source code but does not transmit it externally
- API sweep results (findings) are stored locally in `sentinel-reports/`
- No telemetry, analytics, or external data collection
- The plugin runs entirely within the Claude Code session

## Dependencies

Sentinel is a markdown-based plugin with no runtime dependencies. The sweeper agents use:
- `curl` for API testing (system binary)
- Playwright MCP for browser testing (user-installed)
- Standard shell utilities (`date`, `mkdir`, `jq`, etc.)

No npm packages, Python packages, or compiled binaries are bundled with the plugin.
