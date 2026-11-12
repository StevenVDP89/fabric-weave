# Findings

Things learned while building this that are not obvious from the product documentation.

## What the Admin Scanner returns (spike S5)

The portfolio scan (`NB_01_Scan_Inventory`) uses the Admin Scanner API because it covers every workspace without
exporting each model. Observed on a real tenant:

| Level | Returned |
|---|---|
| Dataset | `configuredBy`, `configuredById`, `contentProviderType`, `createdDate`, `datasourceUsages`, `description`, `expressions`, `id`, `name`, `refreshSchedule`, `relations`, `schemaRetrievalError`, `tables`, `targetStorageMode`, `users` |
| Table | `columns`, `description`, `isHidden`, `measures`, `name`, `source`, `storageMode` |
| Column | `columnType`, `dataType`, `description`, `expression`, `isHidden`, `name` |
| Measure | `description`, `expression`, `isHidden`, `name` |

Not returned: relationships detail, format strings, keys, Q&A enabled, approved-for-Copilot,
endorsement, Copilot instructions, schema, indexing, example prompts. The portfolio quick score is therefore
metadata-only (descriptions, hidden flags, names, measure counts). The full score needs the model definition
through `getDefinition`, which is why the app has a quick score and a deep score. `scanner_coverage` in the
lakehouse records this per run.

Example: the unprepared sample scored 22.7 on the deep score; the same model after the safe fixes scored 85.3. It does
not go higher because its cryptic names are only flagged, never renamed for you. Its quick score is 79.4 because the
quick score cannot see instructions, format strings or the AI data schema.

Synonyms are deliberately not part of the score. The Q&A visual they served is being deprecated, so Fabric Weave does
not score, propose or edit synonyms. Synonyms already in a model's AI data schema are kept when the app writes.

## Rayfin authentication

- Functions run in the caller's context for database access and in the **app identity** for Fabric, OneLake and
  Azure OpenAI calls.
- The hosting URL and the Functions only accept a token from a browser sign-in (delegated `Item.Execute.All`,
  scope id `caf40b1a-f10e-4da1-86e4-5fda17eb2b07`). The Azure CLI cannot request it (AADSTS65002), so a deployed
  Function cannot be exercised from a script without an app registration you own. See the runbook for the manual
  verification.
- Node 26 is not supported by the Rayfin CLI. Use 20 to 24.
- **Error messages are hidden unless the error is a `UserThrownError`.** The UDF runtime
  (`@microsoft/fabric-user-data-functions`, `ensureFormattedReturnType`) turns every other thrown error into
  `InternalError: An internal execution error occured during function execution` and keeps the real text only in a
  server-side property. The docs say a thrown error "carries its message", which is only true for `UserThrownError`.
  Fabric Weave wraps every function in `guarded()` so users see the cause. To debug a deployed function, read the
  `function.error` rows in the `AuditLogs` table of the app database.
- **Subscription Owner is not enough for the model call.** Azure OpenAI data-plane calls need the data action
  `Microsoft.CognitiveServices/accounts/OpenAI/deployments/chat/completions/action`, which only roles such as
  "Cognitive Services OpenAI User" carry. The app identity needs that role on the resource that hosts the
  deployment. Role changes can take several minutes to apply.
- **Check which resource owns the deployment.** In the test tenant an Azure OpenAI resource (kind `OpenAI`) had no
  deployments; `gpt-4.1` lived on an AI Foundry resource whose endpoint looks like
  `https://<foundry-resource>.cognitiveservices.azure.com`. `az cognitiveservices account deployment list` shows them.
  Model call errors now name the missing role (401/403) or the missing deployment (404).

## Rayfin data client

- **Reads return only the `id` column unless you call `.select([...])`.** `GraphQLQueryBuilder.buildFieldSelection()`
  falls back to `id` when nothing is selected, so `entity.findFirst(filter)`, `findMany(filter)` and `findById(id)`
  return `{ id }` and every other column reads as `undefined`. The Rayfin docs show `findFirst({ name: { eq: ... } })`
  as if it returned the row, which is misleading.
