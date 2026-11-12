import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATALOG,
  PART,
  applyChanges,
  applyProposals,
  buildSnapshot,
  parseTmdl,
  proposeFixes,
  sloppySalesModel,
  scoreModel,
} from '../dist/index.js';

const parts = sloppySalesModel();
const snap = () => buildSnapshot(parts, { name: 'Sloppy Sales' });

test('catalog is well formed', () => {
  const ids = CATALOG.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
  assert.ok(CATALOG.rules.length >= 25);
  for (const r of CATALOG.rules) assert.ok(r.category in CATALOG.categories, r.id);
});

test('parser reads tables, columns, measures and relationships', () => {
  const s = snap();
  assert.equal(s.tables.length, 4);
  assert.equal(s.relationships.length, 3);
  const fact = s.tables.find((t) => t.name === 'fact_sales_tbl');
  assert.equal(fact.columns.length, 8);
  assert.deepEqual(fact.measures.map((m) => m.name), ['tot_amt', 'tot_qty', 'margin']);
  assert.equal(s.governance.qnaEnabled, true);
});

test('unprepared model scores as not ready', () => {
  const r = scoreModel(snap());
  assert.ok(r.score < 40, `score ${r.score}`);
  assert.equal(r.tier, 'Not ready');
});

test('a model without measures is capped by a gate', () => {
  const bare = { ...parts };
  bare['definition/tables/fact_sales_tbl.tmdl'] = parts['definition/tables/fact_sales_tbl.tmdl']
    .split('\n')
    .filter((l) => !l.startsWith('\tmeasure '))
    .join('\n');
  const r = scoreModel(buildSnapshot(bare, { name: 'bare' }));
  assert.ok(r.gates.some((g) => g.triggered), 'a gate triggered');
  assert.ok(r.score <= r.rawScore);
});

test('patcher keeps TMDL parseable and places every property under its own object', () => {
  const { parts: out, skipped } = applyChanges(parts, [
    { op: 'setDescription', target: { type: 'measure', table: 'fact_sales_tbl', name: 'tot_amt' }, value: 'Total amount.' },
    { op: 'setDescription', target: { type: 'measure', table: 'fact_sales_tbl', name: 'tot_qty' }, value: 'Total quantity.' },
    { op: 'setProperty', target: { type: 'measure', table: 'fact_sales_tbl', name: 'tot_amt' }, property: 'formatString', value: '#,0.00' },
    { op: 'setProperty', target: { type: 'measure', table: 'fact_sales_tbl', name: 'tot_qty' }, property: 'formatString', value: '#,0' },
  ]);
  assert.equal(skipped.length, 0);
  const text = out['definition/tables/fact_sales_tbl.tmdl'];
  const roots = parseTmdl(text);
  const table = roots.find((r) => r.kind === 'table');
  const amt = table.children.find((c) => c.name === 'tot_amt');
  const qty = table.children.find((c) => c.name === 'tot_qty');
  assert.equal(amt.props.get('formatString').value, '#,0.00');
  assert.equal(qty.props.get('formatString').value, '#,0');
  assert.equal(amt.description, 'Total amount.');
  assert.equal(qty.description, 'Total quantity.');
});

test('patcher creates Copilot parts and lineage tags', () => {
  const { parts: out } = applyChanges(parts, [
    { op: 'setInstructions', value: '# hi\n- be nice' },
    { op: 'setIndexing', value: true },
    { op: 'setExamplePrompts', value: ['one', 'two', 'three'] },
    { op: 'setAiVisibility', target: { type: 'column', table: 'dim_cust', name: 'cust_id' }, value: 'Hidden' },
  ]);
  assert.equal(out[PART.instructions].trim(), '# hi\n- be nice');
  assert.equal(JSON.parse(out[PART.settings]).indexingEnabled, true);
  assert.deepEqual(JSON.parse(out[PART.examples]).prompts, ['one', 'two', 'three']);
  const schema = JSON.parse(out[PART.schema]);
  const cust = schema.tables.find((t) => t.name === 'dim_cust');
  assert.equal(cust.columns.find((c) => c.name === 'cust_id').visibility, 'Hidden');
  assert.ok(cust.id, 'table has a lineage tag id');
  assert.ok(out['definition/tables/dim_cust.tmdl'].includes(`lineageTag: ${cust.id}`));
});

