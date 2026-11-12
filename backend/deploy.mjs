import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUEST_TIMEOUT_MS,
  TokenCache,
  decideAdoption,
  findDeploymentByWorkspace,
  managedDescription,
  shouldRunPipeline,
  withTimeout,
} from "../tools/lib/common.mjs";
import { az, azToken } from "../tools/lib/fabric.mjs";
import { manifestIds, readBaseVersion, readManifest, readRegistry, recordInstall, writeManifest } from "../tools/lib/local.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FABRIC_BASE = "https://api.fabric.microsoft.com/v1";
const PBI_BASE = "https://api.powerbi.com/v1.0/myorg";
const ONELAKE_BASE = "https://onelake.dfs.fabric.microsoft.com";

const LAKEHOUSE_NAME = "AIReadiness_LH";
const PIPELINE_NAME = "PL_AI_Readiness_Refresh";
const NOTEBOOK_FILES = [
  { name: "NB_01_Scan_Inventory", file: "NB_01_Scan_Inventory.py" },
  { name: "NB_02_Usage", file: "NB_02_Usage.py" },
  { name: "NB_03_Quick_Score", file: "NB_03_Quick_Score.py" },
];

// Every request has a timeout, and waiting for the pipeline run has an upper bound too (30 minutes by default).
const requestTimeoutMs = Number(process.env.FABRIC_WEAVE_REQUEST_TIMEOUT_SECONDS) * 1000 || REQUEST_TIMEOUT_MS;
const fetchWithTimeout = withTimeout(fetch, requestTimeoutMs);
const jobTimeoutMs = (Number(process.env.FABRIC_WEAVE_JOB_TIMEOUT_MINUTES) || 30) * 60 * 1000;

