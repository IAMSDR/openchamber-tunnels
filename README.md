# Tunnels for OpenChamber

Manage local [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) and [Microsoft Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/) from OpenChamber. Create and start tunnels in the Tunnels panel, and check their state and URLs in Work Status. This is an independent extension; Cloudflare and Microsoft are third-party providers.

## Install

Requires OpenChamber 2.7.1 or newer. In **Settings → Extensions**, paste this repository URL and click **Add**:

```text
https://github.com/IAMSDR/openchamber-tunnels
```

For private access, use `git@github.com:IAMSDR/openchamber-tunnels.git` with a Git identity that can read the repository. You can also clone it and add its absolute path **on the OpenChamber server**. The panel and service ship prebuilt; no build is needed to install.

Approve the requested permissions to **run a local service** and execute `cloudflared` and `devtunnel`, then open **Tunnels** on the right rail. Install [cloudflared](https://developers.cloudflare.com/tunnel/downloads/) and/or [devtunnel](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started) on the **OpenChamber server**; a browser-only client cannot host ports on its own machine. **Accounts** provides OS-specific setup guidance and a CLI re-check button. Restart OpenChamber if its `PATH` changed. Provider CLIs handle authentication; the extension does not need your credentials.

## Use

1. In **Accounts**, sign in for Microsoft Dev Tunnels with a Microsoft or GitHub device code, or sign in to Cloudflare for named DNS tunnels. Cloudflare Quick needs no sign-in. Approve login in your browser; never paste credentials into the panel.
2. In **Tunnels**, choose **New tunnel** and enter a name and the port where your local app is listening. Start it explicitly when ready.
3. Use **Stop** when finished. **Remove locally** stops the tunnel and deletes only its extension entry; it does **not** delete provider-side tunnels or DNS records.

Microsoft tunnels default to authenticated access; anonymous access is opt-in. Cloudflare Quick and named hostnames are public, require explicit confirmation, and do **not** provide authentication by themselves. Configure [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/) separately for protected named hostnames. Do not share a tunnel URL unless you intend to expose the app behind it.

Cloudflare named tunnel creation and DNS setup can create remote resources when first started. Microsoft port changes may also affect provider-side state. The optional **Keep running after OpenChamber exits** setting detaches the process on the server; it does not guarantee uptime after a reboot or extension removal. The saved definition remains available when the process stops.

## Development and support

Run `bun install --frozen-lockfile`, `bun run test`, `bun run typecheck`, `bun run build`, and `bun run check` before contributing. The generated bundles are committed so downloaded checkouts work without a build. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

Licensed under [MIT](LICENSE).