test('synonyms already in the AI data schema are kept but never scored, proposed or editable', async () => {
  const seeded = applyChanges(parts, [{ op: 'setAiVisibility', target: { type: 'table', table: 'dim_cust' }, value: 'Visible' }]).parts;
  const doc = JSON.parse(seeded[PART.schema]);
  doc.tables.find((t) => t.name === 'dim_cust').synonyms = ['Client', 'Customers'];
  seeded[PART.schema] = JSON.stringify(doc);

  const withSynonyms = scoreModel(buildSnapshot(seeded, { name: 'Sloppy Sales' }));
  const without = scoreModel(buildSnapshot(applyChanges(parts, [{ op: 'setAiVisibility', target: { type: 'table', table: 'dim_cust' }, value: 'Visible' }]).parts, { name: 'Sloppy Sales' }));
  assert.equal(withSynonyms.score, without.score, 'a synonym does not change the score');
  assert.ok(!withSynonyms.rules.some((r) => r.ruleId === 'SCH-002' || r.ruleId === 'SCH-003'), 'the synonym rules are gone');
  assert.ok(!withSynonyms.findings.some((f) => /synonym/i.test(f.message) || f.fixKind === 'add-synonyms'), 'no finding asks for synonyms');
  assert.ok(withSynonyms.findings.some((f) => f.ruleId === 'NAM-001' && f.objectPath === 'dim_cust'), 'a synonym does not excuse a technical table name');

  const proposed = await proposeFixes({ parts: seeded, name: 'Sloppy Sales' });
  assert.ok(!proposed.proposals.some((p) => /synonym/i.test(p.id) || p.changes.some((c) => c.op === 'setSynonyms')), 'no synonym proposals');

  const applied = applyProposals({ parts: seeded, name: 'Sloppy Sales' }, proposed.proposals);
  const kept = JSON.parse(applied.parts[PART.schema]).tables.find((t) => t.name === 'dim_cust');
  assert.deepEqual(kept.synonyms, ['Client', 'Customers'], 'existing synonyms survive a write');
});

test('description proposals also cover hidden tables, columns and measures, but not the auto date tables Power BI generates', async () => {
  const T = '\t';
  const hidden = applyChanges(parts, [
    { op: 'setHidden', target: { type: 'column', table: 'dim_cust', name: 'cust_id' }, value: true },
    { op: 'setHidden', target: { type: 'measure', table: 'fact_sales_tbl', name: 'margin' }, value: true },
    { op: 'setHidden', target: { type: 'table', table: 'dim_prod' }, value: true },
  ]).parts;
  hidden['definition/tables/LocalDateTable_1a2b.tmdl'] = ['table LocalDateTable_1a2b', `${T}isHidden`, '', `${T}column Date`, `${T}${T}dataType: dateTime`, `${T}${T}sourceColumn: Date`, ''].join('\n');
  assert.ok(buildSnapshot(hidden, { name: 'm' }).tables.some((t) => t.name === 'LocalDateTable_1a2b'), 'fixture has an auto date table');

  const out = await proposeFixes({ parts: hidden, name: 'Sloppy Sales' });
  const targets = (id) => out.proposals.find((p) => p.id === id).changes.map((c) => `${c.target.table}|${c.target.name ?? ''}`);
  assert.ok(targets('fix:describe-columns').includes('dim_cust|cust_id'), 'hidden column');
  assert.ok(targets('fix:describe-columns').includes('dim_prod|prod_nm'), 'column of a hidden table');
  assert.ok(targets('fix:describe-measures').includes('fact_sales_tbl|margin'), 'hidden measure');
  assert.ok(targets('fix:describe-tables').includes('dim_prod|'), 'hidden table');
  const all = out.proposals.flatMap((p) => p.changes).filter((c) => c.op === 'setDescription');
  assert.ok(!all.some((c) => c.target.table.startsWith('LocalDateTable_')), 'auto date tables are left alone');
  assert.match(out.proposals.find((p) => p.id === 'fix:describe-columns').summary, /\d+ of them hidden/);

  const applied = applyProposals({ parts: hidden, name: 'Sloppy Sales' }, out.proposals);
  assert.equal(applied.skipped.length, 0);
  const after = buildSnapshot(applied.parts, { name: 'Sloppy Sales' });
  const blank = (s) => !s || !s.trim();
  for (const t of after.tables.filter((x) => !x.name.startsWith('LocalDateTable_'))) {
    assert.ok(!blank(t.description), `table ${t.name}`);
    for (const c of t.columns) assert.ok(!blank(c.description), `${t.name}.${c.name}`);
    for (const m of t.measures) assert.ok(!blank(m.description), `${t.name}[${m.name}]`);
  }
  assert.ok(after.tables.find((t) => t.name === 'dim_prod').isHidden, 'hidden stays hidden');
});