const BOOLEAN_FLAGS = new Set(["skip-run", "no-run-pipeline", "run-pipeline", "adopt", "reset-schedule", "help"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (BOOLEAN_FLAGS.has(key) || !next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}: ${String(body).slice(0, 1000)}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

class UsageError extends Error {}

class FabricDeployer {
  constructor(workspaceId, { version, knownIds = [], adopt = false, legacy = false } = {}) {
    this.workspaceId = workspaceId;
    this.version = version;
    this.knownIds = knownIds;
    this.adopt = adopt;
    this.legacy = legacy;
    // Tokens are re-acquired once they are ten minutes old or about to expire.
    this.tokens = new TokenCache((resource) => azToken(resource));
    // Items created or updated in this run, for the local manifest.
    this.touched = [];
  }

  log(message) {
    const stamp = new Date().toISOString();
    console.log(`[${stamp}] ${message}`);
  }

  token(resource) {
    return this.tokens.get(resource);
  }

  async request(url, { resource, method = "GET", headers = {}, body, expected = [200], retries = 6 } = {}) {
    const expectedSet = new Set(expected);
    for (let attempt = 0; ; attempt += 1) {
      const allHeaders = { ...headers };
      if (resource) {
        allHeaders.Authorization = `Bearer ${this.token(resource)}`;
      }
      if (body !== undefined && !allHeaders["Content-Type"] && !allHeaders["content-type"] && !(body instanceof Uint8Array)) {
        allHeaders["Content-Type"] = "application/json";
      }
      const payload =
        body === undefined || body instanceof Uint8Array || typeof body === "string"
          ? body
          : JSON.stringify(body);
      const response = await fetchWithTimeout(url, { method, headers: allHeaders, body: payload });
      const text = await response.text();
      if ((response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504) && attempt < retries) {
        const retryAfter = Number(response.headers.get("Retry-After")) || Math.min(60, 2 ** attempt);
        this.log(`${method} ${url} -> ${response.status}; retrying in ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!expectedSet.has(response.status)) {
        throw new HttpError(response.status, url, text);
      }
      return { status: response.status, headers: response.headers, text, json: text ? JSON.parse(text) : undefined };
    }
  }

  async waitForOperation(location) {
    const start = Date.now();
    let waitSeconds = 2;
    for (;;) {
      await sleep(waitSeconds * 1000);
      const result = await this.request(location, { resource: "https://api.fabric.microsoft.com", expected: [200] });
      const body = result.json ?? {};
      const status = body.status;
      if (status === "Succeeded") {
        return body;
      }
      if (status === "Failed" || status === "Cancelled") {
        throw new Error(`Operation ${status}: ${JSON.stringify(body.error ?? body).slice(0, 2000)}`);
      }
      if (!status && Date.now() - start > 30000) {
        return body;
      }
      waitSeconds = Math.max(2, Number(result.headers.get("Retry-After")) || waitSeconds);
      if (Date.now() - start > 20 * 60 * 1000) {
        throw new Error(`Timed out waiting for operation ${location}`);
      }
    }
  }

  async listWorkspaceItems() {
    const items = [];
    let next = `${FABRIC_BASE}/workspaces/${this.workspaceId}/items`;
    while (next) {
      const page = await this.request(next, { resource: "https://api.fabric.microsoft.com" });
      const body = page.json ?? {};
      items.push(...(body.value ?? []));
      next = body.continuationUri;
    }
    return items;
  }

  findByName(items, type, displayName) {
    return items.find((item) => item.type === type && item.displayName === displayName);
  }

  // Applies the adoption rule to one expected item. Throws when the item is not ours and --adopt was not given.
  decide(existing) {
    const decision = decideAdoption(existing, { knownIds: this.knownIds, adopt: this.adopt, legacy: this.legacy });
    if (decision.action === "refuse") throw new Error(decision.reason);
    return decision;
  }

  // Checks every item the deployer is about to create or overwrite, before anything is changed.
  assertAdoptable(items) {
    const expected = [
      ["Lakehouse", LAKEHOUSE_NAME],
      ...NOTEBOOK_FILES.map((notebook) => ["Notebook", notebook.name]),
      ["DataPipeline", PIPELINE_NAME],
    ];
    const refusals = [];
    for (const [type, name] of expected) {
      const decision = decideAdoption(this.findByName(items, type, name), { knownIds: this.knownIds, adopt: this.adopt, legacy: this.legacy });
      if (decision.action === "refuse") refusals.push(`- ${decision.reason}`);
    }
    if (refusals.length > 0) {
      throw new Error(`Refusing to overwrite items that Fabric Weave did not create:\n${refusals.join("\n")}`);
    }
  }

  remember(item, type) {
    this.touched.push({ id: item.id, type, displayName: item.displayName });
  }

  // Puts the "Fabric Weave v<version> (managed)" marker on an item that was created before stamping existed, and
  // refreshes the version in it after an upgrade. A failure is only a warning: the id is in the local manifest anyway.
  async stamp(item, text) {
    const description = managedDescription(this.version, text);
    if (item.description === description) return;
    try {
      await this.request(`${FABRIC_BASE}/workspaces/${this.workspaceId}/items/${item.id}`, {
        resource: "https://api.fabric.microsoft.com",
        method: "PATCH",
        body: { description },
        expected: [200],
      });
    } catch (error) {
      this.log(`Warning: could not stamp ${item.displayName} with the managed marker: ${String(error.message).slice(0, 200)}`);
    }
  }

  async ensureLakehouse() {
    const items = await this.listWorkspaceItems();
    let lakehouse = this.findByName(items, "Lakehouse", LAKEHOUSE_NAME);
    const text = "Lakehouse for Fabric Weave inventory, usage, and quick-score tables.";
    const decision = this.decide(lakehouse);
    if (decision.action === "create") {
      this.log(`Creating lakehouse ${LAKEHOUSE_NAME}`);
      const response = await this.request(`${FABRIC_BASE}/workspaces/${this.workspaceId}/lakehouses`, {
        resource: "https://api.fabric.microsoft.com",
        method: "POST",
        body: {
          displayName: LAKEHOUSE_NAME,
          description: managedDescription(this.version, text),
        },
        expected: [201, 202],
      });
      if (response.status === 202) {
        await this.waitForOperation(response.headers.get("Location"));
      }
      const refresh = await this.listWorkspaceItems();
      lakehouse = this.findByName(refresh, "Lakehouse", LAKEHOUSE_NAME);
      if (!lakehouse) {
        throw new Error(`Lakehouse ${LAKEHOUSE_NAME} was not found after creation.`);
      }
    } else {
      this.log(`Lakehouse ${LAKEHOUSE_NAME} already exists (${decision.reason}); ${decision.action === "adopt" ? "adopting it" : "reusing it"}`);
      await this.stamp(lakehouse, text);
    }
    this.remember(lakehouse, "Lakehouse");
    const details = await this.request(`${FABRIC_BASE}/workspaces/${this.workspaceId}/lakehouses/${lakehouse.id}`, {
      resource: "https://api.fabric.microsoft.com",
      expected: [200],
    });
    return details.json;
  }

  async createOrUpdateItem(type, displayName, definition, text) {
    const items = await this.listWorkspaceItems();
    const existing = this.findByName(items, type, displayName);
    const decision = this.decide(existing);
    if (decision.action === "create") {
      this.log(`Creating ${type} ${displayName}`);
      const response = await this.request(`${FABRIC_BASE}/workspaces/${this.workspaceId}/items`, {
        resource: "https://api.fabric.microsoft.com",
        method: "POST",
        body: { displayName, type, description: managedDescription(this.version, text), definition },
        expected: [201, 202],
      });
      if (response.status === 202) {
        await this.waitForOperation(response.headers.get("Location"));
      }
      const refresh = await this.listWorkspaceItems();
      const created = this.findByName(refresh, type, displayName);
      if (!created) {
        throw new Error(`${type} ${displayName} was not found after creation.`);
      }
      this.remember(created, type);
      return created;
    }

    this.log(`${decision.action === "adopt" ? "Adopting and overwriting" : "Updating"} ${type} ${displayName} (${decision.reason})`);
    const response = await this.request(`${FABRIC_BASE}/workspaces/${this.workspaceId}/items/${existing.id}/updateDefinition`, {
      resource: "https://api.fabric.microsoft.com",
      method: "POST",
      body: { definition },
      expected: [200, 202],
    });
    if (response.status === 202) {
      await this.waitForOperation(response.headers.get("Location"));
    }
    await this.stamp(existing, text);
    this.remember(existing, type);
    return existing;
  }

  async ensureDirectory(lakehouseId, directoryPath) {
    const url = `${ONELAKE_BASE}/${this.workspaceId}/${lakehouseId}/${directoryPath}?resource=directory`;
    await this.request(url, {
      resource: "https://storage.azure.com",
      method: "PUT",
      headers: {
        "x-ms-version": "2023-11-03",
        "x-ms-date": new Date().toUTCString(),
      },
      expected: [201, 202, 409],
    });
  }

  async uploadOneLakeText(lakehouseId, relativePath, text) {
    const bytes = new TextEncoder().encode(text);
    const pieces = relativePath.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < pieces.length - 1; i += 1) {
      current = current ? `${current}/${pieces[i]}` : pieces[i];
      await this.ensureDirectory(lakehouseId, current);
    }

    const fileUrl = `${ONELAKE_BASE}/${this.workspaceId}/${lakehouseId}/${relativePath}`;
    await this.request(`${fileUrl}?resource=file`, {
      resource: "https://storage.azure.com",
      method: "PUT",
      headers: {
        "x-ms-version": "2023-11-03",
        "x-ms-date": new Date().toUTCString(),
      },
      expected: [201, 202],
    });
    if (bytes.length > 0) {
      await this.request(`${fileUrl}?action=append&position=0`, {
        resource: "https://storage.azure.com",
        method: "PATCH",
        body: bytes,
        headers: {
          "x-ms-version": "2023-11-03",
          "x-ms-date": new Date().toUTCString(),
          "Content-Type": "application/octet-stream",
        },
        expected: [202],
      });
    }
    await this.request(`${fileUrl}?action=flush&position=${bytes.length}`, {
      resource: "https://storage.azure.com",
      method: "PATCH",
      headers: {
        "x-ms-version": "2023-11-03",
        "x-ms-date": new Date().toUTCString(),
        "Content-Type": "application/octet-stream",
      },
      expected: [200],
    });
  }

  renderTemplate(text, replacements) {
    let rendered = text;
    for (const [key, value] of Object.entries(replacements)) {
      rendered = rendered.replaceAll(`{{${key}}}`, value);
    }
    return rendered;
  }

  async read(filePath) {
    return fs.readFile(filePath, "utf8");
  }

  sourceToCells(source) {
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    const cells = [];
    let current = { kind: "code", lines: [] };
    const flush = () => {
      if (current.lines.length === 0) return;
      const sourceLines = current.lines.map((line, index) => (index === current.lines.length - 1 ? `${line}\n` : `${line}\n`));
      if (current.kind === "markdown") {
        cells.push({
          cell_type: "markdown",
          metadata: {},
          source: sourceLines.map((line) => line.replace(/^# ?/, "")),
        });
      } else {
        cells.push({
          cell_type: "code",
          metadata: {},
          execution_count: null,
          outputs: [],
          source: sourceLines,
        });
      }
    };

    for (const line of lines) {
      if (line.startsWith("# %%")) {
        flush();
        current = { kind: line.includes("[markdown]") ? "markdown" : "code", lines: [] };
      } else {
        current.lines.push(line);
      }
    }
    flush();
    return cells;
  }

  notebookDefinition(source, workspaceId, lakehouseId, lakehouseName) {
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      cells: this.sourceToCells(source),
      metadata: {
        kernel_info: { name: "synapse_pyspark" },
        language_info: { name: "python" },
        dependencies: {
          lakehouse: {
            default_lakehouse: lakehouseId,
            default_lakehouse_name: lakehouseName,
            default_lakehouse_workspace_id: workspaceId,
            known_lakehouses: [{ id: lakehouseId, name: lakehouseName, workspaceId }],
          },
        },
      },
    };
    return {
      format: "ipynb",
      parts: [
        {
          path: "notebook-content.ipynb",
          payload: Buffer.from(JSON.stringify(notebook, null, 2), "utf8").toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };
  }

  pipelineDefinition(jsonText) {
    return {
      parts: [
        {
          path: "pipeline-content.json",
          payload: Buffer.from(jsonText, "utf8").toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };
  }

  async detectPipelineJobType(pipelineId) {
    for (const candidate of ["Pipeline", "DefaultJob"]) {
      try {
        await this.request(`${FABRIC_BASE}/workspaces/${this.workspaceId}/items/${pipelineId}/jobs/${candidate}/schedules`, {
          resource: "https://api.fabric.microsoft.com",
          expected: [200],
        });
        return candidate;
      } catch (error) {
        if (error instanceof HttpError && error.status === 400) continue;
      }
    }
    return "Pipeline";
  }

  schedulePayload() {
    const start = this.nextScheduleStart();
    const end = new Date(Date.UTC(start.getUTCFullYear() + 10, start.getUTCMonth(), start.getUTCDate(), 23, 59, 59));
    return {
      enabled: true,
      configuration: {
        type: "Daily",
        startDateTime: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
        endDateTime: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
        localTimeZoneId: "UTC",
        times: ["02:00"],
      },
    };
  }

  nextScheduleStart() {
    const now = new Date();
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0));
    if (candidate <= now) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate;
  }

  // Creates the daily schedule only when the pipeline has none. An existing schedule is left alone: PATCHing it would
  // silently make the caller the schedule owner, and the pipeline and notebooks run as that owner.
  async ensureSchedule(pipelineId, jobType, { reset = false } = {}) {
    const base = `${FABRIC_BASE}/workspaces/${this.workspaceId}/items/${pipelineId}/jobs/${jobType}/schedules`;
    const list = await this.request(base, { resource: "https://api.fabric.microsoft.com", expected: [200] });
    const schedules = list.json?.value ?? [];
    const payload = this.schedulePayload();
    if (schedules.length === 0) {
      this.log(`Creating ${jobType} schedule for ${PIPELINE_NAME}: daily at 02:00 UTC. The pipeline will run as you (${this.signedInName() || "the signed-in user"}).`);
      const created = await this.request(base, {
        resource: "https://api.fabric.microsoft.com",
        method: "POST",
        body: payload,
        expected: [201],
      });
      return { action: "created", id: created.json?.id ?? null };
    }
    const [first, ...rest] = schedules;
    if (!reset) {
      const times = first.configuration?.times?.join(", ") ?? "unknown times";
      this.log(
        `Kept the existing ${jobType} schedule ${first.id} (${first.enabled === false ? "DISABLED" : "enabled"}, ${first.configuration?.type ?? "unknown type"} at ${times}, owner ${first.owner?.id ?? "unknown"}). ` +
          "Not modified, so the pipeline keeps running as its current owner. Pass --reset-schedule to recreate it as daily 02:00 UTC owned by you.",
      );
      if (first.enabled === false) this.log("Warning: the schedule is disabled, so the portfolio will not refresh nightly.");
      if (rest.length > 0) this.log(`Note: the pipeline has ${schedules.length} schedules; none were removed.`);
      return { action: "kept", id: first.id, enabled: first.enabled !== false };
    }
    this.log(`Resetting ${jobType} schedule ${first.id} to daily 02:00 UTC. You (${this.signedInName() || "the signed-in user"}) become its owner, so the pipeline now runs as you.`);
    await this.request(`${base}/${first.id}`, {
      resource: "https://api.fabric.microsoft.com",
      method: "PATCH",
      body: payload,
      expected: [200],
    });
    for (const extra of rest) {
      this.log(`Deleting extra schedule ${extra.id}`);
      await this.request(`${base}/${extra.id}`, {
        resource: "https://api.fabric.microsoft.com",
        method: "DELETE",
        expected: [200],
      });
    }
    return { action: "reset", id: first.id, removed: rest.length };
  }

  signedInName() {
    const account = az(["account", "show", "--query", "user.name", "-o", "tsv"]);
    return account.ok ? account.stdout : "";
  }

  currentUser() {
    if (this.user) return this.user;
    const objectId = az(["ad", "signed-in-user", "show", "--query", "id", "-o", "tsv"]);
    this.user = { upn: this.signedInName(), objectId: objectId.ok ? objectId.stdout : "" };
    return this.user;
  }

  async runPipeline(pipelineId, pipelineName, jobType) {
    const runUrl = `${FABRIC_BASE}/workspaces/${this.workspaceId}/items/${pipelineId}/jobs/${jobType}/instances`;
    let response;
    try {
      response = await this.request(runUrl, {
        resource: "https://api.fabric.microsoft.com",
        method: "POST",
        expected: [202],
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 400) throw error;
      const user = this.currentUser();
      response = await this.request(runUrl, {
        resource: "https://api.fabric.microsoft.com",
        method: "POST",
        body: {
          executionData: {
            pipelineName,
            OwnerUserPrincipalName: user.upn,
            OwnerUserObjectId: user.objectId,
          },
        },
        expected: [202],
      });
    }
    const location = response.headers.get("Location") ?? response.headers.get("location");
    if (!location) {
      throw new Error("Pipeline run did not return a job-instance location header.");
    }
    const jobId = location.split("/").at(-1);
    this.log(`Pipeline run started: ${jobId}`);
    return { jobId, location };
  }

  async waitForJob(itemId, jobId) {
    const url = `${FABRIC_BASE}/workspaces/${this.workspaceId}/items/${itemId}/jobs/instances/${jobId}`;
    const start = Date.now();
    for (;;) {
      const result = await this.request(url, { resource: "https://api.fabric.microsoft.com", expected: [200] });
      const body = result.json ?? {};
      const status = body.status;
      if (status === "Completed") {
        return body;
      }
      if (status === "Failed" || status === "Cancelled" || status === "Deduped") {
        throw new Error(`Pipeline job ${jobId} ended with status ${status}: ${JSON.stringify(body.failureReason ?? body).slice(0, 2000)}`);
      }
      if (Date.now() - start > jobTimeoutMs) {
        throw new Error(
          `Pipeline job ${jobId} did not finish within ${Math.round(jobTimeoutMs / 60000)} minutes (last status ${status ?? "Unknown"}). ` +
            "It may still be running: check the Monitor hub in the workspace. " +
            "Raise the limit with FABRIC_WEAVE_JOB_TIMEOUT_MINUTES, or re-run with --no-run-pipeline to skip the initial run.",
        );
      }
      const wait = Math.max(10, Number(result.headers.get("Retry-After")) || 10);
      this.log(`Pipeline job ${jobId} status ${status ?? "Unknown"}; waiting ${wait}s`);
      await sleep(wait * 1000);
    }
  }

  // True when the nightly pipeline already produced Files/app/portfolio.json (the app reads it).
  async portfolioExists(lakehouseId) {
    try {
      const response = await this.request(`${ONELAKE_BASE}/${this.workspaceId}/${lakehouseId}/Files/app/portfolio.json?resource=file`, {
        resource: "https://storage.azure.com",
        method: "HEAD",
        headers: { "x-ms-version": "2023-11-03", "x-ms-date": new Date().toUTCString() },
        expected: [200, 404],
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async queryActivityRuns(jobId, after, before) {
    const url = `${FABRIC_BASE}/workspaces/${this.workspaceId}/datapipelines/pipelineruns/${jobId}/queryactivityruns`;
    const response = await this.request(url, {
      resource: "https://api.fabric.microsoft.com",
      method: "POST",
      body: {
        filters: [],
        orderBy: [{ orderBy: "ActivityRunStart", order: "DESC" }],
        lastUpdatedAfter: after,
        lastUpdatedBefore: before,
      },
      expected: [200],
    });
    const body = response.json ?? {};
    return Array.isArray(body) ? body : (body.value ?? []);
  }
}

const USAGE = `Usage: node backend/deploy.mjs --workspace <workspace-id> [options]

Creates or updates the lakehouse, the three notebooks, the refresh pipeline and its daily 02:00 UTC schedule.
Items it creates are marked "Fabric Weave v<version> (managed)" in their description.

  --out <file>          write the result (item ids, schedule, run) to a JSON file
  --adopt               overwrite items that already have the expected name but were not created by Fabric Weave
  --reset-schedule      recreate the nightly schedule even if the pipeline already has one (you become its owner)
  --run-pipeline        run the pipeline once and wait for it, even if a portfolio already exists
  --no-run-pipeline     never run the pipeline (--skip-run is the same)
  --version <x.y.z>     version to put in the marker (default: version of app/rayfin/rayfin.base.yml)

By default the pipeline runs once only when Files/app/portfolio.json does not exist yet.
Environment: FABRIC_WEAVE_JOB_TIMEOUT_MINUTES (default 30), FABRIC_WEAVE_REQUEST_TIMEOUT_SECONDS (default 60), AZURE_CLI_PATH.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceId = args.workspace;
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (typeof workspaceId !== "string") {
    throw new UsageError(USAGE);
  }
  const noRun = Boolean(args["no-run-pipeline"] || args["skip-run"]);
  if (args["run-pipeline"] && noRun) {
    throw new UsageError("--run-pipeline cannot be combined with --no-run-pipeline / --skip-run.");
  }
  const version = typeof args.version === "string" ? args.version : (readBaseVersion() ?? "unknown");

  // `legacy`: this machine recorded a Rayfin deployment for the workspace before items were stamped, so its items are adopted.
  const legacy = Boolean(findDeploymentByWorkspace(readRegistry(), workspaceId));
  const deployer = new FabricDeployer(workspaceId, {
    version,
    knownIds: manifestIds(readManifest(), workspaceId),
    adopt: Boolean(args.adopt),
    legacy,
  });
  deployer.log(`Fabric Weave v${version}: deploying the backend to workspace ${workspaceId}`);
  deployer.assertAdoptable(await deployer.listWorkspaceItems());

  const lakehouse = await deployer.ensureLakehouse();
  const lakehouseId = lakehouse.id;
  deployer.log(`Lakehouse ready: ${lakehouse.displayName} (${lakehouseId})`);

  const replacements = {
    WORKSPACE_ID: workspaceId,
    LAKEHOUSE_ID: lakehouseId,
    LAKEHOUSE_NAME: LAKEHOUSE_NAME,
  };

  const ruleCatalog = await deployer.read(path.join(__dirname, "catalog", "rule-catalog.json"));
  const notebookShared = await deployer.read(path.join(__dirname, "notebooks", "_shared.py"));

  await deployer.uploadOneLakeText(lakehouseId, "Files/config/rule-catalog.json", ruleCatalog);
  await deployer.uploadOneLakeText(lakehouseId, "Files/config/notebook_shared.py", notebookShared);

  const notebookIds = {};
  for (const notebook of NOTEBOOK_FILES) {
    const sourcePath = path.join(__dirname, "notebooks", notebook.file);
    const source = await deployer.read(sourcePath);
    const renderedSource = deployer.renderTemplate(source, replacements);
    const definition = deployer.notebookDefinition(renderedSource, workspaceId, lakehouseId, LAKEHOUSE_NAME);
    const item = await deployer.createOrUpdateItem("Notebook", notebook.name, definition, `Notebook ${notebook.name}.`);
    notebookIds[notebook.name] = item.id;
    deployer.log(`Notebook ready: ${notebook.name} (${item.id})`);
  }

  const pipelineTemplate = await deployer.read(path.join(__dirname, "pipeline", "pipeline-content.json"));
  const pipelineText = deployer.renderTemplate(pipelineTemplate, {
    WORKSPACE_ID: workspaceId,
    NB_01_ID: notebookIds.NB_01_Scan_Inventory,
    NB_02_ID: notebookIds.NB_02_Usage,
    NB_03_ID: notebookIds.NB_03_Quick_Score,
  });
  const pipeline = await deployer.createOrUpdateItem(
    "DataPipeline",
    PIPELINE_NAME,
    deployer.pipelineDefinition(pipelineText),
    "Scheduled metadata refresh pipeline.",
  );
  deployer.log(`Pipeline ready: ${PIPELINE_NAME} (${pipeline.id})`);

  // The ids are on record before the schedule and the run, so a failure there never leaves the items unrecorded.
  writeManifest(recordInstall(readManifest(), workspaceId, { items: deployer.touched }));

  const pipelineJobType = await deployer.detectPipelineJobType(pipeline.id);
  const schedule = await deployer.ensureSchedule(pipeline.id, pipelineJobType, { reset: Boolean(args["reset-schedule"]) });

  const runDecision = shouldRunPipeline({
    run: Boolean(args["run-pipeline"]),
    noRun,
    portfolioExists: args["run-pipeline"] || noRun ? false : await deployer.portfolioExists(lakehouseId),
  });
  deployer.log(`Initial pipeline run: ${runDecision.reason}`);
  let pipelineRun = null;
  let activityRuns = [];
  if (runDecision.run) {
    const started = await deployer.runPipeline(pipeline.id, PIPELINE_NAME, pipelineJobType);
    pipelineRun = await deployer.waitForJob(pipeline.id, started.jobId);
    activityRuns = await deployer.queryActivityRuns(
      started.jobId,
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );
  }

  const lakehouseDetails = await deployer.request(`${FABRIC_BASE}/workspaces/${workspaceId}/lakehouses/${lakehouseId}`, {
    resource: "https://api.fabric.microsoft.com",
    expected: [200],
  });

  const result = {
    workspaceId,
    version,
    lakehouse: {
      id: lakehouseId,
      displayName: lakehouse.displayName,
      sqlEndpointId: lakehouseDetails.json?.properties?.sqlEndpointProperties?.id ?? null,
      sqlEndpointConnectionString: lakehouseDetails.json?.properties?.sqlEndpointProperties?.connectionString ?? null,
    },
    notebooks: notebookIds,
    schedule,
    pipeline: {
      id: pipeline.id,
      jobType: pipelineJobType,
      ran: runDecision.run,
      runReason: runDecision.reason,
      lastRun: pipelineRun,
      activityRuns: activityRuns.map((run) => ({
        activityName: run.activityName,
        activityType: run.activityType,
        status: run.status,
        start: run.activityRunStart,
        end: run.activityRunEnd,
        error: run.error?.message || null,
      })),
    },
  };

  console.log(JSON.stringify(result, null, 2));
  if (typeof args.out === "string") {
    await fs.writeFile(args.out, JSON.stringify(result, null, 2), "utf8");
  }
}

main().catch((error) => {
  console.error(error instanceof UsageError ? error.message : error.stack || String(error));
  process.exitCode = 1;
});
