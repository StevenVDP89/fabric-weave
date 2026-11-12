# Privacy and data flow

This page says what Fabric Weave reads, where it keeps it, what it sends to Azure OpenAI and what it does not
collect. It describes the code in this repository. Everything stays in your tenant, apart from the optional calls to
your own Azure OpenAI resource and the Rayfin command-line telemetry described below. The project has no server of
its own and receives nothing from your deployment.

## What is read

| Source | What | Used by |
|---|---|---|
| Power BI Admin Scanner API | For each workspace: workspace name and capacity, and per semantic model its name, owner (`configuredBy` sign-in name), storage mode, refresh schedule, tables, columns, measures (names, descriptions, hidden flags, DAX expressions), relationships when returned, and the data-source and query details the scanner returns. User and principal lists are removed before anything is stored | `NB_01_Scan_Inventory` (nightly) |
| Power BI activity events (last 28 days) | Event type, model id and date. User ids are counted in memory to give "unique users"; **the user ids are not stored** | `NB_02_Usage` (nightly) |
| Fabric items API, `getDefinition` | The model definition (TMDL): names, descriptions, DAX expressions, relationships, plus the other definition parts such as Power Query (M) source expressions and Copilot settings. Read when you open a model or apply a fix | The app, per request |
| Fabric / Power BI REST | Tenant, capacity and model settings (for example Q&A on, Copilot eligibility), role assignments, workspace and capacity names, and, to decide what each person may see and change, which semantic models and workspaces they can reach (Fabric admin API, cached in memory for a few minutes) | The app and the installer |
| Azure CLI sign-in | Your account name and Entra object id, to default `APP_ADMINS`, and an access token | The installer |

**Row data is never read.** The scan, the scoring and the app read metadata and definitions only. Nothing in the app or
the notebooks runs a DAX query against your models (the engine's Fabric client has an `executeDax` method, but no
code calls it).

## Where it is stored

All of it is in your own Fabric workspace.

**Lakehouse `AIReadiness_LH` (OneLake)** (only if you install the optional estate scan; an `--app-only` install has none)

- Delta tables `model_inventory`, `model_scan_detail`, `model_usage`, `model_quick_score`, `scanner_coverage` and
  `scan_runs`. `model_scan_detail` keeps the scanner's dataset JSON for each model (without user lists), so it
  contains the names, descriptions and DAX of every scanned model and any source details the scanner returned.
- `Files/app/portfolio.json` (what the app reads), `Files/app/run_status.json` (status of the last nightly run) and
  `Files/config/` (the rule catalog and the shared notebook code).
- Anyone with access to the lakehouse can read these files. Apply the access you would give to the metadata itself.

**App database (a Fabric SQL database created by Rayfin)**

| Entity | Content |
|---|---|
| `ModelAssessment` | Latest deep or quick score per model, category scores, top findings, who assessed it (sign-in name) |
| `WorkspaceSetting` | Write mode and "in scope" flag per workspace, an integrity signature, who changed it |
| `BusinessContext` | The business-context text you write or dictate (up to 4,000 characters), and older structured notes, per model; who saved it |
| `ChangeSet` | Every apply, proposal or rollback: model, mode, status, proposal ids, score before and after, who did it |
| `SnapshotChunk` | The rollback snapshot of a model before an in-place change: the complete definition parts as read from Fabric, JSON, gzip, base64, in chunks. This can include Power Query source details such as server and database names |
| `AuditLog` | One row per notable action or refusal: time, **sign-in name or Entra object id of the actor**, action, workspace and model id, a short detail, outcome |

**Rayfin secrets** on the deployed app item: `AOAI_ENDPOINT`, `AOAI_DEPLOYMENT`, `AOAI_API_VERSION` (optional), `PORTFOLIO_PATH`, `SIGNING_KEY`,
`APP_ADMINS` (optional; sign-in names or object ids of the app administrators).

**On your machine** (git-ignored): `app/rayfin/rayfin.yml`, `app/rayfin/.deployments.json` (Rayfin's record of your
deployment) and `app/rayfin/.fabric-weave.json` (ids of the items the installer created, and the version).

