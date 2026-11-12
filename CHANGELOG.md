# Changelog

All notable changes to Fabric Weave. Versions follow [Semantic Versioning](https://semver.org/). The release workflow
checks that the top heading of this file matches the tag and the `version:` in `app/rayfin/rayfin.base.yml`.

## 1.0.1

- Publish the customer-safe source and download instructions on GitHub, without deployment credentials,
  tenant-specific configuration or dependencies.
- Build release ZIPs with the existing verified package builder, including provenance metadata and SHA-256.
- Make the timeout test model pending network I/O so Node 22 does not cancel it when its event loop becomes idle.
  No installer or app runtime behaviour changes.

## 1.0.0

First public release. A complete version plus the hardening done for customer installs.

### Features
- **Deployable package**: `deployment\Build-Package.ps1` builds `fabric-weave-<version>.zip` (and, with
  `-IncludeOfflineCache`, an offline variant that bundles the npm packages for one platform) with a SHA256 file.
  The receiver fills in `deployment\customer.config.json` and runs `deployment\Deploy.ps1`, which checks the tools,
  signs in to the right tenant, finds or creates the workspace and runs the installer. New installer flags
  `--config <file>` (settings from JSON; flags still win) and `--result <file>` (a summary of what was installed).
  See `docs/DEPLOYMENT-GUIDE.md`. The workspace-create path has been tested against a fake client only.
- **Overview deck**: `docs/Fabric-Weave-Overview.pptx` is an 18-slide deck (speaker notes on every slide) on how Fabric
  Weave works and the value it brings. Slide 2 is a one-page executive summary (diagram, how it works, value) for
  C-level audiences. It replaces the earlier deck, which described the pre-1.0 product. Charts and mock-ups are
  labelled "Illustrative"; the 22.7 to 85.3 result is from the Sloppy Sales demo model.
- **Optional estate scan**: `node install.mjs --app-only` installs only the app, with no lakehouse, notebooks or
  nightly pipeline. The Portfolio page is then hidden (the app opens on Models, and the Status page shows the scan as
  optional and not installed), and you lose usage and adoption numbers, quick scores for models nobody opened, and the
  inventory of workspaces the app identity is not a member of. Inspecting, scoring and fixing the models a person can
  reach works the same. The default install is unchanged. On an existing full install `--app-only` sets `PORTFOLIO_PATH`
  to `disabled` and deletes nothing. See "Estate scan (optional)" in `docs/RUNBOOK.md`.
- Inventory of every semantic model, quick and deep AI-readiness scores (28 rules, 7 categories, hard gates),
  rule-based and AI-drafted fixes with a live score, in-place, propose-only and clone write modes with signed rollback
  snapshots, business context (typed, dictated or interviewed), Agents tab, audit log, one-command installer.
- **Configurable AI model**: `AOAI_ENDPOINT`, `AOAI_DEPLOYMENT` and the new optional `AOAI_API_VERSION` secret
  (installer flags `--aoai-endpoint`, `--aoai-deployment`, `--aoai-api-version`). The client adapts to reasoning models
  that reject `max_tokens` or a custom `temperature`, and the error messages say which secret to change. See
  "Choosing the AI model" in `docs/RUNBOOK.md`. Only `gpt-4.1` has been tested against a live deployment.
- **No synonyms**: the Q&A visual they serve is being deprecated, so synonyms no longer count. Rule catalog 1.2.0 drops
  the two synonym rules (SCH-002 and SCH-003; 28 rules left) and the schema category is now "AI data schema" (weight
  still 15). A synonym no longer excuses a technical, abbreviated or duplicate name (NAM-001 to NAM-004), and those
  findings are now manual: rename in the model source (Power BI Desktop or TMDL) and update your reports. The Fix
  workbench no longer proposes or edits synonyms, the starter-measure proposal no longer adds them, the generated AI
  instructions no longer write alias lines, and the Schema tab no longer shows them. The API rejects a `setSynonyms`
  change. Synonyms already in a model's AI data schema are kept when Fabric Weave writes to it. The Sloppy Sales demo
  now goes from 22.7 to 85.3 instead of 21.3 to 97.2, because its cryptic names can no longer be "fixed" with
  synonyms.
- **Portfolio tab no longer flashes**: in an app-only install the Portfolio tab used to show for a moment before the
  app learned the estate scan was not installed. The tab now appears only once the service status says it is on.
  The cost: in a full install the tab pops in when the status loads, instead of being there from the start.
- **Descriptions for hidden objects**: the "Describe tables / columns / measures" proposals now also write descriptions
  for hidden tables, columns and measures (and for the columns of hidden tables) that have none, so a model is
  documented end to end for the people who maintain it. The score is unchanged: only what Copilot can see is scored.
  The tables Power BI generates for auto date/time (`LocalDateTable_*`, `DateTableTemplate_*`) are left alone.

### Security and access
- **Per-person access**: every signed-in person is checked against their own Fabric permissions before the app does
  anything as the app owner. They see only the workspaces and models Fabric says they can reach, can apply fixes, roll
  back and approve for Copilot only where Fabric gives them Write (checked fresh at the moment of the change), and can
  change a workspace's write mode only as its Admin. The app owner should be a Fabric administrator so group-based and
  shared access is visible; otherwise only direct workspace roles are read. It is a check inside the app, not Fabric
  enforcement (Rayfin gives the Functions no per-user Fabric token). The Status page shows how your access was worked out.
- **`APP_ADMINS` is an optional override** (sign-in names or Entra object ids): those people see and change everything.
  The installer defaults it to the Azure CLI account, name and object id (`--admins` overrides it), keeps an existing
  value on re-runs and prints it. Refused attempts are written to the audit log.
- **Sign-in identity fix**: the app's token carries the Entra object id (in Rayfin's `.../users/<object id>` subject) but no
  e-mail, so an `APP_ADMINS` list of sign-in names alone never matched anyone. The object id is now used.
