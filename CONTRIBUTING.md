# Contributing

Thanks for helping improve Tunnels. For a bug report, describe what happened, what you expected, your OpenChamber version and OS, which provider and CLI version you used, and reproduction steps. Redact account details, device codes, tunnel URLs, and credentials from logs and screenshots. For security concerns, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

Before a substantial change, open an issue to discuss its scope. Keep changes focused and include tests for service behavior and parsing changes where practical. This extension can expose local services to the internet, so preserve explicit confirmation for public tunnels and private-by-default Microsoft access.

## Local development

Install [Bun](https://bun.sh/) and run:

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run build
bun run check
```

Commit changes to `panel/main.js` and `service/main.js` alongside their TypeScript sources; users install those bundles directly. You can test the extension by adding the repository folder under **Settings → Extensions** in OpenChamber. Provider CLIs are needed on the OpenChamber server for integration testing. Never commit CLI credentials, origin certificates, local tunnel state, or `.env` files.

Contributions are submitted under the repository's [MIT license](LICENSE).
