# Fabric Weave

> Fabric Weave is a community accelerator, not an official Microsoft product, provided as-is under the MIT licence.
> It is not supported by Microsoft. Read [SECURITY.md](SECURITY.md), [docs/PRIVACY.md](docs/PRIVACY.md) and
> [docs/LIMITATIONS.md](docs/LIMITATIONS.md) before you install it in a tenant that matters.

An accelerator that turns a customer's Power BI semantic model estate into something Copilot and AI agents can
actually use. It is a Fabric app (built with Rayfin) plus a small Fabric backend, deployed as a solution into one
Fabric workspace.

Copilot chat over semantic models only works as well as the models are prepared. Most models have no descriptions,
no AI instructions, technical names and no scope. Fabric Weave finds those gaps across the whole
estate, scores every model, fixes what it can (rule-based or AI-drafted, always reviewable), re-scores, and checks
that the tenant, capacity and model settings let AI agents reach the model at all.

## Download and install in your own tenant

Download `fabric-weave-1.0.0.zip` and `SHA256SUMS.txt` from the
[latest release](https://github.com/StevenVDP89/fabric-weave/releases/latest), verify the ZIP's SHA-256 with
`Get-FileHash`, and extract it to a short path such as `C:\fabric-weave`. Prefer the versioned release asset
over GitHub's automatically generated source ZIP.

You need Node.js **22 or 24**, the Azure CLI, and a running **Fabric F2+ capacity** with permission to administer
the target workspace or create one. Read the [deployment guide](docs/DEPLOYMENT-GUIDE.md) before installing.

```powershell
Copy-Item .\deployment\customer.config.example.json .\deployment\customer.config.json
# Edit customer.config.json: set your tenant and workspace; set capacityId only to create a workspace.
.\deployment\Deploy.ps1 -DryRun
.\deployment\Deploy.ps1
```

The package contains no preconfigured customer tenant or credentials. The script signs you in to the tenant
you select. The example defaults to **app-only**, without a tenant-wide scan or nightly jobs; set `appOnly: false`
to include those. Capacity use and optional AI calls incur charges under your own subscriptions.

**AI is an independent option, including for app-only installs.** To enable AI drafts, review and the context
interview, set `aoaiEndpoint` and the exact `aoaiDeployment` name for your own Azure OpenAI resource.
Newer models may require `aoaiApiVersion`; see [Choosing the AI model](docs/RUNBOOK.md#choosing-the-ai-model).
Grant the app identity **Cognitive Services OpenAI User** on that resource. No API key is needed.

After installing, open the app, allow sign-in pop-ups, and check **Status**. Start with propose-only or clone mode
in a test workspace. Keep `customer.config.json`, generated environment files and deployment records private.
This release retains pre-release Rayfin dependencies; review the [known limits](docs/LIMITATIONS.md) and
[third-party terms](THIRD_PARTY_NOTICES.md) before using it in production.

## What you get

| Capability | Where |
|---|---|
| 360° inventory of every semantic model: owner, storage mode, refresh, tables, measures, reports, views, unique users, last activity (with the optional [estate scan](docs/RUNBOOK.md#estate-scan-optional)) | Portfolio page |
| Quick AI-readiness score for every model, from scanner metadata only (cheap, runs daily; estate scan) | Portfolio page |
| Deep score for one model from its full definition: 28 rules in 7 weighted categories, hard gates, tiers | Model page, Overview tab |
| Fix proposals, rule-based and AI-drafted: descriptions, hiding technical keys, format strings, added measures, Q&A on, value indexing, AI instructions, example prompts. Each shows a diff and an estimated score gain; the score on the page rises live as you select them. Technical or abbreviated names are flagged for you to rename in the model source (Power BI Desktop or TMDL); Fabric Weave does not rename | Model page, Fix workbench tab |
| Write modes per workspace: **in-place** (snapshot + rollback), **propose-only** (no writes), **AI-ready clone** | Workspaces page |
| Business context for the model: write it yourself (or dictate it), or let an AI agent interview you about the model, by typing or by voice. It grounds the AI instructions, descriptions and example prompts | Model page, Context tab |
| Schema scoping for the Prep-data-for-AI settings: which tables, columns and measures AI can see | Model page, Schema tab |
| "Is this model available to AI agents?" checks across tenant, capacity, model: Copilot, Power BI MCP, Fabric data agent | Model page, Agents tab |
| Audit log of applies, rollbacks and refusals (best-effort evidence, not tamper-proof), signed rollback snapshots | Status page, `AuditLog` |

Scoring: Model foundation 25, Descriptions 20, Business-friendly naming 15, AI instructions 15, AI data schema 15,
Example prompts 5, Enablement and governance 5. Tiers: Not ready (<40), Needs work (40-64),
Almost ready (65-84), AI-ready (85+). Three gates cap the score regardless of the rest: no explicit measures (40),
Q&A off (50), workspace not on a Copilot-eligible capacity (30). The rule catalog is `backend/catalog/rule-catalog.json`
and is shared by the app and the notebooks, so both score the same way.

## Architecture

```
                     daily 02:00 UTC
   ┌─────────────────────────────────────────────────────────┐
   │ Fabric workspace (for example "Fabric Weave")           │
   │                                                         │
   │  PL_AI_Readiness_Refresh (pipeline)                     │
   │    NB_01_Scan_Inventory  Admin Scanner API ─┐           │
   │    NB_02_Usage           Activity events ───┼─► Lakehouse AIReadiness_LH
   │    NB_03_Quick_Score     rule catalog ──────┘     Tables: model_inventory, model_scan_detail,
   │                                                   model_usage, model_quick_score, scan_runs,
   │                                                   scanner_coverage
   │                                                   Files/app/portfolio.json
   │                                                         │
   │  Rayfin app (AppBackend item)                           │ read (app identity, Storage token)
   │    React UI ◄─► 13 Functions ◄──────────────────────────┘
   │                   │  deep score, fixes, apply, rollback
   │                   ├─► Fabric / Power BI REST (getDefinition / updateDefinition)
   │                   ├─► Azure OpenAI (AI drafts and review: names, descriptions, DAX, never row data)
   │                   └─► SQL database: settings, assessments, change sets,
   │                                      snapshot chunks, audit log
   └─────────────────────────────────────────────────────────┘
```

The portfolio is read from a file the pipeline writes, so opening the app is instant and does not hit the admin
APIs. A deep score and every fix go straight to the model through the Fabric REST API. The pipeline, notebooks and
lakehouse (the **estate scan**) are optional: install with `--app-only` and the Portfolio page is not shown, while
everything else works the same. See [Estate scan](docs/RUNBOOK.md#estate-scan-optional).

## Repository layout

```
install.mjs                 One-command installer (preflight, backend, app, secrets)
backend/                    Fabric backend: notebooks, pipeline, rule catalog, deploy.mjs
app/                        Rayfin app (npm workspaces)
  rayfin/rayfin.base.yml    App configuration (tracked). The installer generates the git-ignored rayfin.yml from it
  packages/engine           Scoring, TMDL parser/patcher, fix proposals, LLM and Fabric clients (pure TypeScript)
  packages/functions        The 13 Rayfin Functions and their libs (apply, rollback, signing, portfolio)
  packages/data             Entities for the app database
  packages/shared           Types shared by data and functions
  packages/frontend         React UI (Fabric green, grey and orange theme; ribbon artwork in src/assets)
  scripts/                 validate-functions.mjs checks the Functions contract during builds.
                            Developer-only Rayfin agent scaffold is omitted from this public snapshot.
tools/preflight.mjs         Read-only pre-install checks (also run by install.mjs)
tools/teardown.mjs          Remove a deployment from a workspace (--dry-run first, asks before deleting)
tools/lib/                  Shared helpers for the installer, preflight and teardown
tools/audit-check.mjs       CI helper: npm audit result against the reviewed allowlist (tools/audit-allowlist.json)
tools/test/                 Unit tests for those tools (node --test)
tools/cli.mjs               Run the engine live against your tenant (deploy-sample, score, fix [--apply] [--refresh])
tools/live-check.mjs        Call the deployed Functions (needs an Item.Execute.All token, see docs/RUNBOOK.md)
docs/                       RUNBOOK, UPGRADING, PRIVACY, LIMITATIONS, SECURITY, DEMO, FINDINGS, overview deck (Fabric-Weave-Overview.pptx)
.github/                    CI (tests on Linux, Windows and macOS, audit, drift guard), release packaging, Dependabot, issue and PR templates
.devcontainer/              Codespaces / dev container definition (untested)
SECURITY.md, THIRD_PARTY_NOTICES.md, LICENSE, CHANGELOG.md, CONTRIBUTING.md
```

## Deploy in minutes

You need an empty Fabric workspace on an F2+ capacity, Node 20 to 24, and the Azure CLI signed in (`az login`) as a
Fabric administrator (or workspace admin; see [prerequisites](#install)).

```powershell
git clone https://github.com/StevenVDP89/fabric-weave.git      # or unpack the release zip
cd fabric-weave
az login
node install.mjs --workspace <workspace-guid> --aoai-endpoint https://<resource>.openai.azure.com --admins you@contoso.com
```

That is the whole install. The first pipeline run alone takes about 8 to 10 minutes. Open the app URL it prints and
check the **Status** page. Leave out `--admins` to make the Azure CLI account an app administrator (it sees and changes
everything); everyone else is checked against their own Fabric permissions. Add `--app-only` to skip the lakehouse,
notebooks and nightly pipeline: you then have no Portfolio page and no usage numbers, but people still inspect, score and
fix the models they can reach, and the install is quicker and cheaper ([Estate scan](docs/RUNBOOK.md#estate-scan-optional)).

- **Codespaces / dev container**: `.devcontainer/` has Node 22, the Azure CLI and Python. Open the repository in a
  Codespace, run `az login --use-device-code` in its terminal, then the commands above. **Not tested.**
- **Azure Cloud Shell**: **not tested.** It would need Node 20 to 24 and `az` already signed in as above. The installer
  uses only Node and the Azure CLI.

## Install

Prerequisites: Node 20 to 24 (Node 20 is end of life), Azure CLI signed in (`az login`) as a Fabric admin or an admin of
the target workspace, an empty Fabric workspace on an F2+ capacity, and a decision on who the app administrators are:
the sign-in names or object ids in the optional `APP_ADMINS` secret (`--admins a@contoso.com,b@contoso.com`; default is
the Azure CLI account) see and change everything, and everyone else sees and changes only what Fabric lets them. Make the
app owner a Fabric administrator so the app can see group-based access. If you install the estate scan, its pipeline and
notebooks run as the user who last saved the schedule, who must be a Fabric administrator
([docs/RUNBOOK.md](docs/RUNBOOK.md#pipeline-owner-and-hand-over)).

```powershell
# 1. Optional but recommended: read-only check that nothing will block the install
node tools/preflight.mjs --workspace <workspace-guid> --aoai-endpoint https://<resource>.openai.azure.com

# 2. Install (runs the same preflight first and stops on a failure)
node install.mjs --workspace <workspace-guid> `
  --aoai-endpoint https://<resource>.openai.azure.com --aoai-deployment gpt-4.1 `
  --admins you@contoso.com
```

The preflight checks the Node and npm versions, the Azure CLI sign-in, the workspace, its capacity (paused or too
small), your role, whether you are a Fabric administrator, what is already in the workspace, the app administrators
and the Azure OpenAI endpoint. The installer deploys the Lakehouse, notebooks, pipeline and schedule (unless `--app-only`), runs the pipeline
once if there is no portfolio yet, writes `app/rayfin/rayfin.yml` from `rayfin.base.yml`, deploys the app, sets the
secrets (`SIGNING_KEY`, `APP_ADMINS`, ...), prints the administrators it set and the manual steps that cannot be
scripted. Details and troubleshooting are in [docs/RUNBOOK.md](docs/RUNBOOK.md). Leave out `--aoai-endpoint` and
Fabric Weave still scores and applies rule-based fixes; only AI drafts and the AI review are switched off. To use a
different model, pass its deployment name with `--aoai-deployment` (and `--aoai-api-version` for newer models); see
[Choosing the AI model](docs/RUNBOOK.md#choosing-the-ai-model).

Other flags: `--app-only`, `--adopt`, `--reset-schedule`, `--run-pipeline` / `--no-run-pipeline`, `--non-interactive`,
`--rotate-signing-key`, `--opt-out-telemetry` (Rayfin CLI telemetry, see [docs/PRIVACY.md](docs/PRIVACY.md#rayfin-telemetry)),
`--prepare-only`, `--dry-run`, `--config <file>` and `--result <file>` (settings from a JSON file, summary written to
one). `node install.mjs --help` lists them all.

Re-running the installer is how you upgrade. It is safe, but not a no-op: the notebooks and the pipeline definition
are overwritten, while the secrets, schedule, lakehouse data and app database are kept
([docs/UPGRADING.md](docs/UPGRADING.md)). Items the installer did not create are never adopted or deleted unless you
say so (`--adopt`, `--include-unmarked`).

**Sharing it with customers and colleagues.** Release ZIPs (and `deployment\Build-Package.ps1`, which also builds an
offline variant that bundles the npm packages) hold a settings file and a Windows script: fill in
`deployment\customer.config.json` (tenant, workspace by id or name, capacity to create it on, optional Azure OpenAI,
`appOnly`) and run `.\deployment\Deploy.ps1`. It checks Node and the Azure CLI, signs in to the right tenant, finds or
creates the workspace and runs `node install.mjs --config ...`. On macOS or Linux run
`node install.mjs --config deployment/customer.config.json`. See [docs/DEPLOYMENT-GUIDE.md](docs/DEPLOYMENT-GUIDE.md).

To remove a deployment again: `node tools/teardown.mjs --workspace <guid> --dry-run` shows what would be deleted
and what is kept (your semantic models are never touched); drop `--dry-run` to delete after a confirmation.

Upgrading from the earlier "ai-readiness-cockpit" name works: an existing install keeps its app item and data,
`install.mjs` finds it again from the local deployment record or by name, and stamps the items on the first re-run.

## Develop and validate

```powershell
node install.mjs --prepare-only     # writes app/rayfin/rayfin.yml from rayfin.base.yml (git-ignored), needed before any rayfin command in app/
cd app
npm ci
npm run typecheck        # shared, engine, functions, then tsc -b
npm run build
npm run lint
npm test                 # frontend (vitest)
npm test -w @rayfin-app/functions   # signing and part-path tests
npm test -w @rayfin-app/engine      # scoring, patching, apply round trips
cd ..
node --test "tools/test/*.test.mjs" # installer, preflight, teardown and lockfile guard
```

Edit app configuration in `app/rayfin/rayfin.base.yml`, never in the generated `rayfin.yml`. `app/.agents` and
the scaffold scripts in `app/scripts` exist only for developers who extend the app with coding agents; they are not
part of the release zip.

CI (`.github/workflows/ci.yml`) runs all of this on every push and pull request (tools tests on Linux, Windows and
macOS), plus the Python tests, `npm audit` for production dependencies (with a reviewed allowlist in
`tools/audit-allowlist.json`), a rule-catalog drift check and installer dry runs. Pushing a `v*` tag runs CI again and
then builds `fabric-weave-<version>.zip` with a `SHA256SUMS.txt` and attaches both to a GitHub release. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).
Licensed under [MIT](LICENSE); third-party and scaffold notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Security in one paragraph

The app calls Fabric as its own identity (the app owner's), because Rayfin gives the Functions no token for the person
using the app. So the app asks Fabric what each person may do and refuses the rest: you see only the workspaces and
models you can reach, you can apply fixes, roll back and approve for Copilot only on models where Fabric gives you Write,
and you can change a workspace's write mode only if you are its Admin. This is a check inside the app, not Fabric
enforcement; the people in the optional `APP_ADMINS` secret see and change everything. In-place changes
and rollback are refused unless a signing key is set; snapshots and workspace write modes are HMAC-signed, and only
model definition parts can be restored. The audit log is best-effort evidence, not a tamper-proof ledger, because the
app database is reachable with the caller's own identity. AI drafts are never applied without review and only names,
descriptions, DAX and your business-context text are sent to Azure OpenAI, never row data. If you install the estate scan,
its notebooks run as the pipeline owner, so keep the workspace membership small. See [SECURITY.md](SECURITY.md), [docs/SECURITY.md](docs/SECURITY.md)
and [docs/PRIVACY.md](docs/PRIVACY.md).

## More documentation

[docs/RUNBOOK.md](docs/RUNBOOK.md) (install, operate, troubleshoot) ·
[docs/UPGRADING.md](docs/UPGRADING.md) ·
[SECURITY.md](SECURITY.md) ·
[docs/PRIVACY.md](docs/PRIVACY.md) ·
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) ·
[docs/FINDINGS.md](docs/FINDINGS.md)

## Status of this build

Built and validated against a real tenant: scoring, fix, apply and rollback (engine, live CLI), the backend
pipeline end to end, the deployed app's build, database and hosting. The deployed Functions require an interactive
Entra sign-in with the `Item.Execute.All` scope, so the click-through check is a manual step
([docs/RUNBOOK.md](docs/RUNBOOK.md#verify-the-install)). Findings from the spikes are in [docs/FINDINGS.md](docs/FINDINGS.md).