- **Write safety**: optimistic concurrency on writes, so a change made in the meantime is not overwritten, and signed
  workspace write modes next to the signed rollback snapshots. A workspace that was set to in-place or clone before
  1.0 shows "unverified" (propose-only) until an administrator saves its write mode again.
- The audit log is described as best-effort evidence, not a tamper-proof ledger, in every document.
- New `SECURITY.md` with the trust model and how to report a vulnerability, `docs/PRIVACY.md` (data flow, what goes to
  Azure OpenAI, retention, Rayfin telemetry and how to remove the data), `docs/LIMITATIONS.md`, `docs/UPGRADING.md`
  and `THIRD_PARTY_NOTICES.md`. The installer has `--opt-out-telemetry` for the Rayfin CLI telemetry.

### Reliability
- **Fail-loud notebooks and a last-scanned banner**: a failed step fails the run, the outcome is recorded in
  `Files/app/run_status.json`, and the app shows a warning when the last run failed or the data is older than 36 hours.
  `docs/RUNBOOK.md` describes failure alerts and the paused-capacity case.
- **Placeholder-resistant scoring**: placeholder names and descriptions no longer count as real documentation.
- Context interview: the first question took up to a minute. Fabric tells clients to wait 20 seconds before checking
  a long-running operation, but a model export finishes in about 10. The Fabric client now polls quickly (every 1 to 2 s)
  (`lroPollMs`), the interview asks the model for one short question per turn and writes the summary only at the end,
  and the model read is kept in memory for 5 minutes per model (cleared whenever Fabric Weave writes to that model).
- Context tab: inside the Fabric portal the browser never prompts for the microphone because the portal's iframe does
  not grant it. The app now says so, links to **Open Fabric Weave in its own tab**, and keeps typing available.

### Installer and tools
- Re-running the installer keeps an existing `SIGNING_KEY` and `APP_ADMINS`: it reads the secret names with
  `rayfin --json secret list` (a non-interactive `secret list` prints nothing) and refuses to continue if it cannot.
  The app URL is read from Rayfin's deployment registry, because `rayfin up` prints no URL without a terminal.
- **Cross-platform installer**: `backend/deploy.mjs` no longer needs Windows (`az.cmd`) and reuses the portable Azure
  CLI token code. Tokens are refreshed by expiry, every request has a timeout, and waiting for a Fabric job has a
  timeout (30 minutes, `FABRIC_WEAVE_JOB_TIMEOUT_MINUTES`).
