# Demo script (about 10 minutes)

Two sample models live in the solution workspace:

- **Sloppy Sales (unprepared)**: the "before". No descriptions, cryptic names, no instructions. Scores 22.7, Not ready.
- **Sloppy Sales (demo)**: the same model after Fabric Weave fixed it in place. Scores about 85, AI-ready. It stops
  there because the cryptic names (`cust_nm`, `dim_cust`) are flagged, not renamed: that is a manual step in the model
  source, and it is a good point to make in the demo.

Create another unprepared copy any time with
`node tools/cli.mjs deploy-sample --workspace <id> --name "Sloppy Sales (unprepared 2)"`.

## Story

"Every Copilot customer can ask questions of their semantic models, but most models were built for report authors,
not for AI. Fabric Weave shows how ready the estate is, and fixes it."

## Flow

1. **Portfolio**: the whole estate in one table. Point out workspaces and models scanned, views in the last 28 days,
   the quick score and tier per model. Sort by views to find "popular and not ready", which is the highest-value
   work. The quick score uses scanner metadata only, so say it is a first look.
2. **Models** > open "Sloppy Sales (unprepared)". Overview reads the real definition and gives the deep score. Walk through the seven
   categories (foundation, descriptions, naming, instructions, schema, examples, governance). Below them, the **Findings**
   cards show one card per category with its score ring, severity chips and the points still to gain; click a check to
   see the affected objects and how to fix it. Note the gates: a model with no measures, Q&A switched off, or no
   capacity cannot score above a cap.
3. **Context tab**: two ways to say what the model is for. Write it (or dictate it), or click **Start the interview**:
   the agent reads the model, asks one question at a time (at most 8), and follows up on vague answers. Turn on
   **Voice conversation** to hear the questions and answer aloud (Chrome or Edge). Review the text it wrote, then Save.
4. **Fix workbench**: each proposal shows its estimated score gain and how many changes it contains. Nothing is selected
   at first, so the dial on the left shows today's score; tick proposals (or **Safe only**, **Select all**) and the
   dial and category bars rise live. The number is an estimate from each proposal's own effect and is re-checked
   against Fabric after writing. Rule-based proposals
   need no LLM. Click **Draft with AI** for descriptions and instructions: the instructions now carry the context you
   just saved (the page says so), the LLM sees metadata and that text only, and the output is something to
   review and select, not applied automatically.
5. **Write mode**: on the Workspaces page, show the write mode and the In scope switch. Apply to an **AI-ready clone** first. The page re-reads the clone and
   shows the new score. Then show **in-place**, which saves a signed snapshot first, and **propose-only** for
   Git-driven teams.
6. **Roll back** an in-place change from the change set list and show the score returning. Open the audit log.
7. **Agent availability** tab: the checklist for making the model available to AI surfaces (Copilot, the Power BI MCP server,
   Data Agents): tenant switches, capacity eligibility, Q&A, and the "Approved for Copilot" attestation with a
   deep link, because that flag has no public API.
8. **Status page**: shows the app is wired to Fabric, the LLM, the portfolio and snapshot signing.

## Talking points

- Why it matters: Copilot answers are only as good as the model's descriptions, naming and instructions.
- It is a Fabric app built with Rayfin and deployed as a solution in its own workspace; the scan and score run
  daily in a pipeline, so the portfolio is always current.
- Safe by default: nothing is writable until a workspace is enabled, changes are additive, and every in-place change
  is signed, snapshotted and reversible.

## Before a customer demo

- Run `PL_AI_Readiness_Refresh` so the portfolio includes the unprepared sample.
- Make sure the app identity is a Member of the workspace and has the Azure OpenAI role, or the AI draft button
  will report an error.
- Sign in once beforehand to confirm every row on Status is green.
