# Third-party notices

## Fabric Weave

Fabric Weave's own code (the installer, `backend/`, `tools/`, `docs/`, `app/packages/*` and the rest of this
repository, apart from the files listed below) is released under the MIT licence in the root [LICENSE](LICENSE).

Fabric Weave is a community accelerator. It is not an official Microsoft product.

## Rayfin app template files

The Fabric Weave app was started from the Rayfin app template. These files in `app/` come from that template and are
(c) Microsoft Corporation, under the MIT licence in [app/LICENSE](app/LICENSE), which is kept unchanged:

- `app/.agents/` (agent skills), `app/AGENTS.md`, `app/.mcp.json`
- `app/scripts/` (scaffold and template tooling, and `validate-functions.mjs`, which the build uses)
- `app/rayfin-template.yml`, `app/tsconfig.base.json`, `app/tsconfig.json` and other scaffold configuration
- `app/LICENSE`

Some of these files have been modified for Fabric Weave (for example `app/package.json`). The Microsoft copyright notice
still applies to the original template text. `app/README.md`, `app/SECURITY.md` and `app/CODE_OF_CONDUCT.md` were
replaced with Fabric Weave text, because the originals describe Microsoft's own repositories.

This public snapshot and its release archive omit the folders that only help developers extend the app with
coding agents (`app/.agents`, `app/AGENTS.md`, `app/.mcp.json` and the scaffold scripts); see `.gitattributes`.
The required build validator and the original Microsoft licence are retained.

## Rayfin SDK and CLI packages

The app depends on `@microsoft/rayfin-*` and `@microsoft/fabric-*` npm packages. They are **pre-release** dependencies:
`app/package.json` asks for `^1.36.0-alpha` of `@microsoft/rayfin-cli` and `@microsoft/rayfin-guide`, and the lockfile
resolves 1.36.2. In the installed packages (checked in `node_modules` when this file was written) the `license` field of
every `@microsoft/rayfin-*` and `@microsoft/fabric-*` package reads `MIT`, and the CLI package ships a `LICENSE` file
that starts "Copyright (c) Microsoft Corporation. MIT License".

That is what those packages declare today. Pre-release packages can change their terms or their availability, and this
repository does not redistribute them: `npm ci` downloads them from the public npm registry. **Check the licence and
terms of the exact versions you install** (`npm ls @microsoft/rayfin-cli`, then `npm view` or the package's `LICENSE`)
before you redistribute or build on them. Fabric Weave makes no claim about them.

The Rayfin CLI also sends usage telemetry unless you opt out: see [docs/PRIVACY.md](docs/PRIVACY.md#rayfin-telemetry)
and the installer flag `--opt-out-telemetry`.

## Other npm dependencies

Other dependencies (React, Vite, TypeScript, `lucide-react` icons and their transitive packages) are installed from the
public npm registry under their own licences, which are in each package's folder in `app/node_modules`. The two
background images in `app/packages/frontend/src/assets` (`weave-ribbons*.webp`) are part of this project. Check the
licences of the dependencies you ship before you redistribute a build.
