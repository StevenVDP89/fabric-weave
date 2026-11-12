# Backend

The scan and scoring pipeline that feeds the app. Deployed by `deploy.mjs` (also called from the root `install.mjs`).

```powershell
node backend\deploy.mjs --workspace <workspace-guid> [--no-run-pipeline | --run-pipeline] [--adopt] [--reset-schedule] [--out result.json]
```

It works on Windows, macOS and Linux: it needs Node 20 to 24 and the Azure CLI signed in (`az login`; set
`AZURE_CLI_PATH` if `az` is not on the PATH).

| Flag | Effect |
|---|---|
| `--no-run-pipeline` (alias `--skip-run`) | Do not run the pipeline after deploying. By default it runs once only when no `Files/app/portfolio.json` exists yet |
| `--run-pipeline` | Run it once even if a portfolio exists |
| `--adopt` | Take over an existing lakehouse, notebook or pipeline that has the expected name but no Fabric Weave marker and is not in `app/rayfin/.fabric-weave.json` or `.deployments.json`. Without it the deploy stops with a message naming the item |
| `--reset-schedule` | Replace the pipeline's schedule with the standard daily 02:00 UTC one. Without it an existing schedule is left alone, and a schedule is only created when the pipeline has none. Creating or replacing a schedule makes you its owner |
| `--version <x.y.z>` | The version written into the item marker (default: `version:` in `app/rayfin/rayfin.base.yml`) |
| `--out <file>` | Write the created item ids (lakehouse, notebooks, pipeline) as JSON so the installer can pass them on |

Environment variables: `FABRIC_WEAVE_JOB_TIMEOUT_MINUTES` (default 30) limits how long it waits for a Fabric job,
`FABRIC_WEAVE_REQUEST_TIMEOUT_SECONDS` (default 60) limits each REST call.

A full run takes about 8 to 10 minutes, most of it the first pipeline run. Every item it creates gets the description
`Fabric Weave v<version> (managed)` and is recorded in `app/rayfin/.fabric-weave.json`. Re-running overwrites the
notebooks and the pipeline definition (local edits are lost) and keeps the lakehouse data and the schedule.

## Items created

| Item | Purpose |
|---|---|
| `AIReadiness_LH` (lakehouse) | Tables below, plus `Files/app/portfolio.json` which the app reads |
| `NB_01_Scan_Inventory` | Admin Scanner scan of every workspace. Writes `scan_runs`, `model_inventory`, `model_scan_detail`, `scanner_coverage` |
| `NB_02_Usage` | Activity events for the last 28 days. Writes `model_usage`. Falls back to zeros if the admin API is not available |
| `NB_03_Quick_Score` | Applies the rule catalog to the scan detail. Writes `model_quick_score` and the `portfolio.json` export |
| `PL_AI_Readiness_Refresh` | Runs the three notebooks in order, daily at 02:00 UTC |

`catalog\rule-catalog.json` is the single list of rules (28 rules, 7 categories, version 1.2.0). The app engine and
the notebooks read the same file, so scores agree across both.

## Portfolio contract

`Files/app/portfolio.json`:

```
{ generatedAt, runId, catalogVersion, usageWindowDays, workspaces, models: [
  { workspaceId, workspaceName, modelId, name, usage, quickScore, tables, measures, scanError } ] }
```

The app caches the file for 5 minutes. `PORTFOLIO_PATH` (`<workspaceId>/<lakehouseId>`) tells it where to read. The
backend is optional: `node install.mjs --app-only` skips it, leaves `PORTFOLIO_PATH` unset, and the app hides the Portfolio page.

## Identity

The notebooks and the pipeline run as the user who last saved the schedule (the installer creates it, so that is you
unless someone saves it later). That user must be a Fabric administrator, or hold the admin-API tenant setting, for
the Admin Scanner and activity-event APIs. This is the one supported model; see
[docs/RUNBOOK.md](../docs/RUNBOOK.md#pipeline-owner-and-hand-over) for the hand-over when that person leaves.
Running the pipeline as a service principal is an optional advanced alternative that is not automated: you would
enable "Service principals can access read-only admin APIs" in the tenant settings, add it to the allowed group and
switch the schedule owner yourself.

The notebooks load `Files/config/notebook_shared.py` from the lakehouse, so anyone who can write to that folder can
change what runs as the pipeline owner. Keep the workspace membership small ([SECURITY.md](../SECURITY.md)).

## Run status

The notebooks write `Files/app/run_status.json` with the outcome of each run. The app uses it to warn when the last
run failed or the data is older than 36 hours.

## Reading the tables yourself

Use the lakehouse SQL endpoint (the tables use deletion vectors, so file-based Delta readers fail). Example check of
what the scanner returned: `SELECT * FROM scanner_coverage`.
