# Upgrading

Upgrading is a re-run of the installer from the newer code. There is no separate upgrade command and no migration
step for the app database in 1.0.

## Steps

1. Pick a quiet moment: no one should be applying or rolling back changes in the app while you upgrade (see
   "Rollback snapshots" below).
2. Get the new code: `git pull` on a clone, or unpack the new release zip. If you unpack a zip into a new folder, copy
   your old `app/rayfin/.deployments.json` and `app/rayfin/.fabric-weave.json` across first. Without them the
   installer cannot tell that the items in the workspace are yours (see "Items without a record" below).
3. Check the environment, read-only:
   `node tools/preflight.mjs --workspace <workspace-guid> [--aoai-endpoint <url>]`
4. Re-run the installer with the same arguments you used the first time:
   `node install.mjs --workspace <workspace-guid> --aoai-endpoint <url>`
   It prints `upgrading from vX to vY` when the recorded version differs from the one in `app/rayfin/rayfin.base.yml`.
5. Run the checks below.

Use `node install.mjs --help` for all flags. Add `--non-interactive` for unattended runs.

## What the installer overwrites

With `--app-only` there is no estate scan, so the notebooks, pipeline and lakehouse below are neither written nor read;
only the app code and secrets apply.

- The three notebooks (`NB_01_Scan_Inventory`, `NB_02_Usage`, `NB_03_Quick_Score`) and the shared files in the
  lakehouse `Files/config` folder (`notebook_shared.py`, `rule-catalog.json`). **Local edits to them are lost.**
- The pipeline definition. Local edits are lost, so an alert activity you added to the pipeline must be added again.
- The app code and the secrets `PORTFOLIO_PATH` (not with `--app-only`), `AOAI_ENDPOINT` and `AOAI_DEPLOYMENT`. Pass `--aoai-endpoint` again,
  or the AI secrets stay as they were but are not re-set. When you pass `--aoai-endpoint`, also pass `--aoai-deployment`
  again if you use a deployment other than `gpt-4.1`, because the installer re-sets it to its default otherwise.
  `AOAI_API_VERSION` is only touched when you pass `--aoai-api-version`.
- `app/rayfin/rayfin.yml`, which is generated from `rayfin.base.yml`. Do not edit it; edit the base file.
- The description of the items it created (the Fabric Weave version marker).

## What it keeps

- `SIGNING_KEY`, unless you pass `--rotate-signing-key`. Rollback snapshots saved earlier stay valid.
- `APP_ADMINS`, unless you pass `--admins`. If it holds only sign-in names, add your object id (see "After the upgrade").
- The nightly schedule. It is only created if the pipeline has none; `--reset-schedule` replaces it.
- The lakehouse and its tables and files. The next nightly run rewrites the tables anyway.
- The app database: assessments, business context, change sets, snapshots, workspace settings and the audit log.
- Dependencies in `app/node_modules` when `app/package-lock.json` has not changed; otherwise the installer runs
  `npm ci`.

The installer runs the pipeline once only when no `portfolio.json` exists yet. After an upgrade the data shown in the
app is from the last nightly run until the next one. Pass `--run-pipeline` to refresh it straight away, for example
when the new version changes how scores are computed.

## Rollback snapshots

Snapshots live only in the app database, and there is no export or backup of them. An upgrade does not touch them, and
they stay restorable as long as `SIGNING_KEY` is unchanged and the app can still read them. Because they cannot be
backed up, upgrade when no apply is in flight, and do not rotate the signing key unless you have accepted that older
snapshots can no longer be restored. If a change matters, keep a copy of the semantic model itself (Fabric Git
integration or a downloaded `.pbip`) before you upgrade.

## Items without a record

The installer only adopts items it can recognise as its own: the marker `Fabric Weave v<version> (managed)` in the
item description, or an id in `app/rayfin/.fabric-weave.json`, or an install recorded by Rayfin in
`app/rayfin/.deployments.json` (installs made before 1.0 have no marker and are stamped on the first re-run). If an
item has the expected name but none of these, the installer stops and tells you; pass `--adopt` only after checking
that the item really is yours.

## After the upgrade

- The installer's last lines print the app URL and the admins that are set. Open the app and check the Status page:
  it shows who you are signed in as, and the app warns when the last nightly run failed or the data is old.
- **Switching the estate scan on or off.** Re-running without `--app-only` on an app-only install adds the lakehouse,
  notebooks and pipeline and shows the Portfolio page. Re-running with `--app-only` on a full install sets
  `PORTFOLIO_PATH` to `disabled`, which hides the page; it does not delete the scan items or stop the nightly run.
  See [Estate scan](RUNBOOK.md#estate-scan-optional).
- Open the pipeline in the Fabric portal (estate scan only). There should be one schedule, enabled, and the owner is the person who last
  saved it. Check that the next run happens, or run the pipeline once and confirm that all three notebooks succeed.
- Look at `CHANGELOG.md` for anything that changes behaviour, for example new settings or scoring changes.
- Open a model and confirm the score, then try a change in propose-only mode before you use in-place mode again.
- **Coming from a pre-1.0 install:** workspace write modes are now signed. A workspace that was set to in-place or
  clone before the upgrade shows an "unverified" badge and behaves as propose-only until a workspace Admin (or an app
  administrator) opens Workspaces, chooses the write mode again and saves. The same applies after
  `--rotate-signing-key`, because the signature uses `SIGNING_KEY`. Nothing is lost; nothing is written to a model until
  it is confirmed.
- **Per-person access:** people are now checked against their own Fabric permissions, and `APP_ADMINS` is an optional
  override. The app's sign-in token carries your Entra object id but no e-mail, so an existing `APP_ADMINS` value made
  only of sign-in names matches nobody. Re-run the installer with `--admins you@contoso.com,<your object id>` (or leave
  `--admins` out to use the Azure CLI account, which now adds the object id itself). Make the app owner a Fabric
  administrator so group-based access is visible (see "Who can see and change what" in `RUNBOOK.md`).

## Going back

There is no downgrade command. To go back, check out the older version and re-run its installer. Items and secrets
are reused the same way. The app database is not migrated in either direction in 1.0.
