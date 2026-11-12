# Security policy

Fabric Weave is a community accelerator, not an official Microsoft product, provided as-is under the
[MIT licence](LICENSE). Read the trust model below before you share the app with other people.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes: security fixes go into the latest 1.0.x release |
| Anything older (pre-release builds) | No |

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Open a **private security advisory** on GitHub instead:
on the repository page choose **Security**, then **Advisories**, then **Report a vulnerability**. Describe what you
found, the version, how to reproduce it and what an attacker gains. Do not include real tenant data, tokens or
secrets in the report.

This is a community project with no service level: reports are handled on a best-effort basis. If a problem is in
Rayfin, Microsoft Fabric or Azure OpenAI rather than in this repository, report it to Microsoft through its own
channels.

## Trust model

Fabric Weave is a privileged tool. Decide who gets access with these five facts in mind.

1. **What a person can open and change is checked against their own Fabric permissions, by the app.** The app's
   Functions call Fabric, OneLake and Azure OpenAI as the **app identity**, which is the app owner's identity and not
   the identity of the person who is signed in (Rayfin gives the Functions no per-user Fabric token, so Fabric itself
   cannot enforce the person's permissions on these calls). The app therefore asks Fabric what the signed-in person may
   do, and refuses anything beyond that before it makes a call as the owner:
   - a person sees only the workspaces and models Fabric says they can reach, and the portfolio is cut down to the same
     models;
   - a person can apply fixes, roll back and record "approved for Copilot" only on models where Fabric gives them
     **Write**, checked against Fabric at the moment of the change, never from memory;
   - a person can change a workspace's write mode only when they hold the **Admin** role in that workspace directly;
   - anything the app cannot confirm is refused, and every refusal is written to the audit log (`access.denied`).

   This is a compensating check inside the app, not Fabric enforcement. For it to see group-based and shared access,
   the **app owner must be a Fabric administrator** (the app then uses the Fabric admin APIs). Without that, it falls back to
   direct workspace role assignments: people who have access only through a group see nothing until the owner is made a
   Fabric administrator or they are added to the workspace directly. Share the app with the people who should use it,
   and see the limits in [docs/SECURITY.md](docs/SECURITY.md).

2. **`APP_ADMINS` is an optional override.** The people listed in the `APP_ADMINS` secret (comma-separated sign-in
   names or Entra object ids) see and change everything the app can reach, which suits a central team that looks after
   the whole estate. The installer defaults it to the account signed in to the Azure CLI, name and object id. The
   Status page shows "You are signed in as ...": that is the value to put in `APP_ADMINS` for a person. Nothing can be
   written to a model until a workspace is also switched on, with a write mode, on the Workspaces page (the default is
   propose-only).

3. **The audit log is evidence, not a tamper-proof ledger.** Rayfin opens the app database with the caller's own
   identity and offers only an `authenticated` and an `anonymous` role. A determined signed-in user could therefore
   write rows into the app database directly (workspace settings, audit rows, business context, change-set rows),
   whatever the Functions would have allowed. The stored assessments, change sets and audit rows are readable by every
   signed-in user, and the business context of any model is writable by every signed-in user (the app's own screen
   only offers it where the person has Write). What the app does about it:
   - in-place write mode and rollback are protected by an HMAC with a server-held `SIGNING_KEY`: workspace-mode rows
     and rollback snapshots are signed, and a row or snapshot that fails its check is refused;
   - every apply, rollback, refusal and failure is written to the audit log, which the entity allows users to create
     and read but not to update or delete.

   A user who can reach the database could still add misleading audit rows or delete snapshots (so a rollback is no
   longer possible). Treat the audit log as best-effort evidence, and keep the people who can open the app to a
   group you trust.

4. **The notebooks run as the pipeline owner, and load shared code from the lakehouse.** This applies only if you install
   the optional estate scan; with `--app-only` there are no notebooks, pipeline or lakehouse. The nightly scan runs as
   the user who created or last saved the pipeline schedule, and `NB_01`, `NB_02` and `NB_03` load
   `Files/config/notebook_shared.py` from the `AIReadiness_LH` lakehouse. Anyone who can write to that lakehouse or
   edit those notebooks can run code as the pipeline owner, who is typically a Fabric administrator. Workspace
   Contributors on the Fabric Weave workspace are trusted to the same level as the pipeline owner, so keep the
   membership of that workspace small.

5. **What goes to Azure OpenAI.** Only if you configure an endpoint, and only your own Azure OpenAI resource: object
   names, descriptions, DAX expressions and relationships of the model being drafted or reviewed, plus the business
   context text you saved for that model and your answers in an interview. Never row data. Details in
   [docs/PRIVACY.md](docs/PRIVACY.md).

## Other things to know

- **Secrets** (`SIGNING_KEY`, `APP_ADMINS`, `AOAI_ENDPOINT`, `AOAI_DEPLOYMENT`, `PORTFOLIO_PATH`) live on the deployed
  Rayfin item, not in this repository. `app/rayfin/rayfin.base.yml` lists their names and descriptions only.
- **Rayfin telemetry.** The Rayfin command-line tool, which the installer runs, sends usage telemetry to Microsoft
  unless `RAYFIN_TELEMETRY_OPTOUT=1` is set. `node install.mjs --opt-out-telemetry` sets it for the processes the
  installer starts. See [docs/PRIVACY.md](docs/PRIVACY.md#rayfin-telemetry).
- **Dependencies.** The app depends on pre-release Rayfin packages (`@microsoft/rayfin-*`). CI fails on high or
  critical advisories in production dependencies (`npm audit --omit=dev --audit-level=high`), except advisories that
  only a Rayfin release can fix. Those are listed with a reason and an expiry date in `tools/audit-allowlist.json`.
  At the time of writing it holds one: `zod` below 4.6.6 (memory exhaustion on oversized collections), which the Rayfin
  packages pin. Dependabot is configured for npm and GitHub Actions, and a CodeQL workflow scans the code.
- **Controls and known limits in detail:** [docs/SECURITY.md](docs/SECURITY.md).
- **Privacy and data flow:** [docs/PRIVACY.md](docs/PRIVACY.md).
- **Known limits of the product:** [docs/LIMITATIONS.md](docs/LIMITATIONS.md).