test('the score is the same whether or not hidden objects have descriptions', async () => {
  const hidden = applyChanges(parts, [{ op: 'setHidden', target: { type: 'column', table: 'dim_cust', name: 'cust_id' }, value: true }]).parts;
  const described = applyChanges(hidden, [{ op: 'setDescription', target: { type: 'column', table: 'dim_cust', name: 'cust_id' }, value: 'Technical key of the customer used to join related tables.' }]).parts;
  assert.equal(scoreModel(buildSnapshot(described, { name: 'm' })).score, scoreModel(buildSnapshot(hidden, { name: 'm' })).score);
});

test('Copilot parts ship with version markers and a pbism new enough for the service to keep them', () => {
  const { parts: out } = applyChanges(parts, [{ op: 'setInstructions', value: '# hi' }]);
  assert.ok(Number.parseFloat(JSON.parse(out[PART.pbism]).version) >= 5);
  assert.ok(out['Copilot/version.json']);
  assert.ok(out['Copilot/Instructions/version.json']);
  assert.ok(JSON.parse(out['Copilot/version.json']).$schema);
});

test('proposals are produced, ranked and lift the sample to AI-ready', async () => {
  const out = await proposeFixes({ parts, name: 'Sloppy Sales' });
  assert.ok(out.proposals.length >= 10);
  const gains = out.proposals.map((p) => p.estimatedGain);
  assert.deepEqual(gains, [...gains].sort((a, b) => b - a), 'sorted by gain');
  assert.ok(out.proposals.every((p) => p.changes.length > 0));
  const applied = applyProposals({ parts, name: 'Sloppy Sales' }, out.proposals);
  assert.equal(applied.skipped.length, 0);
  assert.ok(applied.score.score >= 85, `score ${applied.score.score}`);
  assert.equal(applied.score.tier, 'AI-ready');
});

test('an existing key column is never changed: the date table is then left for a person to mark', async () => {
  const keyed = applyChanges(parts, [{ op: 'setProperty', target: { type: 'column', table: 'dim_date', name: 'yr' }, property: 'isKey', value: 'true' }]).parts;
  const keysOf = (p) => buildSnapshot(p, { name: 'Sloppy Sales' }).tables.find((t) => t.name === 'dim_date').columns.filter((c) => c.isKey).map((c) => c.name);
  assert.deepEqual(keysOf(keyed), ['yr'], 'fixture starts with a surrogate key');

  const out = await proposeFixes({ parts: keyed, name: 'Sloppy Sales' });
  assert.equal(out.proposals.find((p) => p.id === 'fix:mark-date-table'), undefined, 'no date table proposal');
  const finding = out.score.findings.find((f) => f.ruleId === 'FND-004');
  assert.equal(finding.fixKind, 'manual');
  assert.match(finding.message, /already has key column "yr", which is left unchanged/);

  const applied = applyProposals({ parts: keyed, name: 'Sloppy Sales' }, out.proposals);
  assert.equal(applied.skipped.length, 0);
  assert.deepEqual(keysOf(applied.parts), ['yr'], 'the existing key is untouched');
  assert.ok(!applied.parts['definition/tables/dim_date.tmdl'].includes('dataCategory'), 'the table is not marked');

  const plain = (await proposeFixes({ parts, name: 'Sloppy Sales' })).proposals.find((p) => p.id === 'fix:mark-date-table');
  assert.ok(plain, 'a date table without a key is still proposed');
  assert.equal(plain.changes.length, 2);
});

