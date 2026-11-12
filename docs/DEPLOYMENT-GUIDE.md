# Deployment guide: sharing and installing Fabric Weave from a package

This guide is for two people:

- **The receiver** (a customer or colleague) who gets a ZIP file and installs Fabric Weave into their own Fabric
  workspace. Sections 2 to 5.
- **The delivery team** who builds and shares that ZIP. Section 6.

The package is the same code as the public repository plus a settings file and a Windows wrapper script. Nothing is
installed on your machine except what the installer needs (npm packages inside the package folder). Everything else is
created in the Fabric workspace you name.

## 1. Overview and what is in the package

Fabric Weave scores Power BI semantic models for AI-readiness and fixes them for Copilot. It runs as a Rayfin app in a
Fabric workspace. One command, `install.mjs`, creates the app and (optionally) the estate scan. The package wraps that
command so a person only edits one settings file and runs one script.

```
fabric-weave-<version>/
  deployment/
    Deploy.ps1                       the script you run (Windows PowerShell 5.1 or PowerShell 7)
    customer.config.example.json     copy to customer.config.json and fill in
    Build-Package.ps1                rebuilds this ZIP (delivery team only)
    package-info.json                version, commit, build time, offline cache details
    last-deployment-result.json      written by Deploy.ps1 after a successful install (ids and URLs, no secrets)
  install.mjs                        the installer Deploy.ps1 calls (also runs on macOS and Linux)
  app/                               the Rayfin app (frontend, Functions, engine) and package-lock.json
  backend/                           notebooks, pipeline and deployer for the optional estate scan
  tools/                             preflight, teardown and helper libraries
  docs/                              RUNBOOK, SECURITY, UPGRADING, LIMITATIONS, PRIVACY and this guide
  offline-cache/npm-cache/           only in the "-offline" ZIP: the npm packages the install needs
  LICENSE, THIRD_PARTY_NOTICES.md
```

Two ZIPs can exist:

| File | Size | When to use |
|---|---|---|
| `fabric-weave-<version>.zip` | a few MB | The machine can reach `registry.npmjs.org`. The usual choice. |
| `fabric-weave-<version>-offline.zip` | about 100 to 200 MB | The machine cannot reach the npm registry (proxy or firewall). It carries the npm packages for **one platform** (shown in `deployment\package-info.json`, for example `win32-x64`). |

"Offline" covers the npm registry only. The installer still talks to Microsoft Entra ID and Fabric (see 2.1), so this
is not an air-gapped install.

## 2. Prerequisites

### 2.1 The deployment machine

| Need | Detail |
|---|---|
| Windows 10 or 11, or Windows Server 2019+ | `Deploy.ps1` runs on Windows PowerShell 5.1 and PowerShell 7. On macOS or Linux run `node install.mjs` yourself (step 3, option B). |
| Node.js 20, 22 or 24 (LTS) | Rayfin does not support newer versions yet. `npm` ships with Node. Download from <https://nodejs.org>. |
| Azure CLI (`az`) | <https://aka.ms/installazurecliwindows>. It cannot be bundled in the package. `Deploy.ps1` signs in for you if needed. |
| Disk space | About 1 GB free for `node_modules` and the build output. |
| A short folder path | Unzip close to the drive root, for example `C:\fabric-weave`. `node_modules` goes deep and Windows stops at 260 characters. |
| Outbound HTTPS | `login.microsoftonline.com`, `api.fabric.microsoft.com`, `api.powerbi.com`, `onelake.dfs.fabric.microsoft.com`, `*.fabricapps.net` (the hosted app), and your Azure OpenAI endpoint if you use AI. Also `registry.npmjs.org` unless you use the offline ZIP. Behind a proxy, set `HTTPS_PROXY` before running the script. |

You do **not** need Python, the `fab` CLI, Git or Docker.

### 2.2 The Fabric tenant and capacity

