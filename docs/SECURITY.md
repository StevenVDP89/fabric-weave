# Security notes

How to report a vulnerability and the full trust model are in the root [SECURITY.md](../SECURITY.md). This page lists
the identities and the technical controls.

## Identities

| Action | Runs as |
|---|---|
| Database reads and writes from a Function (settings, assessments, change sets, audit) | The signed-in caller, with the caller's database permissions |
| Calls to Fabric/Power BI, OneLake (portfolio file) and Azure OpenAI from a Function | The **app identity** (the Rayfin app's function identity, i.e. the app owner's identity) |
| Refresh notebooks and the pipeline (only with the estate scan) | The user who last saved the pipeline schedule |

Because Fabric calls use the app identity, the app has to decide for itself what each person may see and change. It asks
Fabric (see **Per-person access** below). The people listed in the optional `APP_ADMINS` secret are the exception and
can see and change everything the app can reach. Keep workspaces in clone or propose-only mode unless in-place is needed.

## Per-person access

Rayfin hands the Functions the app owner's tokens, never a token for the person using the app, so there is no on-behalf-of
call and Fabric cannot enforce the person's own permissions. The app checks them instead, in `lib/permissions.ts`:

| What | Who may | How it is checked |
|---|---|---|
| See a workspace or model, and the portfolio rows for it | Anyone Fabric says can reach the model | Fabric admin API `GET /admin/users/{id}/access?type=SemanticModel` (group membership and sharing resolved by Fabric), joined with `GET /admin/items?type=SemanticModel` for the workspace. Cached 5 minutes per person; an older answer is kept for up to an hour if Fabric cannot be reached |
| Apply fixes, roll back, approve for Copilot | Anyone with **Write** on the model | The same call, made fresh for every change. If the admin API is refused, a direct Contributor, Member or Admin role in the workspace |
| Change a workspace write mode | A direct workspace **Admin** | `GET /workspaces/{id}/roleAssignments` |
| Everything | The people in `APP_ADMINS` | The token's object id or sign-in name |

The person is identified by the Entra object id at the end of Rayfin's path-style `sub` claim
(`.../users/<object id>`), or by the `oid` claim. A plain `sub` is not used, because in Entra tokens it is not the object
id. The token carries no e-mail address, which is why `APP_ADMINS` should hold object ids as well as sign-in names.

If a person cannot be identified, or Fabric cannot be asked, the app shows nothing and refuses every change. The Status
page shows how your own access was worked out under "What you can see and change".

## Controls

- **Access gate**: every operation that reads or changes a model or a workspace calls `lib/permissions.ts` first
  (`requireModelRead`, `requireModelWrite`, `requireWorkspaceRead`, `requireWorkspaceAdmin`). Changes are always checked
  fresh against Fabric. A refused call writes an `access.denied` audit row. People in `APP_ADMINS` (matched on the
  token's `preferred_username`, `upn`, `email`, `unique_name`, `oid`, the object id in `sub`, case insensitive) skip the
  checks. A person the app cannot identify sees nothing and changes nothing.
- **Scope**: nothing is writable until a workspace is explicitly enabled with a write mode.
- **Additive-only apply**: before writing, the app checks that the set of tables, the columns of every table and the
  relationships are unchanged, that only the intended measures were added, and that no definition part would be
  removed. Any failure aborts with nothing written.
- **Signed rollback snapshots**: an in-place apply first saves the current definition, computes a SHA-256 over the
  stored chunks and an HMAC-SHA-256 over (workspace, model, snapshot id, digest) with the `SIGNING_KEY` secret, and
  stores the signature on the change set. Rollback recomputes the digest from what is in the database and verifies
  the signature before it unpacks anything, then restores only parts under `definition/` (`.tmdl`, `.json`),
  `Copilot/` (`.md`, `.json`) and `definition.pbism`. A tampered snapshot, a tampered change set (model,
  workspace or snapshot id), a missing signature or a missing key all refuse with an audit entry.
- **Fail closed**: without a usable key (32+ characters), in-place apply and rollback are refused. Clone and
  propose-only still work. The Status page shows the state.
- **Audit**: every apply, rollback, refusal and failure is written to `AuditLog`, which is create and read only for
  app users. It is best-effort evidence, not a tamper-proof ledger (see Known limits).
- **Validated change sets**: proposals are validated server-side before they are applied; the client cannot send
  arbitrary definition parts.
- **AI data handling**: only object names, descriptions and DAX expressions go to the model, never row data, plus the
  business context text you saved for that model and, during an interview, your answers. The context is stored in the
  Fabric Weave database, never written into the semantic model itself; do not put secrets or personal data in it.
  AI output is shown as a proposal with a diff and is never applied without a person selecting it. Only Azure OpenAI
  endpoints of the form `https://<name>.openai.azure.com`, `.services.ai.azure.com` or
  `.cognitiveservices.azure.com` are accepted.
- **Voice input**: dictation and spoken questions use the browser's built-in speech features (Web Speech API). In
  Chrome and Edge the audio goes to the browser vendor's speech service, not to Fabric Weave or the AI model; the
  app only receives the recognised text. Typing always works instead.
- **No secrets in the repository**: the Rayfin secrets live on the deployed item. `rayfin.base.yml` holds only names
  and descriptions; the installer generates the git-ignored `rayfin.yml` from it.

## Known limits

- **The per-person check is the app's, not Fabric's.** It is only as good as the answer the Fabric admin API gives, and it
  has these limits:
  - Fabric administrator rights are needed to see group-based and shared access. If the app owner is not a Fabric
    administrator, only direct workspace role assignments are read (this needs the Member role or higher in each
    workspace), roles given through a group are invisible, and those people see nothing until the owner is made a Fabric
    administrator or they are added directly.
  - A person who is a workspace Admin only through a group cannot change that workspace's write mode; an app
    administrator has to.
  - Reads are remembered for 5 minutes per person, so a removed permission can show for that long. Changes are never
    answered from memory. The Fabric admin API allows 200 requests an hour, which the cache is sized for.
  - Clone mode needs Write on the source model, a deliberate simplification: the app does not separately check where the
    copy lands.
  - The app database is not locked per person (Rayfin has no per-user roles): the stored assessments, change sets and
    audit rows are readable by every signed-in user, and business context rows are writable by every signed-in user. The
    app's screens offer to save context only where the person has Write.
- Rayfin offers only the `authenticated` and `anonymous` roles, and the database is accessed with the caller's own
  identity. A determined signed-in user could therefore write app database rows directly (workspace settings, audit
  rows, business context, change-set rows), bypassing the functions and the access checks. Two things are
  protected by an HMAC with the server-held `SIGNING_KEY`: workspace write-mode rows (a row that the app did not sign
  falls back to propose-only) and rollback snapshots. Everything else is not. The audit log is
  best-effort evidence, not a tamper-proof ledger: a user with direct database access can add misleading rows, and
  deletion of rows by such a user may go unrecorded. A user could also delete snapshots, which makes rollback
  unavailable. Share the app accordingly.
- A signed older snapshot of the same model can be replayed by editing change-set status fields. That restores a
  state the model really had, and is recorded in the audit log, but it is a rollback you did not intend. The
  newest-first rule is enforced from the same editable fields.
- "Approved for Copilot" has no public API. The app records an attestation and links to the model settings; it
  cannot set the flag itself.
- Tenant settings are readable only by Fabric administrators; for other users the Agents tab reports them as
  unknown rather than guessing.