test('applying proposals twice is idempotent', async () => {
  const first = await proposeFixes({ parts, name: 'Sloppy Sales' });
  const a = applyProposals({ parts, name: 'Sloppy Sales' }, first.proposals);
  const second = await proposeFixes({ parts: a.parts, name: 'Sloppy Sales' });
  const b = applyProposals({ parts: a.parts, name: 'Sloppy Sales' }, second.proposals);
  assert.ok(b.score.score >= a.score.score);
  assert.equal(b.parts['definition/tables/fact_sales_tbl.tmdl'].split('measure ').length, a.parts['definition/tables/fact_sales_tbl.tmdl'].split('measure ').length, 'no duplicate measures');
});

test('model call failures say what to change', async () => {
  const { AzureOpenAiClient } = await import('../dist/index.js');
  const failing = (status, body) =>
    new AzureOpenAiClient({
      endpoint: 'https://foundry.cognitiveservices.azure.com',
      deployment: 'gpt-4.1',
      getToken: async () => 't',
      fetchImpl: async () => new Response(body, { status }),
    });
  await assert.rejects(failing(401, '{"error":{"code":"PermissionDenied"}}').complete({ system: 's', user: 'u' }), /foundry\.cognitiveservices\.azure\.com.*Cognitive Services OpenAI User/s);
  await assert.rejects(failing(404, '{"error":{"code":"DeploymentNotFound"}}').complete({ system: 's', user: 'u' }), /"gpt-4\.1" was not found.*AOAI_ENDPOINT/s);
  await assert.rejects(failing(500, 'oops').complete({ system: 's', user: 'u' }), /LLM call failed \(500\): oops/);
});

test('model client adapts to reasoning models and honours the API version', async () => {
  const { AzureOpenAiClient } = await import('../dist/index.js');
  const calls = [];
  const reasoning = (apiVersion) =>
    new AzureOpenAiClient({
      endpoint: 'https://foundry.openai.azure.com/',
      deployment: 'my-o4-mini',
      apiVersion,
      getToken: async () => 't',
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        if ('max_tokens' in body) {
          return new Response('{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead."}}', { status: 400 });
        }
        if ('temperature' in body) {
          return new Response('{"error":{"message":"Unsupported value: \'temperature\' does not support 0.2 with this model."}}', { status: 400 });
        }
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }), { status: 200 });
      },
    });

  const client = reasoning('2025-04-01-preview');
  assert.equal(await client.complete({ system: 's', user: 'u', maxTokens: 1500, temperature: 0 }), '{"ok":true}');
  const last = calls.at(-1);
  assert.match(last.url, /\/openai\/deployments\/my-o4-mini\/chat\/completions\?api-version=2025-04-01-preview$/);
  assert.equal(last.body.max_completion_tokens, 6000, 'the budget is multiplied for hidden reasoning');
  assert.ok(!('max_tokens' in last.body) && !('temperature' in last.body));

  const before = calls.length;
  await client.complete({ system: 's', user: 'u' });
  assert.equal(calls.length, before + 1, 'the learned options are reused without another failed call');

  calls.length = 0;
  await reasoning(undefined).complete({ system: 's', user: 'u' });
  assert.match(calls[0].url, /api-version=2024-10-21$/, 'the default API version is unchanged');
});