| Need | Detail |
|---|---|
| A Fabric capacity, F2 or larger, running | The app and the workspace need it. A paused capacity fails the preflight. |
| A workspace on that capacity, or permission to create one | Either give an existing workspace (`workspaceId` or `workspaceName`), or give `capacityId` and the script creates the workspace. Creating needs the tenant setting that lets you create workspaces. |
| You are **Admin** (or Member) of that workspace | The preflight stops otherwise. |
| You are a **Fabric administrator** (recommended) | The app owner's identity is what the app uses to ask Fabric what each person can reach. Without it, group-based and shared access is invisible, and the estate scan sees only what you see. See [RUNBOOK.md](RUNBOOK.md#prerequisites). |
| Optional: an Azure OpenAI or AI Foundry resource with a chat deployment | For AI drafts, AI review and the context interview. See [Choosing the AI model](RUNBOOK.md#choosing-the-ai-model). |

Install in a test workspace first if you are unsure. [UPGRADING.md](UPGRADING.md) and `node tools/teardown.mjs` (see the
RUNBOOK) cover updates and removal.

## 3. Step by step

### Step 1: unzip and fill in the settings

1. Check the file you received: `Get-FileHash .\fabric-weave-<version>.zip -Algorithm SHA256` must match the
   `.sha256` file or the value the sender gave you.
2. Unzip it, for example to `C:\fabric-weave`. If Windows marks the files as downloaded from the internet, run
   `Get-ChildItem C:\fabric-weave -Recurse | Unblock-File` first (right-click the ZIP > Properties > Unblock before
   unzipping does the same).
3. Copy `deployment\customer.config.example.json` to `deployment\customer.config.json` and edit it.

| Setting | Required | Meaning |
|---|---|---|
| `tenantId` | recommended | Your Entra tenant id. The script signs in to it, and the installer refuses to run if the Azure CLI is in another tenant. |
| `workspaceId` | one of the two | An existing workspace. The all-zero GUID means "not set". |
| `workspaceName` | one of the two | Found by name (case-insensitive). If none exists and `capacityId` is set, it is created. Two workspaces with the same name stop the install: use `workspaceId`. |
| `capacityId` | only to create | The Fabric capacity that a new workspace is assigned to. Find it in the Fabric admin portal under Capacity settings. Set it to `""` when the workspace exists. |
| `aoaiEndpoint` | optional | `https://<resource>.openai.azure.com`. Empty installs without AI drafts and AI review. |
| `aoaiDeployment` | optional | The chat deployment name. Default `gpt-4.1`. |
| `aoaiApiVersion` | optional | Only for newer or reasoning models, for example `2025-04-01-preview`. |
| `admins` | optional | Sign-in names or object ids of app administrators. Empty means the account that runs the installer. |
| `appOnly` | optional | `true` (the example's value) installs only the app. `false` also installs the lakehouse, notebooks, pipeline and nightly estate scan, which add the Portfolio page and usage numbers. See [Estate scan](RUNBOOK.md#estate-scan-optional). |
| `runPipeline` | optional | With `appOnly: false`: run the scan once after installing. |
| `adopt` | optional | Take over existing items that have a Fabric Weave name but were not created by Fabric Weave. Check first. |
| `optOutTelemetry` | optional | Turn off Rayfin CLI telemetry. See [PRIVACY.md](PRIVACY.md#rayfin-telemetry). |

Keys that start with an underscore are comments. A value that still contains `<...>` is rejected, so a forgotten
placeholder cannot reach Fabric. The file holds ids and names only, no secrets, but keep it out of version control
(`customer.config.json` is git-ignored).

### Step 2: run the deployment script

```powershell
cd C:\fabric-weave
.\deployment\Deploy.ps1 -DryRun     # optional: shows the plan, changes nothing
.\deployment\Deploy.ps1
```

If PowerShell says that running scripts is disabled, run it as
`powershell -ExecutionPolicy Bypass -File .\deployment\Deploy.ps1`.

| Switch | Effect |
|---|---|
| `-ConfigPath <file>` | Use another settings file. |
| `-DryRun` | Run the preflight checks and print the plan, but change nothing. It needs the Azure CLI signed in, because it reads the workspace. With a workspace name that does not exist yet it only reports that the workspace would be created; the remaining steps show once it exists. |
| `-NonInteractive` | Never prompt. Sign in with `az login --tenant <id>` beforehand. For pipelines. |
| `-Offline` | Install npm packages only from `offline-cache\npm-cache` (the offline ZIP). Without the switch the bundled cache is used first and the registry is the fallback. |
| `-SkipPreflight` | Skip the preflight checks (not recommended). |

Command-line flags of the installer win over the file. On macOS or Linux (option B):

```bash
az login --tenant <tenant-id>
node install.mjs --config deployment/customer.config.json --result deployment/last-deployment-result.json
```

#### What `Deploy.ps1` does

1. Checks Node.js (20 to 24) and the Azure CLI.
2. Reads the settings file and checks it for placeholders and unknown settings.
3. Makes sure the Azure CLI is signed in to the right tenant (opens a browser if not).
4. Uses `offline-cache\npm-cache` when the package has one.
5. Runs `node install.mjs --config ...`, which:
   - finds the workspace (by id or name) or creates it on the capacity;
   - runs the **preflight**: Node and npm versions, sign-in, workspace and role, capacity active and big enough, Fabric
     administrator, items that already exist, admins and the Azure OpenAI endpoint. A `[FAIL]` stops it before anything
     is created;
   - with `appOnly: false`, deploys the lakehouse, three notebooks and the pipeline;
   - runs `npm ci`, generates `app/rayfin/rayfin.yml`, runs `rayfin up` (creates the app, schema and hosting), sets the
     secrets and runs `rayfin up` a second time so the secrets and the sign-in redirect take effect. This takes about
     8 minutes;
   - writes `deployment\last-deployment-result.json`.
6. Prints the app URL and the manual steps.

Running it again is safe. It updates what exists. Notebooks and the pipeline definition are overwritten; see
[UPGRADING.md](UPGRADING.md) for the details.

### Step 3: the manual steps (they cannot be scripted)

| Step | Why |
|---|---|
| Add the app identity to each workspace you want scanned, as Member or Contributor (workspace > Manage access) | The app reads and writes models with its own identity. People still only see and change what Fabric lets them. |
| With Azure OpenAI: grant the app identity **Cognitive Services OpenAI User** on the resource that hosts the deployment | Owner or Contributor does not carry the model data actions. |
| Make the app owner a Fabric administrator | Group-based and shared access is then visible. |
| Share the app with the people who should use it (Fabric sharing of the app item) | Opening the app is not otherwise restricted. |
| Open the **Workspaces** page and put a workspace "In scope" | Nothing can be applied until then. Start in clone mode. |

[RUNBOOK.md](RUNBOOK.md#after-the-install-manual-cannot-be-scripted) has the full list and the reasons.

## 4. After the install: verify

1. Open the app URL from the script output (or `app.url` in `deployment\last-deployment-result.json`). Sign in and
   allow pop-ups for the site.
2. **Status**: "Fabric and Power BI access" and "Rollback snapshot signing" should be green. The AI model row is green
   only when you configured Azure OpenAI. With `appOnly: true` the "Estate scan and Portfolio page" row stays amber on
   purpose.
3. **Models** > open a model > **Overview**: the AI-readiness score and the failed rules.
4. **Fix workbench**: select proposals, watch the score rise, apply to a clone ("<model> (AI-ready)"), and check the new score.
5. Open the workspace link from the result file and confirm the items are there.

If a row is red, section 5 and the RUNBOOK troubleshooting table list the causes.

## 5. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "running scripts is disabled on this system" | Run `powershell -ExecutionPolicy Bypass -File .\deployment\Deploy.ps1`, or `Unblock-File .\deployment\Deploy.ps1`. |
| "Node.js ... is not supported" | Install Node.js 20, 22 or 24 (LTS) and open a new PowerShell window. |
| "The Azure CLI (az) was not found" | Install it, then open a new PowerShell window so `az` is on the PATH. |
| "the config file ... has problems" | The message lists each one: a placeholder still in the file, an unknown setting name, a value that is not a GUID, or neither `workspaceId` nor `workspaceName`. |
| "the Azure CLI is signed in to tenant X, but the config file says Y" | Run `az login --tenant <Y>` (the script does this unless `-NonInteractive`). |
| "no workspace called ... was found and capacityId is not set" | Create the workspace in Fabric, or set `capacityId` (or `workspaceId`) in the file. |
| "N workspaces are called ..." | Set `workspaceId` to pick one. |
| "could not create the workspace ... (HTTP 403)" | A tenant setting restricts who may create workspaces, or you cannot assign that capacity. Ask a Fabric administrator to create the workspace, then set `workspaceId`. |
| Preflight `[FAIL]` on capacity, role or items | See the RUNBOOK troubleshooting table (paused capacity, you are not Admin or Member, an item with a Fabric Weave name that is not ours: `adopt`). |
| `npm ci` fails with `ENOTCACHED` while using `-Offline` | The cache lacks a package for this machine. It was built for the platform in `deployment\package-info.json`. Use the online ZIP, drop `-Offline` (the registry is the fallback), or ask the sender for a package built on your platform. |
| `npm ci` fails with ENOENT or path-too-long errors | The folder path is too long. Move the package to `C:\fabric-weave`. |
| `npm` cannot reach the registry (ETIMEDOUT, ECONNRESET) | Proxy or firewall. Set `HTTPS_PROXY`, or use the offline ZIP. |
| `npm ci` fails with `EINTEGRITY` | The package was built from a lockfile with a wrong hash. Ask the sender for a newer package. A company registry mirror is fine: the hashes are the same. |
| The install stops half way | Fix the cause in the message and run the script again. It is safe to repeat. |
| Sign-in fails with a redirect URI error | The hosting URL was not in the redirect list. Run `Deploy.ps1` again (the second `rayfin up` adds it). |
| Anything else | See [RUNBOOK.md](RUNBOOK.md#troubleshooting). To remove an install: `node tools/teardown.mjs --workspace <id>` (see the RUNBOOK). |

## 6. Rebuilding the package (delivery team)

Build from a clone of the repository, on the kind of machine the receiver uses (the offline cache is
platform-specific). You need Git, Node.js 20 to 24 and PowerShell.

```powershell
git checkout main
git pull
.\deployment\Build-Package.ps1                       # fabric-weave-<version>.zip
.\deployment\Build-Package.ps1 -IncludeOfflineCache  # fabric-weave-<version>-offline.zip
```

Before a release, run `node tools/verify-lockfile.mjs` (see CONTRIBUTING): the package is only as installable as the
lockfile's hashes. Both builds write to `dist\` together with a `.sha256` file. The script:

1. Stops if the working tree has uncommitted changes (`-AllowDirty` overrides; those changes are not packaged).
2. Exports the committed files with `git archive`, the same files as a release. Developer-only files that
   `.gitattributes` excludes are left out.
3. With `-IncludeOfflineCache`: runs `npm ci` into the package's own cache, deletes `node_modules`, then proves the
   cache is complete by running `npm ci --offline` from it and deleting `node_modules` again (`-SkipVerify` skips the proof).
4. Writes `deployment\package-info.json`.
5. Zips everything (forward-slash entries, so it unpacks on every platform), checks that the required files are in the
   ZIP and that no private file is (`customer.config.json`, `.env`, `rayfin.yml`, `.deployments.json`), and writes the
   SHA256.

The version is the `version:` line in `app/rayfin/rayfin.base.yml`. Bump it, update `CHANGELOG.md`, commit, then build.
Pushing a `v<version>` tag makes the release workflow publish the online package as a GitHub release asset with
`SHA256SUMS.txt` (it is built with the same `git archive`, so it has the same files except `package-info.json`).
The offline ZIP is large and platform-specific: build it with `Build-Package.ps1 -IncludeOfflineCache` and share it
through your own storage or attach it to the release by hand.

Send the ZIP and its SHA256 through a channel you trust. The package contains no secrets and no customer data.