- **Item stamping**: the items the installer creates carry a `Fabric Weave v<version> (managed)` marker in their
  description and are recorded in `app/rayfin/.fabric-weave.json`. An existing item with the expected name but no
  marker is not adopted unless you pass `--adopt`. Teardown deletes only marked or recorded items unless you pass
  `--include-unmarked`; `--yes` does not bypass that.
- The nightly schedule is created only when the pipeline has none (`--reset-schedule` replaces it), so a re-run no
  longer changes the schedule owner. The initial pipeline run happens only when no `portfolio.json` exists
  (`--run-pipeline` / `--no-run-pipeline`). "Every step is idempotent" is replaced by an honest description of what is
  skipped and what is overwritten.
- `npm ci` replaces `npm install` and runs when `node_modules` is missing or `app/package-lock.json` changed.
  The installer prints "upgrading from vX to vY". New flags: `--admins`, `--adopt`, `--reset-schedule`,
  `--run-pipeline`, `--no-run-pipeline`, `--non-interactive`, `--opt-out-telemetry`, `--prepare-only`.
- **One identity model**: the notebooks and pipeline run as the user who last saved the schedule, who must be a Fabric
  administrator. A service principal is documented as an advanced alternative that is not automated.
- `tools/preflight.mjs`: read-only check of Node and npm (warns that Node 20 is end of life), Azure CLI sign-in,
  workspace access, capacity (F2+ / P1+ / trial, running), your workspace role, Fabric admin rights, workspace
  contents including look-alike items that Fabric Weave did not create, the recorded deployment, the app
  administrators and the Azure OpenAI endpoint. The installer runs it first (`--skip-preflight` turns it off).
- `tools/teardown.mjs`: removes the app, pipeline, notebooks and lakehouse from a workspace. Supports `--dry-run`,
  `--yes`, `--keep-lakehouse` and `--include-unmarked`, asks you to type the workspace name, and never touches your own
  items or the workspace.
- **Generated `rayfin.yml`**: `app/rayfin/rayfin.base.yml` is the tracked configuration. The installer generates the
  git-ignored `app/rayfin/rayfin.yml` from it plus the hosting URL of your deployment, so installing no longer
  modifies a tracked file. `node install.mjs --prepare-only` writes it without installing.
- The installer rejects unknown or incomplete flags instead of ignoring them.

### Packaging and CI
- Root `LICENSE` (MIT), `CONTRIBUTING.md`, issue and pull request templates, `CODEOWNERS`, a dev container (untested).
- `.gitattributes` keeps the Rayfin scaffold-only folders (`app/.agents`, scaffold scripts) and test fixtures that the
  installer does not need out of the release archive.
- GitHub Actions: `ci.yml` (typecheck, lint, tests, build, Python tests, `npm audit` for production dependencies with a
  reviewed allowlist in `tools/audit-allowlist.json`, rule-catalog drift guard, tools tests on Linux, Windows and
  macOS, installer dry runs) and `release.yml` (runs CI, checks the tag against the version and this file, builds
  `fabric-weave-<version>.zip`, checks the archive contents and that the installer starts from it, and attaches
  `SHA256SUMS.txt`). `codeql.yml` scans JavaScript and TypeScript. Actions are pinned to commit SHAs; Dependabot
  updates npm and Actions weekly. None of the workflows has run on GitHub yet.
- `app/package-lock.json` resolves every package from the public npm registry. It used to point at a private feed and
  GitHub Packages, so `npm ci` failed outside the original machine. A test guards against it coming back.
- 16 `@microsoft/rayfin-*` and `@microsoft/fabric-*` entries in the lockfile carried the integrity of the GitHub
  Packages tarballs. Public npm serves the same files with different bytes, so a fresh `npm ci` (empty cache) failed with
  `EINTEGRITY` for everyone; it only worked on machines with a warm cache. They now carry the public integrity (all 756
  entries checked). `node tools/verify-lockfile.mjs` repeats that check against the public registry; run it after
  every Rayfin version bump.
- The Rayfin project id is `fabric-weave`. Installs that already exist keep their recorded item name
  (`ai-readiness-cockpit`) and data: Rayfin finds the existing deployment by workspace id. New installs create an app
  item named "Fabric Weave". If the workspace already holds the app, the installer updates it instead of creating a
  second one.
- Unit tests for the packaging tools (`node --test "tools/test/*.test.mjs"`).

### Removed
- The "Captured so far" block under the interview question.
