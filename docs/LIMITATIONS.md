# Known limits and responsible use

Fabric Weave is a community accelerator. Read this page before you rely on it.

## Responsible use

- **Scores are heuristics.** They check metadata against a rule catalog. A high score means the model follows the
  practices the rules look for; it does not prove that Copilot or any other AI will answer correctly. The meaning of
  the quick score (from scanner metadata, the whole portfolio) and the deep score (from the full model definition, per
  model) is described in the [README](../README.md); the two are different measures and are not interchangeable.
- **A person reviews everything.** Descriptions, business context and review comments produced by Azure
  OpenAI can be wrong or invent business meaning. The app shows them as proposals with a diff and applies nothing
  without a person selecting it. Keep that step: read what you apply, especially in in-place mode.
- **Copilot behaviour is not guaranteed.** Better descriptions and structure usually help, but Microsoft
  controls how Copilot uses a model and that can change. "Approved for Copilot" is an attestation the app records; it
  cannot set the flag in Fabric.
- **Do not put secrets or personal data** in names, descriptions or the business context. They are stored in the app
  database and sent to Azure OpenAI ([PRIVACY.md](PRIVACY.md)).

## Writing to models

- **Git-integrated workspaces.** An in-place update changes the model in the service but not the Git repository. The
  model is then uncommitted, and a later Git sync can overwrite the change or conflict with it. For teams that work
  from Git, use **propose-only** mode (the change set and diff are produced for your team to apply in their normal
  process) or the clone mode.
- **Models that cannot be updated.** Models that are read-only, were modified through the XMLA endpoint, or are
  composite are not pre-checked. The service may refuse the update; the app then reports the service's message and
  nothing is written. A Direct Lake model must point at a lakehouse the app identity can access.
- **Additive changes only.** The app adds descriptions, measures and similar metadata, and makes the
  settings changes listed in the README. It never renames anything: technical or abbreviated names are flagged for you
  to fix in the model source. It does not remove or restructure tables, columns or
  relationships (an apply that would is refused).
- **No synonyms.** The Q&A visual they serve is being deprecated, so synonyms are not scored, proposed or editable.
  Synonyms already in a model's AI data schema are kept when the app writes to it.
- **A clone is a new model.** Set its credentials and refresh it before pointing reports at it.
- **No history of scores.** Only the latest assessment per model is kept. There is no trend over time yet.
- **Rollback depends on the app database.** Snapshots are kept only for the last 5 in-place changes per model, cannot
  be exported, and cannot be restored if the signing key was rotated.

## Scanning and data

- **Estate scan is optional, and so are its limits.** Without it (`--app-only`) there is no Portfolio page, no usage or
  adoption numbers, no quick score for models nobody has opened, and no inventory of workspaces the app identity is not
  a member of. The Models and Workspaces pages list only what the app identity can reach and the person may see.
- **Tenant settings** (estate scan only). The scanner needs the tenant admin settings that allow the admin APIs and detailed metadata
  scanning (see Microsoft's documentation for the Admin Scanner API for the current names), and the pipeline owner
  must be a Fabric administrator. Without them the scan covers only what the owner can see or returns less detail
  (`scanner_coverage` records what came back), and the Agents tab shows settings as "unknown".
- **Single workspace deployment.** One install is one workspace (the app and, with the estate scan, the lakehouse, notebooks and pipeline). It scans
  the tenant's workspaces within the scanner's scope, but there is no multi-environment or multi-tenant setup.
- **Nightly freshness** (estate scan only). The portfolio is as old as the last nightly run. The app warns when that run failed or the
  data is more than 36 hours old.
- **English-only rules.** The rule catalog, naming checks and AI prompts are written for English. Models in other
  languages can be scored but naming and description rules may not fit them.
- **Row data is not looked at.** That protects privacy, but it also means rules about data quality, cardinality or
  values are out of scope.

## Platform

- **Rayfin is a pre-release dependency.** The app is built on the Rayfin SDK and CLI (`@microsoft/rayfin-*`), which
  are pre-release packages. Their behaviour, supported Node versions and terms can change. The installer and the lockfile
  pin what was tested.
- **Node 20 to 24.** Rayfin does not support newer Node versions yet. Node 20 is end of life; preflight warns about it.
- **Capacity.** The app and Copilot need a Fabric capacity (F2 or larger). A paused capacity stops the nightly run.
- **Access model.** The app reads and changes Fabric as its own identity, because Rayfin gives the Functions no token for
  the person using the app. It therefore checks each person against Fabric itself (what they can reach, where they have
  Write, where they are a workspace Admin), which is a check inside the app and not Fabric enforcement. It needs the app
  owner to be a Fabric administrator to see group-based and shared access; the people in `APP_ADMINS` skip the checks.
  Database rows can be written directly by a determined signed-in user, so the audit log is best-effort evidence
  ([SECURITY.md](../SECURITY.md)). True per-user delegation would need your own Entra app registration with user
  sign-in and consent, which Rayfin does not offer.
- **Tested environments.** Developed and exercised against one Microsoft Fabric tenant from Windows. The GitHub
  Actions workflows run the unit tests on Linux, Windows and macOS, but no installation was run on macOS or Linux, and
  the Codespaces/devcontainer and Azure Cloud Shell paths are untested.
