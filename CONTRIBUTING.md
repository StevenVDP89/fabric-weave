# Contributing

Thanks for helping. Fabric Weave is a Rayfin app (`app/`) plus a Fabric backend (`backend/`) and a few Node tools
(`install.mjs`, `tools/`). Node 20 to 24 is required (Rayfin does not support newer versions yet).

## Set up

```powershell
node install.mjs --prepare-only   # writes the git-ignored app/rayfin/rayfin.yml from rayfin.base.yml
cd app
npm ci
```

`npm ci` works against the public npm registry only. Do not commit a lockfile that points at a private feed:
the test `tools/test/common.test.mjs` fails if you do. After you add or upgrade a dependency (especially the
`@microsoft/rayfin-*` packages, which are also on GitHub Packages), run `node tools/verify-lockfile.mjs`: it checks
every `integrity` against the public registry, and `--fix` corrects the ones that came from a private feed. Then prove
it with `npm ci --cache <empty folder>`. Edit `app/rayfin/rayfin.base.yml` for app configuration, never
the generated `rayfin.yml` (it is git-ignored). This public snapshot omits the developer-only Rayfin agent scaffold
and template tooling. `app/scripts/validate-functions.mjs` is used by the build and must stay.

## Check your change

From the repository root:

```powershell
cd app
npm run typecheck
npm run lint
npm test                              # frontend (Vitest)
npm test -w @rayfin-app/engine        # scoring, patching, apply round trips
npm test -w @rayfin-app/functions     # signing and part paths
cd ..
node --test "tools/test/*.test.mjs"   # installer, preflight and teardown helpers
python -m unittest discover -s backend/tests -p "test_*.py"   # notebook scoring parity
```

CI runs the same commands plus the frontend build, the Python tests, the installer dry runs, `npm audit` for production
dependencies (reviewed exceptions live in `tools/audit-allowlist.json` with a reason and an expiry date) and a check
that `backend/catalog` matches what the engine exports. If that check fails, run
`npm run build -w @rayfin-app/engine` and `npm run export:catalog -w @rayfin-app/engine` in `app/` and commit the
result.

## Guidelines

- The rule catalog (`backend/catalog/rule-catalog.json`) is shared by the app and the notebooks. Change it in one place
  and keep both scorers in step.
- Anything that writes to a customer model needs a snapshot first and has to be reversible. Keep the
  "never change an existing key" and "refuse what the service would reject" behaviour intact.
- Add a test with every fix. Engine and tool tests run without a tenant.
- Keep the installer safe to re-run: it must not delete or adopt items it did not create (the managed marker and the
  local manifest decide), and anything it overwrites must be listed in `docs/UPGRADING.md`.
- Never commit secrets, tenant ids, hosting URLs or snapshot files (`tools/snapshots/` is ignored). Use placeholders
  such as `00000000-0000-0000-0000-000000000000` and `contoso` in tests and docs.
- Do not call the audit log "immutable"; it is best-effort evidence ([SECURITY.md](SECURITY.md)).

## Pull requests

Describe what changed and why, and how you checked it (see the template). Small, focused pull requests are easier to
review.