- The app hit this when Apply said "This workspace is not enabled for changes" for a workspace stored as
  `in-place` and in scope: `readSetting` got `in_scope === undefined`. Rollback, the approval attestation and the
  business context were affected the same way.
- Always read with `.select([...columns]).where({ ... }).first(n).execute()`. `first(n)` also bounds the page,
  because an unbounded query returns the default 100 rows.
- `create` and `update` return the `id` plus the fields you sent, so their result can be used as is.
- `functions/test/store-reads.test.mjs` runs the real data client against a fake transport that returns only the
  selected columns, and fails the build if `findFirst`, `findMany` or `findById` appears in `functions/src` or
  `frontend/src`.

## Semantic model facts that affect the design

- `updateDefinition` replaces the whole definition. Never send `.platform`.
- Sending `diagramLayout.json` hangs the long-running operation, so the patcher and the clone path drop it.
- Copilot parts (`Copilot/instructions.md`, `Copilot/settings.json`, ...) persist only with a `$schema`,
  `version.json` and a `definition.pbism` at version 5.0 or higher. The patcher upgrades these.
- "Approved for Copilot" has no public API. Fabric Weave records an attestation and links to the model settings.
- The Power BI MCP server endpoint is `https://api.fabric.microsoft.com/v1/mcp/powerbi`; it respects the model's
  AI settings and Q&A availability.
- Some models fail `getDefinition` with `UnknownError ... Dataset Workload failed to export the dataset`. That is a
  service-side export failure, not an app bug. The portfolio still shows the quick score for them.
- Activity events are queried over a 28-day window, so "views" in the portfolio means the last 28 days.
- **A table can have only one column with `isKey`.** The service rejects a definition with two
  (`The table 'x' has two columns with the IsKey property set to True`, `Dataset_Import_FailedToImportDataset`).
  Marking a date table needs `isKey` on the date column. Fabric Weave never changes an existing key, so when
  another column (for example `date_key`) already is the key, the date-table fix is not proposed and FND-004
  tells the user to do it by hand. `integrityProblems` also refuses any change set that would leave a table with
  two key columns, before anything is sent. Verified against the service with a throwaway model: a definition
  with two keys was rejected, Fabric Weave's output was accepted.
- A rejected `updateDefinition` is atomic: the model stays as it was. The failed change set row records the reason.

## Lakehouse access

The lakehouse tables use deletion vectors, so `deltalake` in Python cannot read them. Use the SQL endpoint (ODBC
with an Entra token for `https://database.windows.net/`) or Spark.

## Business context and the interview

- The context is one free-text description (up to 4000 characters) per model, stored in `BusinessContext.context_text`.
  Typing it, dictating it and the agent interview all produce that same text, so the Fix tab has one input to use.
  Older entries made of separate fields are still read (the server and the Context tab turn them into text) and are
  replaced when the person saves.
- The interview is stateless on the server: the browser sends the questions and answers so far on every call, and
  the Function returns the next question plus the description as it stands. It stops at 8 questions, when the
  model says it has enough, or when the person chooses Finish now.
- The saved text is passed to every AI draft (descriptions, example prompts, AI instructions). The
  rule-based instructions fallback copies it as bullets under "Business context", so it helps even without an AI model.
- Voice uses the browser's Web Speech API (dictation) and speech synthesis (reading questions aloud). It is not a
  realtime voice agent: there is no streaming audio, and recognition quality and language support depend on the
  browser. Firefox has no recognition, so the buttons are hidden there.

## Not built (decided against or out of scope)

- A realtime voice agent for the interview (streaming speech with an Azure OpenAI realtime deployment). Browser
  dictation covers speech-to-text without another deployment or the audio passing through the app.
- A Power BI executive report over the lakehouse tables. It would need its own requirements intake and a report
  theme before it is built.
- An MCP test bench that asks real questions through the Power BI MCP server before and after a fix. It would
  need the same user-delegated token as the Functions.
