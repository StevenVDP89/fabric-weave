# Runbook

## Prerequisites

- A Fabric workspace for the solution, on an F2+ capacity (Rayfin apps and Copilot both need one).
- Node 20 to 24 (Rayfin does not support newer versions yet) and the Azure CLI, signed in with `az login`.
- The signed-in user is an admin of that workspace and a **Fabric administrator** (or holds the tenant setting that
  allows the admin APIs). This is the one supported identity model: the app owner's identity is what the app uses to
  ask Fabric what each person can reach, and, **if you install the estate scan**, the pipeline and its notebooks run as
  the user who created or last saved the schedule and call the admin Scanner and activity-event APIs. A non-admin user
  scans only what they can see, and the Agents tab shows tenant switches as "unknown". Running the pipeline as a service
  principal is an optional, advanced alternative that the installer does not automate (the tenant must allow service
  principals to use the Fabric and Power BI admin APIs, and you must switch the pipeline owner yourself).
- Decide who is an app administrator. Everyone who signs in is checked against their own Fabric permissions (see
  [Who can see and change what](#who-can-see-and-change-what)); the optional `APP_ADMINS` secret lists the people who can
  see and change everything the app can reach. The installer defaults it to the account signed in to the Azure CLI
  (sign-in name and object id). Make the app owner a Fabric administrator so that group-based and shared access is seen.
- `npm` (it ships with Node). Node 20 still works but is end of life; preflight warns about it.
- Optional: an Azure OpenAI or AI Foundry resource with a chat deployment (tested with `gpt-4.1`; other chat models and reasoning models are covered in [Choosing the AI model](#choosing-the-ai-model)) for AI drafts and the AI review. The endpoint you give the installer must belong to the resource that hosts the deployment (`https://<name>.openai.azure.com` or `https://<name>.cognitiveservices.azure.com`). Another resource in the same group that has no deployments will answer with an error.

## Install

Handing this to someone who has only a ZIP file? Give them [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md): one settings
file and one script (`deployment\Deploy.ps1`) wrap the commands below.

```powershell
node tools/preflight.mjs --workspace <workspace-guid> --aoai-endpoint https://<resource>.openai.azure.com   # optional, read-only
node install.mjs --workspace <workspace-guid> --aoai-endpoint https://<resource>.openai.azure.com --aoai-deployment gpt-4.1 --admins you@contoso.com
```

Re-running the installer is safe and is how you upgrade, but it is not a no-op: some steps are skipped when nothing
changed, others overwrite (see [UPGRADING.md](UPGRADING.md)). In order:

0. Preflight (the same checks as `tools/preflight.mjs`): Node and npm versions, Azure CLI sign-in, workspace reachable,
   capacity attached, active and big enough, your role, Fabric administrator, what is already in the workspace
   (including items named like Fabric Weave items that it did not create), the app administrators and the Azure
   OpenAI endpoint. It stops on a `[FAIL]` before anything is created; `[WARN]` lines do not stop it.
   `--skip-preflight` skips it (not recommended).
1. Backend (the **estate scan**; skipped with `--app-only`, see [Estate scan](#estate-scan-optional)): creates the
   `AIReadiness_LH` lakehouse, uploads the rule catalog and notebook helpers, deploys
   `NB_01_Scan_Inventory`, `NB_02_Usage`, `NB_03_Quick_Score` and `PL_AI_Readiness_Refresh`, and stamps each with a
   `Fabric Weave v<version> (managed)` marker in its description. The notebooks and the pipeline definition are
   **overwritten** on every run. It creates the daily 02:00 UTC schedule only if the pipeline has none. It runs the
   pipeline once (about 8 to 10 minutes) only if no `portfolio.json` exists yet.
2. `npm ci` in `app/` when `node_modules` is missing or `app/package-lock.json` changed since the last install
   (the lockfile points at the public npm registry, so no private feed is needed), otherwise it is skipped.
3. Generates `app/rayfin/rayfin.yml` from the tracked `rayfin.base.yml`, then the first `rayfin up` creates the app
   item, database schema and static hosting.
4. Secrets: `PORTFOLIO_PATH` (workspace/lakehouse; not set with `--app-only`), `AOAI_ENDPOINT` and `AOAI_DEPLOYMENT` (if you passed an endpoint),
   a generated `SIGNING_KEY` and `APP_ADMINS` (default: the Azure CLI account, name and object id). The last two are kept
   if they exist (`--rotate-signing-key` and `--admins` replace them). The installer prints the admins it set.
5. Adds the hosting URL to the sign-in redirect list in the generated `rayfin.yml` and runs `rayfin up` again so the
   secrets take effect.

Use `--dry-run` to print the steps without changing anything. Unknown flags are rejected, so a typo cannot silently
change what gets deployed. The flags are listed in [Installer flags](#installer-flags).

**Upgrading from the "ai-readiness-cockpit" name.** The app item in an existing workspace keeps its old name
(`ai-readiness-cockpit`); Fabric does not rename it and nothing is lost. The installer finds it again from
`app/rayfin/.deployments.json` or, when that file is missing (a fresh clone), by looking for the app item in the
workspace. New workspaces get an item called "Fabric Weave".

## Estate scan (optional)

The estate scan is the lakehouse, the three notebooks and the nightly pipeline. It only feeds the **Portfolio** page.
Everything else works without it: **Models** and **Workspaces** call Fabric live, so scoring, the Fix workbench, AI
drafts, the context interview and rollback need no lakehouse. The Portfolio page is filtered to what each person may see
as well, so the scan is not what limits people to their own models.

| | With the estate scan (default) | App only (`--app-only`) |
|---|---|---|
| Portfolio page: totals and a table of every model the person may see | yes | no, the page and its menu entry are hidden |
| Quick score for every model before anyone opens it | yes | no, a model is scored when it is opened |
| Usage and adoption (views and unique users in 28 days, unused models) | yes | no |
| Inventory of workspaces the app identity is not a member of (from the Admin Scanner) | yes | no, only workspaces the app identity can reach appear |
| What you must set up | a Fabric administrator who owns the pipeline | nothing beyond the app |
| Ongoing capacity use | the nightly run (about 8 to 10 minutes) | none |

Install without it:

```powershell
node install.mjs --workspace <workspace-guid> --app-only --aoai-endpoint https://<resource>.openai.azure.com --admins you@contoso.com
```

`--app-only` skips step 1, leaves `PORTFOLIO_PATH` unset and cannot be combined with `--skip-backend`, `--lakehouse`,
`--run-pipeline` or `--reset-schedule`. The app opens on **Models**, and **Status** shows "Estate scan and Portfolio page"
as optional and not installed.

- **Add the scan later:** run the installer again without `--app-only`. It deploys the lakehouse, notebooks and pipeline,
  sets `PORTFOLIO_PATH` and runs the pipeline once. Nothing else changes.
- **Remove the scan from a full install:** run the installer again with `--app-only`. It sets `PORTFOLIO_PATH` to
  `disabled` (secrets cannot be deleted from the CLI), which hides the Portfolio page. It does **not** delete the
  lakehouse, notebooks or pipeline, and the nightly run keeps going until you disable the schedule or delete those
  items in the Fabric portal. `tools/teardown.mjs` removes the whole install, app included.

## After the install (manual, cannot be scripted)

| Step | Why |
|---|---|
| Open the app URL, sign in, open **Status** | Every row should be green. A red Fabric row means the app identity (the app owner's identity) is missing from a workspace. The page also shows "You are signed in as ..." and, under "What you can see and change", how your own access was worked out. |
| Make the app owner a Fabric administrator (a Fabric admin role in Microsoft 365 or Entra) | The app then asks the Fabric admin APIs what each person can reach, group membership and sharing included. Without it, only direct workspace role assignments are read and group-based access is invisible. |
| Add the app identity to each workspace you want to read or change as Member or Contributor | The app reads and writes models with its own identity. A person is only shown, and can only change, what Fabric says they may, but the app identity must be able to reach it first. |
| If you configured Azure OpenAI: grant the app identity "Cognitive Services OpenAI User" on the resource that hosts the deployment | The LLM call uses the app identity. Owner or Contributor on the subscription is not enough, because those roles have no model data actions. |
| Tenant admin: confirm the admin APIs are available to the pipeline owner (or to a service principal you switch it to). Only with the estate scan | The scan reads the Admin Scanner and activity-event APIs. |
| Share the app with the people who should use it | Opening the app is not restricted: every signed-in user can read the stored assessments of the models they are allowed to see. Control who can open it with the Fabric sharing of the app item. |
| **Workspaces** page: choose a write mode per workspace and switch on "In scope" (as a workspace Admin or app administrator) | Nothing can be applied until a workspace is in scope (the default write mode is propose-only). |

## Verify the install

The deployed Functions only accept an Entra token that carries the `Item.Execute.All` scope, which the Azure CLI
cannot request. The check therefore needs a person with a browser:

1. Open the app URL and sign in (allow pop-ups for the site).
2. **Status**: "Fabric and Power BI access", "AI model for drafting and review", "Estate scan and Portfolio page" and "Rollback snapshot signing" should all be green (the AI model row and the estate scan row are optional; with `--app-only` the estate scan row stays amber on purpose).
3. **Portfolio** (only with the estate scan): the models from the last pipeline run, each with a quick score and usage.
4. **Models** > open a model > **Overview**: the deep score and the failed rules.
5. **Fix workbench**: nothing is selected at first (the dial shows today's score). Select proposals and watch the score rise, review the diff, apply on a workspace in clone mode first. The clone appears as
   "<model> (AI-ready)" and the page shows the re-read score.
6. For an in-place workspace: apply, then roll back from the change set list and confirm the score returns.

`tools/live-check.mjs` calls the deployed Functions from a terminal if you can supply an `ENTRA_TOKEN` with that
scope (for example from an app registration you own); see the header of the file.

Without a browser you can still prove the engine against your tenant: `node tools/cli.mjs deploy-sample --workspace <id>`,
then `score` and `fix [--apply]`. That path uses your Azure CLI identity and exercises the same scoring, patching
and Fabric calls as the app.

## Write modes

| Mode | Writes to the model | Undo |
|---|---|---|
| In-place | Yes, after saving a signed snapshot | Roll back from the change set list, newest change set first. The last 5 snapshots per model are kept. |
| Propose-only (default) | Never. The change set and its diff are recorded for your team to review and apply | Nothing to undo |
| AI-ready clone | Creates "<model> (AI-ready)" in the same workspace, the original is untouched | Delete the clone |

A clone is a new model: set its data source credentials and refresh it before pointing reports at it.

## Operations

- **Pipeline** (estate scan only): `PL_AI_Readiness_Refresh` runs daily at 02:00 UTC. Run it on demand from the workspace.
  `scan_runs` records every run; `scanner_coverage` records which metadata the scanner returned.
- **"Views" on the portfolio** is the number of view events in a 28-day window, not 30 days.
- **Rotate the signing key**: `node install.mjs --workspace <id> --skip-backend --lakehouse <id> --rotate-signing-key`.
  Snapshots saved before the rotation can no longer be restored, so rotate when no rollback is pending.
- **Redeploy the app after a code change**: `node install.mjs --workspace <id> --skip-backend --lakehouse <id>`. It keeps
  the signing key and the admins, regenerates `app/rayfin/rayfin.yml` and re-adds the app's hosting URL to the sign-in
  redirect list. Do not run a bare `cd app; npx rayfin up` instead: `rayfin.yml` is generated and git-ignored, and
  the hosting URL is tenant specific, so a manual `up` that uses a plain copy of the base file replaces the redirect
  list and sign-in fails with a redirect URI error until the installer (or you) adds the URL back. If you must run
  `rayfin up` yourself, run `node install.mjs --prepare-only` first (it writes `rayfin.yml` from `rayfin.base.yml`),
  set `RAYFIN_TOKEN` from `az account get-access-token --resource https://api.fabric.microsoft.com` and add the hosting
  URL under `allowedRedirectUris` in `app/rayfin/rayfin.yml`. Change app configuration in `rayfin.base.yml`, never in
  the generated file.
- **Cost**: an F64 is billed while it is running. Pause the capacity when you are not using it, and read
  [Failure alerts](#failure-alerts-and-the-nightly-run) first: a paused capacity breaks the nightly run.
- **Developer-only folders**: `app/.agents`, `app/AGENTS.md`, `app/.mcp.json` and most of `app/scripts` come from the
  Rayfin app template and exist for developers who extend the app with coding agents. The release zip leaves them out
  (`.gitattributes`), and neither the installer nor `npm run build` needs them. Only `app/scripts/validate-functions.mjs`
  is used by the build. `npm run pack:add` and `npm run test:template` need the full git repository, not the zip.

## Who can see and change what

The app's Functions act with the app owner's identity, because Rayfin gives them no token for the person using the app.
So the app checks each person against Fabric itself, before it does anything as the owner. What a person gets:

| | A person | An app administrator (`APP_ADMINS`) |
|---|---|---|
| Workspaces and models listed | The ones Fabric says they can reach | Everything the app can reach |
| Apply fixes, roll back, approve for Copilot | Only on models where Fabric gives them **Write** | Everywhere |
| Change a workspace's write mode | Only if they hold the **Admin** role in that workspace directly | Everywhere |
| Save business context | The screen offers it only where they have Write | Everywhere |
| Portfolio | Rows for models they can reach | All rows |

- **Make the app owner a Fabric administrator.** Then the app uses the Fabric admin APIs
  (`/admin/users/{id}/access`, `/admin/items`), which resolve group membership and sharing. Status then says
  "Read from Fabric". If the owner is not a Fabric administrator, Status says "Read from workspace roles": only direct role
  assignments in workspaces where the owner is Member or higher can be read, and people who have access through a group
  see nothing until the owner is made a Fabric administrator or they are added to the workspace directly.
- **Someone sees nothing, or cannot change a model they expect to**: ask them to open **Status** and read "What you can see
  and change" (the source, the counts and the note say why). A refused attempt is in the audit log as `access.denied`.
  Access is remembered for 5 minutes, so a new permission can take that long to show; changes are always checked fresh.
- **Fabric's admin APIs allow 200 requests an hour.** The cache is sized for that. A large tenant with many active
  users in the same hour can still run into it; the app then keeps showing the last answer for up to an hour and refuses
  changes it cannot check.
- **Limits**: this is a check inside the app, not Fabric enforcement. A person who is a workspace Admin only through a
  group cannot change write modes (an app administrator can). The app database is not locked per person: stored
  assessments are readable by every signed-in user. See [SECURITY.md](SECURITY.md#known-limits).

## Administrators (APP_ADMINS)

`APP_ADMINS` is an optional Rayfin secret holding a comma-separated list of sign-in names (e-mail or UPN) or Entra object
ids. The people in it skip the per-person checks above and see and change everything the app can reach, which suits a
central team that looks after the whole estate. With no value, nobody gets that override and everyone is checked against
Fabric. Refused attempts are written to the audit log.

- **Who is set**: the installer uses `--admins a@contoso.com,b@contoso.com`, or by default the account signed in to
  the Azure CLI (its sign-in name and its object id). On a re-run an existing value is kept unless you pass `--admins`.
  The installer prints the result.
- **Which value to use**: the sign-in token the app receives carries the person's Entra **object id** but no e-mail
  address, so a sign-in name on its own never matches. Put the object id in the list as well. The Status page shows
  "You are signed in as ..." and the identities the app matched on; the object id is the GUID in it. You can also get it with
  `az ad user show --id a@contoso.com --query id -o tsv`.
- **Change it later**. The simplest way is the installer, which sets the secret and redeploys in one go:

  ```powershell
  node install.mjs --workspace <id> --skip-backend --lakehouse <id> --admins a@contoso.com,5640125b-aa74-4163-b232-703c9729f1c3
  ```

  To set the secret by hand, run this from the `app` folder with `RAYFIN_TOKEN` set as described under "Redeploy" above,
  then redeploy with the installer (without `--admins`, it keeps the value you set):

  ```powershell
  cd app
  "a@contoso.com,5640125b-aa74-4163-b232-703c9729f1c3" | npx rayfin secret set APP_ADMINS --stdin
  cd ..
  node install.mjs --workspace <id> --skip-backend --lakehouse <id>
  ```

## Choosing the AI model

The AI model is optional. It is used for AI drafts, the AI review and the Context interview; scoring and rule-based fixes
never call it. Three secrets control it, and the Status page shows the deployment in use.

| Secret | Meaning | Default |
|---|---|---|
| `AOAI_ENDPOINT` | `https://<resource>.openai.azure.com`, `.cognitiveservices.azure.com` or `.services.ai.azure.com`. It must be the resource that hosts the deployment | not set, so the AI features are off |
| `AOAI_DEPLOYMENT` | The name of the **deployment** (what you called it in Azure), not the model name | `gpt-4.1` |
| `AOAI_API_VERSION` | Azure OpenAI API version | `2024-10-21` |

Set them with the installer (`--aoai-endpoint`, `--aoai-deployment`, `--aoai-api-version`) or change a secret on its own
with `npx rayfin secret set <NAME> --stdin` in `app/` and redeploy. The app identity needs the "Cognitive Services
OpenAI User" role on the resource (see Troubleshooting).

- **Tested:** `gpt-4.1`.
- **Expected to work without changes, not tested:** other Azure OpenAI chat deployments that support JSON output, such
  as `gpt-4o` or `gpt-4.1-mini`. Smaller models write weaker descriptions, so read the proposals before you apply them.
- **Reasoning models (o3, o4-mini, GPT-5 family), not tested:** the client notices when the service rejects
  `max_tokens` or a custom `temperature`, switches to `max_completion_tokens`, drops the temperature and raises the
  output budget for hidden reasoning. You may also need a newer `AOAI_API_VERSION` such as `2025-04-01-preview`. They
  are slower, which makes the Context interview feel sluggish, so a chat model is the better choice there.
- **Not supported:** OpenAI.com or other providers, API keys (the app signs in with its own identity), and endpoints on
  other hosts. The host list is deliberate, because the app sends its Azure token to the endpoint you configure.

## Installer flags

Run `node install.mjs --help` for the full list. The ones that change behaviour:

| Flag | Effect |
|---|---|
| `--aoai-endpoint`, `--aoai-deployment`, `--aoai-api-version` | Set `AOAI_ENDPOINT`, `AOAI_DEPLOYMENT` and `AOAI_API_VERSION` (see [Choosing the AI model](#choosing-the-ai-model)). Pass the deployment again on a re-run if it is not `gpt-4.1` |
| `--admins a@x.com,b@y.com` | Set the optional `APP_ADMINS` override (sign-in names or object ids). Default: the Azure CLI account, name and object id. Without the flag an existing value is kept |
| `--adopt` | Take over an item that has a Fabric Weave name but no Fabric Weave marker and is not in the local record. Without it the installer stops and tells you which item. Check first that the item is yours, then it is overwritten and stamped |
| `--reset-schedule` | Replace the pipeline's schedule with the standard 02:00 UTC one. Without it an existing schedule is left alone; the installer says which it did. Creating or replacing a schedule makes **you** the pipeline owner |
| `--run-pipeline` / `--no-run-pipeline` | Force or skip the initial pipeline run. Default: run it only when no `portfolio.json` exists. `--skip-pipeline-run` is the same as `--no-run-pipeline` |
| `--non-interactive` | Never prompt. Anything that would need an answer stops with a message saying which flag to pass. Also the default when there is no terminal |
| `--skip-backend --lakehouse <id>` | Only redeploy the app. Needs the lakehouse id so `PORTFOLIO_PATH` can be set |
| `--app-only` | Install only the app, with no estate scan: no lakehouse, notebooks, pipeline or Portfolio page (see [Estate scan](#estate-scan-optional)). Cannot be combined with `--skip-backend`, `--lakehouse`, `--run-pipeline` or `--reset-schedule`. On an install that has the scan, it switches the Portfolio page off |
| `--rotate-signing-key` | New `SIGNING_KEY`. Snapshots saved earlier can no longer be restored |
| `--opt-out-telemetry` | Sets `RAYFIN_TELEMETRY_OPTOUT=1` for the Rayfin CLI the installer starts (see [PRIVACY.md](PRIVACY.md#rayfin-telemetry)) |
| `--prepare-only` | Only write `app/rayfin/rayfin.yml` from `rayfin.base.yml`. For a developer who runs `rayfin` commands in `app/` without the installer |
| `--config <file>` | Read the settings from a JSON file (`deployment/customer.config.example.json` lists them: tenant, workspace id or name, capacity, Azure OpenAI, admins, `appOnly`, ...). Flags on the command line win. A workspace given by name is found, or created on `capacityId` when it does not exist. The installer stops if the Azure CLI is in another tenant than `tenantId`. See [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md) |
| `--result <file>` | Write what was installed (workspace and app URLs, item ids, mode; no secrets) to a JSON file. Not written on a dry run |
| `--dry-run`, `--skip-preflight` | Print the steps; skip the preflight checks |
| teardown: `--include-unmarked` | Also delete items that have the expected name but no Fabric Weave marker and no local record. `--yes` does not imply it |

## Pipeline owner and hand-over

This section applies only if you installed the estate scan.

The pipeline `PL_AI_Readiness_Refresh` and its notebooks run as the user who last saved the schedule. That user needs
to be a Fabric administrator (or hold the admin-API tenant setting) for the scan to see the whole tenant. The same
person's identity also reads the shared code in the lakehouse `Files/config` folder, which is why workspace
membership is part of the trust model (see [SECURITY.md](../SECURITY.md)).

The installer creates the schedule only if there is none, so a routine re-run does not change the owner.
`--reset-schedule` does. Saving the schedule in the Fabric portal also changes the owner to whoever saves it.

Before a person who owns the pipeline leaves, or loses their admin role:

1. Another Fabric administrator who is also a member of the workspace opens the pipeline in the portal and saves the
   schedule again, or runs `node install.mjs --workspace <id> --skip-backend --lakehouse <id> --reset-schedule`.
2. Confirm the owner in the pipeline's schedule settings.
3. Run the pipeline once, or wait for the next scheduled run, and check that all three notebooks succeed and that
   Status shows a fresh run.

If the owner's account is disabled first, the nightly run starts failing; the steps above fix it.

## Failure alerts and the nightly run

- **In the app**: a banner appears when the last run failed or the data is older than 36 hours. The notebooks write
  the outcome to `Files/app/run_status.json`; the app reads it together with `portfolio.json`. There is no push
  notification from the app.
- **Paused capacity**: if the capacity is paused at 02:00 UTC, the scheduled run fails with `CapacityNotActive` before
  any notebook starts, so no notebook records a failure and the banner is the only sign. Keep the capacity running at
  that time or move the schedule into business hours (edit the schedule in the portal; see the owner note above).
- **Notifications** need a connection that the installer cannot create, so they are not automated. Two options:
  1. In the pipeline, add an Outlook or Teams activity on the failure path of the notebook activities. Create the
     connection to the mailbox or channel yourself. Re-running the installer overwrites the pipeline definition, so
     add the activity again afterwards (or keep a copy of your edited pipeline's JSON).
  2. Use Fabric Activator on pipeline job-failure events of the workspace and send an e-mail or Teams message.
- **Cost and size**: the capacity units the nightly scan uses grow with the number of semantic models and workspaces
  in scope. The tokens for an AI review or AI draft run vary with the size of the model; they are a few thousand per
  batch of objects. Start with a small workspace, watch the Fabric Capacity Metrics app and your Azure OpenAI usage,
  then widen the scope. There are no cost figures in this project because they depend on your capacity and models.

## Teardown

```powershell
node tools/teardown.mjs --workspace <workspace-guid> --dry-run     # show the plan, change nothing
node tools/teardown.mjs --workspace <workspace-guid>               # delete after typing the workspace name
node tools/teardown.mjs --workspace <workspace-guid> --keep-lakehouse --yes
```

It removes the Fabric Weave items it created: the app (and its database and function), the refresh pipeline, the three
notebooks and the `AIReadiness_LH` lakehouse (add `--keep-lakehouse` to keep the history). The SQL endpoint is deleted
together with its parent. **It only deletes items that carry the `Fabric Weave ... (managed)` marker in their
description or that are recorded in `app/rayfin/.fabric-weave.json`.** An item with the right name but neither is
listed as "not managed by Fabric Weave" and left alone, even with `--yes`; `--include-unmarked` deletes those too, after
you have checked the plan. Installs made before the marker existed are stamped the next time you run the installer. **It
never touches your semantic models, reports or any other item**, and it does not remove
the app identity's access to other workspaces, Azure OpenAI role assignments or capacity. Rollback snapshots live in the
app database, so tearing the app down deletes them: roll back anything you need first. The workspace stays; delete it
yourself if it was dedicated to Fabric Weave.

The delete calls use the Fabric items REST API. The plan and the dry run are verified against a real workspace; the
delete of the app, database and function items has not been exercised end to end yet, so check the final summary line and
the workspace item list afterwards. The command exits 1 if anything failed or is left behind.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Status: "Fabric and Power BI access" not ok | The app identity has no access to the workspace. Add it as Member or Contributor. |
| Status: Portfolio inventory "not there yet" | The pipeline has not produced `Files/app/portfolio.json`. Run it, check `scan_runs`. |
| In-place apply or rollback refused, "SIGNING_KEY" | The secret is missing or shorter than 32 characters. `npx rayfin secret set SIGNING_KEY --stdin`, then redeploy. |
| "Snapshot failed its integrity check" | The snapshot rows or the change set were edited, or the key was rotated. Nothing was written. Restore from Git or a backup. |
| A model shows `scanError` | The scanner returned no definition detail for it (for example a push dataset or a model you cannot read). Quick score is metadata only. |
| `UnknownError ... failed to export the dataset` on deep score | The service cannot export that model's definition (seen on some large or special models). Use the quick score, or fix the model in the service first. |
| Sign-in popup blocked | Allow pop-ups for the hosting URL. |
| "An internal execution error occured during function execution" | Older builds only. The Functions runtime replaced the message of any error that was not a `UserThrownError`. Every function now runs inside `guarded()` (`lib/guard.ts`), so the dialog shows the real reason, and each failure is also written to the audit trail as `function.error`. If you still see this text, redeploy the app. |
| "This workspace is not enabled for changes" although the Workspaces page shows in-place and in scope | Older builds only. The data client returned just the `id` column for `findFirst`, so the stored settings read as empty. Fixed by selecting the columns explicitly (see FINDINGS, "Rayfin data client"). If it still appears, redeploy, then confirm the row in `WorkspaceSettings` has `in_scope = 1` and the `write_mode` you expect. |
| Apply fails with "The service rejected the model definition: ... two columns with the IsKey property" | Older builds only. Marking the date table set `isKey` on the date column while another column (for example `date_key`) already had it. The model was not changed. Current builds never touch an existing key: they do not propose the date-table fix for such a table, and refuse any change set that would leave two keys. |
| Apply fails, or the Fix tab shows "This model cannot be changed yet": "points to the lakehouse ..., which does not exist or which this app cannot access" | A Direct Lake model reads from a lakehouse, and Fabric re-checks that lakehouse on every definition update. The model's source lakehouse was deleted, moved, or lives in a workspace the app identity cannot see (typical for a model copied from another workspace or tenant). The model was not changed and no snapshot was taken. Open the model in Fabric, choose Edit tables, and point it at an existing lakehouse, or grant the app identity access to that lakehouse. Propose-only mode keeps working in the meantime. |
| The date table is not marked after applying everything | The table already has a key column other than its date column. The app leaves that key alone, so the FND-004 finding is manual. To mark it, make the date column the key yourself in the model. |
| Apply says the change set could not be recorded | The model was written, but the database refused the change set row. The message includes the rollback snapshot id. The audit trail has a `model.apply` entry with `outcome = warning` and the same id. |
| Rayfin errors on a new Node version | Use Node 20 to 24. |
| Preflight `[FAIL]` Capacity: the capacity is paused or the workspace has none | Resume the capacity in the Azure portal (or the Fabric admin portal), or assign the workspace to an F2+ capacity, then re-run. |
| Preflight `[FAIL]` Workspace role | You need Admin or Member on the workspace (Contributor only gives a warning). Ask a workspace admin to add you. |
| Preflight `[WARN]` Fabric administrator | The install works, but the scanner and activity-event notebooks then see only what you can see, and the Agents tab shows tenant switches as "unknown". |
| `npm ci` or `npm install` fails to reach a private feed or `npm.pkg.github.com` | An old lockfile. Pull the latest: the committed `app/package-lock.json` points at `registry.npmjs.org`. A test in `tools/test` fails if a private host comes back. |
| `npm ci` fails with `EINTEGRITY` | The lockfile has a hash that public npm does not serve (it was copied from a private feed). Pull the latest, or run `node tools/verify-lockfile.mjs --fix` and commit the result. |
| Sign-in fails with a redirect URI error right after a manual `npx rayfin up` | The manual `up` replaced the redirect list. Run `node install.mjs --workspace <id> --skip-backend --lakehouse <id>`, or add the hosting URL under `allowedRedirectUris` in the generated `app/rayfin/rayfin.yml` and redeploy. |
| `rayfin up` says there is no `rayfin.yml` | It is generated and git-ignored. Run `node install.mjs --prepare-only` (or the installer) to write it from `rayfin.base.yml`. |
| The installer stops: "exists but was not created by Fabric Weave" | An item with a Fabric Weave name is in the workspace without the marker and without a local record. If it is yours (for example an install from another machine), copy `app/rayfin/.fabric-weave.json` and `.deployments.json` from that machine, or re-run with `--adopt` once you have checked. If it is not yours, rename or remove it, or use another workspace. |
| A user cannot see a model, apply, roll back or change a write mode | Fabric does not give them access or Write on that model, or the Admin role in that workspace. See [Who can see and change what](#who-can-see-and-change-what); their Status page says how access was worked out. |
| The banner says the last run failed or the data is old, and the pipeline shows `CapacityNotActive` | The capacity was paused at the scheduled time. Resume it and run the pipeline, then keep it running at 02:00 UTC or move the schedule. |
| The nightly run fails with an authorization error after someone left | The pipeline owner's account lost its admin role or was disabled. Follow the [hand-over procedure](#pipeline-owner-and-hand-over). |
| `rayfin up` says the project "already deploys to ..." and rejects `--item-name` | The workspace already has a recorded app item. Do not pass `--item-name`; the installer handles this for you. |
| AI review or AI drafts fail with "refused the request (401)" and the role "Cognitive Services OpenAI User" | The app identity lacks that role on the resource behind `AOAI_ENDPOINT`. Owner on the subscription does not include it. `az role assignment create --assignee <app identity> --role "Cognitive Services OpenAI User" --scope <resource id>`, wait a few minutes. Also check the endpoint: the role must be on the resource that hosts the deployment. |
| AI review fails with "deployment ... was not found" | `AOAI_ENDPOINT` points at a resource that has no deployment with the name in `AOAI_DEPLOYMENT`. List them with `az cognitiveservices account deployment list -g <rg> -n <resource>`, then `npx rayfin secret set AOAI_ENDPOINT --stdin` (and `AOAI_DEPLOYMENT`) and redeploy. |
| AI review or AI drafts fail with "rejected the request (400)" and mention `AOAI_API_VERSION` | The deployment is a newer or reasoning model that the default API version does not know. Set `AOAI_API_VERSION` to a newer version (for example `2025-04-01-preview`) and redeploy, or point `AOAI_DEPLOYMENT` at a chat deployment such as `gpt-4.1`. See [Choosing the AI model](#choosing-the-ai-model). |
| Context tab: "Start the interview" is disabled | The interview needs the AI model (same `AOAI_*` secrets as AI drafts). Check the Status page. Writing the context yourself works without it. |
| Context tab: the microphone or Voice conversation does not work | Dictation uses the browser's speech recognition: use Chrome or Edge, allow the microphone for the app URL, and check the network (the audio is recognised by the browser vendor's service). Firefox has no speech recognition, so the buttons are hidden there. Typing always works. |
| Context tab: the browser never asks for microphone access, and the app says Fabric's frame blocks it | Inside the Fabric portal the app runs in an iframe. A browser only lets a frame use the microphone when the page around it grants it, and the portal does not, so the browser refuses silently and shows no prompt. Use the **Open Fabric Weave in its own tab** link (or open the app's hosting URL directly). In its own tab the browser asks for the microphone as usual. You will sign in once more there. |
| Context tab: "Start the interview" takes a long time before the first question | The app reads the model definition from Fabric first (Fabric needs about 10 seconds to export it), then the AI model writes the question (about 5 seconds), so a first question takes about 15 seconds. The read is kept for 5 minutes per model, so later questions, and a visit to the Overview or the Fix workbench just before, take about 5 seconds. A cold Function instance has no cached read and pays the cost again. If it stays above 40 seconds, check the Azure OpenAI deployment's latency and quota on the Status page. |
| Context saved, but an AI draft does not mention it | Save the Context tab first (the Save button is active while there are unsaved edits), then draft again. The Fix tab shows "Drafted from your business context" when it was used. |
| Context tab says "Saved as separate fields before" | The model has a context saved by an older build (domain, audience, glossary, fiscal year...). The tab shows it as text. Press Save once to keep it in the new format. |