test('model client explains an empty reasoning answer and an unknown 400', async () => {
  const { AzureOpenAiClient } = await import('../dist/index.js');
  const make = (fetchImpl) => new AzureOpenAiClient({ endpoint: 'https://f.openai.azure.com', deployment: 'o3', getToken: async () => 't', fetchImpl });
  await assert.rejects(
    make(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] }), { status: 200 })).complete({ system: 's', user: 'u' }),
    /whole output budget.*gpt-4\.1/s,
  );
  await assert.rejects(
    make(async () => new Response('{"error":{"message":"Unrecognized request argument supplied: max_completion_tokens"}}', { status: 400 })).complete({ system: 's', user: 'u' }),
    /AOAI_API_VERSION/,
  );
  let n = 0;
  await assert.rejects(
    make(async () => {
      n++;
      return new Response('{"error":{"message":"bad request"}}', { status: 400 });
    }).complete({ system: 's', user: 'u' }),
    /LLM call failed \(400\)/,
  );
  assert.equal(n, 1, 'an unrelated 400 is not retried');
});

test('LLM failure falls back to templates', async () => {
  const llm = {
    complete: async () => {
      throw new Error('boom');
    },
  };
  const out = await proposeFixes({ parts, name: 'Sloppy Sales', llm });
  assert.ok(out.notes.some((n) => n.includes('boom')));
  assert.ok(out.proposals.length >= 10);
});

const CONTEXT = 'Retail sales for the EMEA region.\nOrders means completed orders only.\nThe fiscal year starts in July.';
const instructionsOf = (out) => out.proposals.flatMap((p) => p.changes).find((c) => c.op === 'setInstructions')?.value;

test('the context description grounds the template instructions word for word', async () => {
  const withContext = await proposeFixes({ parts, name: 'Sloppy Sales', context: { description: CONTEXT } });
  const text = instructionsOf(withContext);
  assert.ok(text, 'instructions are proposed');
  assert.match(text, /- Retail sales for the EMEA region\./);
  assert.match(text, /- Orders means completed orders only\./);
  assert.match(text, /- The fiscal year starts in July\./);
  assert.doesNotMatch(text, /This model supports business analysis/);
  assert.match(withContext.proposals.find((p) => p.changes.some((c) => c.op === 'setInstructions')).summary, /grounded in your context description/);

  const without = instructionsOf(await proposeFixes({ parts, name: 'Sloppy Sales' }));
  assert.match(without, /This model supports business analysis/);
});

test('the context description reaches every AI drafting prompt', async () => {
  const seen = [];
  const llm = {
    complete: async ({ user }) => {
      seen.push(user);
      return '{}';
    },
  };
  await proposeFixes({ parts, name: 'Sloppy Sales', llm, context: { description: CONTEXT } });
  assert.ok(seen.length >= 1, 'the model was called');
  assert.ok(seen.every((u) => u.includes('Orders means completed orders only.')), 'every prompt carries the description');
});