## What is sent to Azure OpenAI

Only when you configure `AOAI_ENDPOINT` and `AOAI_DEPLOYMENT`, and only to that endpoint, which should be your own
Azure OpenAI or AI Foundry resource. Without them nothing is sent, and the app uses rule-based drafts.

For the model being drafted, reviewed or interviewed about:

- the model name, table names, column names and data types, measure names and the relationships
  (`Table.Column -> Table.Column`); the structure overview leaves hidden objects out, the objects being described are
  sent in full (this includes hidden tables, columns and measures that have no description);
- the descriptions and DAX expressions of measures, and existing descriptions that are being reviewed or improved;
- the business-context text you saved for that model, and during an interview the questions and your typed or
  dictated answers.

Not sent: row data, Power Query (M) source expressions, connection details, user names, e-mail addresses or the
rollback snapshots. Requests carry the instruction to treat everything as data, but anything you type into a
description, name or business context goes to the model, so **do not put secrets or personal data there**.
AI output is shown as a proposal and is never applied without a person selecting it.

How Azure OpenAI handles data (retention, abuse monitoring, regional processing) is governed by the terms and
settings of your own Azure OpenAI resource. Fabric Weave does not change them.

Dictation uses the browser's Web Speech API. In Chrome and Edge the audio is processed by the browser vendor's
speech service, not by Fabric Weave or Azure OpenAI; the app receives only the recognised text.

## What is not collected

- No row data from any semantic model.
- No user ids from activity events, no user or principal lists from the scanner.
- No usage analytics, tracking or error reporting from the app or the notebooks to the project or its authors.
- No data leaves your tenant, except what is listed above for Azure OpenAI, and the telemetry below.

## Retention

Nothing is deleted automatically, with these exceptions:

- the nightly run **overwrites** `model_inventory`, `model_scan_detail`, `model_usage`, `model_quick_score` and
  `scanner_coverage` with the latest scan (Delta keeps older table versions until the lakehouse's own retention and
  `VACUUM` remove them); `scan_runs` gets one row per run and keeps them;
- after an in-place apply the app keeps the last 5 rollback snapshots per model and deletes older ones (best effort).

Assessments, change sets, business context, workspace settings and the audit log stay until you remove them. The app
has no screen to delete them; delete rows in the Fabric SQL database, or remove the app (below).

## Rayfin telemetry

The installer runs the Rayfin command-line tool (`rayfin up`, `rayfin secret ...`). By default that tool sends one
usage event per command to Microsoft (Azure Application Insights). Reading the tool's code (version 1.36), the event
holds the command name, the names (not the values) of the parameters, the result and duration, the CLI version, the
operating system, a random device id, the project id from `app/rayfin/.project.json`, the names and versions of
Microsoft packages, a category for the execution environment (for example CI) and Fabric activity ids. It does not
include secret values, tokens or model data.

To switch it off, run the installer with `--opt-out-telemetry`, or set `RAYFIN_TELEMETRY_OPTOUT=1` in your
environment before you run any `rayfin` command. This section describes the command-line tool; the runtime of the
deployed app was not reviewed for telemetry.

## Removing your data

```powershell
node tools/teardown.mjs --workspace <workspace-guid> --dry-run    # what would be deleted
node tools/teardown.mjs --workspace <workspace-guid>              # delete, after typing the workspace name
```

Teardown deletes the items Fabric Weave created: the app with its database (assessments, change sets, snapshots,
business context, audit log), the pipeline, the three notebooks and the lakehouse (add `--keep-lakehouse` to keep the
lakehouse and its history). It never touches your semantic models or other items, and it only removes items that
carry the Fabric Weave marker or that this machine's installer recorded (see the runbook for `--include-unmarked`).
Remove the app's access to other workspaces, and any Azure OpenAI role assignment, yourself. Delete the local files
listed above if you want them gone too. Rollback snapshots are deleted with the app, so roll back anything you need
first.
