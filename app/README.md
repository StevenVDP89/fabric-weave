# Fabric Weave app

This folder is the Fabric Weave Rayfin app, an npm workspace. What the project does, how to install it and how to
develop it are in the root [README.md](../README.md).

| Path | Content |
|---|---|
| `packages/engine` | Scoring, TMDL parser and patcher, fix proposals, LLM and Fabric clients |
| `packages/functions` | The Rayfin Functions and their libraries (apply, rollback, signing, access gate, portfolio) |
| `packages/data` | Entities for the app database |
| `packages/shared` | Types shared by data and functions |
| `packages/frontend` | React UI |
| `rayfin/rayfin.base.yml` | App configuration (tracked). The installer generates the git-ignored `rayfin/rayfin.yml` from it |
| `scripts/validate-functions.mjs` | Build step that checks the Functions contract |

Develop from here with `npm ci`, `npm run typecheck`, `npm run build`, `npm run lint` and `npm test`. Before you run any
`rayfin` command in this folder, run `node ../install.mjs --prepare-only` once to write `rayfin/rayfin.yml`. Deploy with
the root installer, not with a bare `rayfin up` (it would drop the sign-in redirect URL).

`.agents/`, `AGENTS.md`, `.mcp.json` and the other files in `scripts/` come from the Rayfin app template. They help
developers who extend the app with coding agents (`npm run pack:add`, `npm run test:template`) and are left out of the
release zip. They are not needed to install or run Fabric Weave.

Licensing: see [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). The Rayfin template files in this folder are
(c) Microsoft Corporation under the MIT licence in [LICENSE](LICENSE).