test('the interview asks one question at a time and finishes with a summary', async () => {
  const { llmInterview, INTERVIEW_MAX_QUESTIONS, CONTEXT_TEXT_MAX } = await import('../dist/index.js');
  const calls = [];
  // `question` answers a "next question" step, `summary` answers the closing step. Each call is recorded.
  const agent = ({ question = { done: false, question: 'Next?' }, summary = { done: true, question: '', summary: 'Final text.' } } = {}) => {
    calls.length = 0;
    return {
      complete: async ({ user, system, maxTokens }) => {
        const parsed = JSON.parse(user);
        const closing = parsed.task.startsWith('The interview is over');
        calls.push({ user: parsed, system, maxTokens, closing });
        return JSON.stringify(closing ? summary : question);
      },
    };
  };
  const model = snap();

  const first = await llmInterview(agent({ question: { done: false, question: '  Who  uses\nthis model?  ' } }), model, { turns: [] });
  assert.equal(first.done, false);
  assert.equal(first.question, 'Who uses this model?');
  assert.equal(first.answered, 0);
  assert.equal(first.maxQuestions, INTERVIEW_MAX_QUESTIONS);
  assert.ok(calls[0].user.model.tables.length > 0, 'the model overview is sent');

  const turns = [{ question: 'Who uses this model?', answer: 'Regional sales managers' }];
  const next = await llmInterview(agent({ question: { done: false, question: 'Which measure matters most?' } }), model, { turns, existing: 'Retail sales.' });
  assert.equal(next.done, false);
  assert.equal(next.summary, 'Retail sales.', 'a running interview hands back the text it started with');
  assert.equal(calls.length, 1, 'a step that asks a question makes one model call');
  assert.ok(calls[0].maxTokens <= 500, `a question step is small, not ${calls[0].maxTokens} tokens`);
  assert.doesNotMatch(calls[0].user.task, /summary: the context description/, 'no summary is requested while the interview runs');
  assert.equal(calls[0].user.existingDescription, 'Retail sales.');
  assert.deepEqual(calls[0].user.interview, turns);

  const wrapped = await llmInterview(agent({ question: { done: false, question: 'One more?' } }), model, { turns, finish: true });
  assert.equal(wrapped.done, true, 'finish forces the summary even if the model wants to continue');
  assert.equal(wrapped.question, null);
  assert.equal(wrapped.summary, 'Final text.');
  assert.equal(calls.length, 1, 'finishing skips the question call');
  assert.ok(calls[0].closing);
  assert.ok(calls[0].maxTokens >= 1500, 'the closing step has room for the whole description');

  const many = Array.from({ length: INTERVIEW_MAX_QUESTIONS }, (_, i) => ({ question: `Q${i}`, answer: 'a' }));
  assert.equal((await llmInterview(agent(), model, { turns: many })).done, true, 'the question limit forces the summary');

  const modelDone = await llmInterview(agent({ question: { done: true, question: '' }, summary: { done: true, question: '', summary: 'Written at the end.' } }), model, { turns });
  assert.equal(modelDone.done, true, 'the model can end the interview early');
  assert.equal(modelDone.summary, 'Written at the end.');
  assert.deepEqual(calls.map((c) => c.closing), [false, true], 'it asks first, then writes the description');

  const noQuestion = await llmInterview(agent({ question: { done: false, question: '' } }), model, { turns });
  assert.equal(noQuestion.done, true, 'no question means the interview is over');
  assert.equal(calls.length, 2);

  const long = await llmInterview(agent({ summary: { done: true, question: '', summary: 'x'.repeat(CONTEXT_TEXT_MAX + 500) } }), model, { turns, finish: true });
  assert.equal(long.summary.length, CONTEXT_TEXT_MAX);

  await assert.rejects(llmInterview(agent({ summary: { done: true, question: '', summary: '' } }), model, { turns, finish: true }), /no summary/);
});

test('a Fabric long-running operation is polled quickly, not after the full retry-after hint', async () => {
  const { FabricClient } = await import('../dist/index.js');
  const started = Date.now();
  const polls = [];
  const fetchImpl = async (url) => {
    const target = String(url).split('?')[0];
    if (target.endsWith('/getDefinition')) {
      return new Response(null, { status: 202, headers: { location: 'https://api.fabric.microsoft.com/v1/operations/op1', 'retry-after': '20' } });
    }
    if (target.endsWith('/operations/op1')) {
      polls.push(Date.now() - started);
      return new Response(JSON.stringify({ status: polls.length < 3 ? 'Running' : 'Succeeded' }), { status: 200, headers: { 'content-type': 'application/json', 'retry-after': '20' } });
    }
    if (target.endsWith('/operations/op1/result')) {
      return new Response(JSON.stringify({ definition: { parts: [{ path: 'definition.pbism', payload: Buffer.from('{}').toString('base64'), payloadType: 'InlineBase64' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected request ${target}`);
  };
  const client = new FabricClient({ getToken: async () => 'token', fetchImpl, lroPollMs: 5 });
  const definition = await client.getDefinition('ws', 'model');
  assert.ok(definition['definition.pbism'], 'the exported part is returned');
  assert.equal(polls.length, 3, 'the operation was polled until it finished');
  assert.ok(Date.now() - started < 3000, `it did not sit out the 20 s hint (took ${Date.now() - started} ms)`);
});

test('agent availability: eligible SKUs and tenant switches', async () => {
  const { evaluateAgentAvailability, isCopilotEligibleSku, buildSnapshot, sloppySalesModel } = await import('../dist/index.js');
  assert.equal(isCopilotEligibleSku('F64'), true);
  assert.equal(isCopilotEligibleSku('F2'), true);
  assert.equal(isCopilotEligibleSku('F1'), false);
  assert.equal(isCopilotEligibleSku('FTL64'), false);
  assert.equal(isCopilotEligibleSku('PP3'), false);
  assert.equal(isCopilotEligibleSku('P1'), true);
  const snapshot = buildSnapshot(sloppySalesModel(), { name: 'x' });
  const off = [
    { settingName: 'EnableAOAI', title: 't', enabled: false },
    { settingName: 'ImmersiveTenantAdminSwitch', title: 't', enabled: true },
    { settingName: 'PowerBIMCP', title: 't', enabled: true },
    { settingName: 'PreppedForCopilotContentDiscovery', title: 't', enabled: true },
  ];
  const r = evaluateAgentAvailability({ workspaceId: 'w', modelId: 'm', snapshot, tenantSettings: off, capacity: { id: 'c', displayName: 'cap', sku: 'F64', state: 'Active' } });
  assert.equal(r.checks.find((c) => c.id === 'TEN-001').status, 'fail');
  assert.equal(r.checks.find((c) => c.id === 'TEN-004').status, 'fail');
  assert.equal(r.checks.find((c) => c.id === 'WSP-001').status, 'pass');
  assert.equal(r.surfaces.find((s) => s.surface === 'copilot').status, 'fail');
  assert.equal(r.surfaces.find((s) => s.surface === 'mcp').status, 'warn');
  const unknown = evaluateAgentAvailability({ workspaceId: 'w', modelId: 'm', snapshot });
  assert.equal(unknown.tenantSettingsReadable, false);
  assert.equal(unknown.checks.find((c) => c.id === 'TEN-001').status, 'unknown');
});

test('proposal validation rejects unsafe or malformed changes', async () => {
  const { validateProposals } = await import('../dist/index.js');
  const good = { id: 'p1', ruleIds: ['DSC-001'], title: 't', summary: 's', risk: 'low', requiresReview: false, generatedBy: 'rule', changes: [{ op: 'setDescription', target: { type: 'table', table: 'Sales' }, value: 'Line one\nLine two' }] };
  assert.equal(validateProposals([good]).ok, true);
  assert.equal(validateProposals([]).ok, false);
  const bad = (change) => validateProposals([{ ...good, changes: [change] }]);
  assert.equal(bad({ op: 'rename', target: { type: 'table', table: 'A' }, value: 'B' }).ok, false);
  assert.equal(bad({ op: 'setProperty', target: { type: 'table', table: 'A' }, property: 'expression', value: 'x' }).ok, false);
  assert.equal(bad({ op: 'setProperty', target: { type: 'column', table: 'A', name: 'c' }, property: 'formatString', value: '0\n\tisHidden' }).ok, false);
  assert.equal(bad({ op: 'setDescription', target: { type: 'column', table: 'A' }, value: 'x' }).ok, false);
  assert.equal(bad({ op: 'setSynonyms', target: { type: 'table', table: 'A' }, value: ['x'] }).ok, false, 'synonyms can no longer be written');
  assert.equal(bad({ op: 'drop', target: { type: 'table', table: 'A' } }).ok, false);
  const clean = validateProposals([{ ...good, extra: 'ignored', changes: [{ ...good.changes[0], extra: 1 }] }]);
  assert.equal(clean.ok, true);
  assert.equal('extra' in clean.proposals[0], false);
});