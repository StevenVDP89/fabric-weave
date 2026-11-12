import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyProposals, buildSnapshot, proposeFixes, sloppySalesModel } from '../dist/index.js';
import {
  DESCRIPTION_PROBLEM_MESSAGE,
  DUPLICATE_DESCRIPTION_LIMIT,
  descriptionProblem,
  evaluateRules,
  foldWord,
  isInformative,
  normalizeDescription,
  wordsOf,
} from '../dist/rules.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const col = (name, description, extra = {}) => ({
  name,
  dataType: 'string',
  description,
  isHidden: false,
  isCalculated: false,
  isKey: false,
  synonyms: [],
  ...extra,
});
const measure = (name, description, extra = {}) => ({ name, expression: 'SUM(T[x])', description, isHidden: false, synonyms: [], ...extra });
const table = (name, columns, measures = [], extra = {}) => ({
  name,
  isHidden: false,
  isCalculatedTable: false,
  columns,
  measures,
  hierarchies: [],
  synonyms: [],
  ...extra,
});
const snapshot = ({ tables = [], instructions } = {}) => ({
  name: 'Test model',
  discourageImplicitMeasures: false,
  tables,
  relationships: [],
  copilot: { instructions, hasSchema: false, examplePrompts: [], verifiedAnswerCount: 0 },
  governance: {},
  metadataOnly: false,
});
const rule = (snap, id) => evaluateRules(snap).find((r) => r.ruleId === id);
const ins = (text, id) => rule(snapshot({ instructions: text }), id);

// ---------------------------------------------------------------------------
// isInformative: placeholders
// ---------------------------------------------------------------------------

test('placeholder descriptions are not informative', () => {
  const placeholders = [
    'TBD',
    'tbd',
    'TBD item here',
    'TBA',
    'n/a',
    'N/A',
    'NA',
    'none',
    'None.',
    'TODO',
    'todo: write this later',
    'To do',
    'lorem ipsum dolor sit amet',
    'Lorem Ipsum',
    'Description',
    'desc',
    'Enter description',
    'add description here',
    'To be defined',
    'to be determined',
    'To be completed',
    'to be added later on',
    'Coming soon',
    'placeholder text for this column',
    'Test',
    'xxx',
    'xxxxxxxx',
    '...',
    '---',
    'Amount to be determined by finance',
  ];
  for (const text of placeholders) {
    assert.equal(isInformative('Sales Amount', text), false, `"${text}" should be rejected`);
    assert.equal(descriptionProblem('Sales Amount', text), 'placeholder', `"${text}" should be a placeholder`);
  }
});

test('too short descriptions are still rejected', () => {
  assert.equal(descriptionProblem('Sales Amount', 'Amount'), 'short');
  assert.equal(descriptionProblem('Sales Amount', 'Money value'), 'short');
  assert.equal(isInformative('Sales Amount', 'ab cd'), false);
});

test('words that merely contain a placeholder are not rejected', () => {
  assert.equal(isInformative('Order Status', 'Contest participation flag recorded at checkout.'), true);
  assert.equal(isInformative('Customer Segment', 'Commercial grouping used for pricing: consumer, business or public sector.'), true);
  assert.equal(isInformative('Ship Date', 'Day the parcel left the warehouse, none if it has not shipped yet.'), true);
});

// ---------------------------------------------------------------------------
// isInformative: restating the name
// ---------------------------------------------------------------------------

test('text that only restates the object name is not informative', () => {
  const restating = [
    ['Customer Name', 'Name of each customer'],
    ['customerName', 'The customer name'],
    ['customer_name', 'Name for every customer'],
    ['Order Lines', 'Each order line of the orders'],
    ['Total Sales', 'Total of all sales'],
    ['Customers', 'The table of the customers'],
    ['order_id', 'Order ID of the order'],
    ['Sales Amount', 'The sales amount.'],
  ];
  for (const [name, text] of restating) {
    assert.equal(descriptionProblem(name, text), 'restates-name', `"${text}" restates "${name}"`);
    assert.equal(isInformative(name, text), false);
  }
});

test('text that adds information beyond the name is informative', () => {
  const good = [
    ['Sales Amount', 'Sales amount of each sales record, excluding VAT and shipping.'],
    ['Customer Name', 'Legal name used on invoices to the buyer.'],
    ['cust_nm', 'Legal name of the buyer as printed on the invoice.'],
    ['Churn Rate', 'Share of subscribers who cancelled during the period, divided by subscribers at its start.'],
    ['Net Revenue', 'Revenue after returns and discounts, before tax, in the reporting currency.'],
    ['Region', 'Sales region that owns the customer account.'],
  ];
  for (const [name, text] of good) assert.equal(descriptionProblem(name, text), null, `"${text}" should be accepted for "${name}"`);
});

test('name comparison splits camelCase and snake_case and folds plurals', () => {
  assert.deepEqual(wordsOf('customerName'), ['customer', 'name']);
  assert.deepEqual(wordsOf('order_line_items'), ['order', 'line', 'items']);
  assert.deepEqual(wordsOf('Gross Margin %'), ['gross', 'margin']);
  assert.equal(foldWord('customers'), 'customer');
  assert.equal(foldWord('categories'), 'category');
  assert.equal(foldWord('addresses'), 'address');
  assert.equal(foldWord('status'), 'statu');
  assert.equal(foldWord('class'), 'class');
  assert.equal(normalizeDescription('  Used for, REPORTING!! '), 'used for reporting');
});

// ---------------------------------------------------------------------------
// isInformative: duplicated boilerplate
// ---------------------------------------------------------------------------

test('boilerplate repeated on at least five objects of a kind is not informative', () => {
  const text = 'Reference text maintained by the fulfilment team each night.';
  assert.equal(DUPLICATE_DESCRIPTION_LIMIT, 5);
  assert.equal(isInformative('Channel', text, 1), true);
  assert.equal(isInformative('Channel', text, 4), true);
  assert.equal(descriptionProblem('Channel', text, 5), 'duplicate');
  assert.equal(isInformative('Channel', text, 40), false);
});

test('DSC-004 flags boilerplate duplicated on five columns but not on four', () => {
  const boilerplate = 'This column is used for reporting purposes in the model.';
  const names = ['Channel', 'Priority', 'Carrier', 'Warehouse', 'Currency'];
  const five = snapshot({ tables: [table('Orders', names.map((n) => col(n, boilerplate)))] });
  const r5 = rule(five, 'DSC-004');
  assert.equal(r5.findings.length, 5);
  assert.equal(r5.score, 0);
  assert.ok(r5.findings.every((f) => f.message === DESCRIPTION_PROBLEM_MESSAGE.duplicate));

  const four = snapshot({ tables: [table('Orders', names.slice(0, 4).map((n) => col(n, boilerplate)))] });
  assert.equal(rule(four, 'DSC-004').findings.length, 0);
  assert.equal(rule(four, 'DSC-004').score, 1);
});

test('duplicate counts are per kind of object, per normalised text, and ignore hidden objects', () => {
  const text = 'Calculated value used in dashboards and reports.';
  const cols = ['Alpha', 'Beta', 'Gamma'].map((n) => col(n, text));
  const measures = ['Delta', 'Epsilon'].map((n) => measure(n, text.toUpperCase()));
  const mixed = rule(snapshot({ tables: [table('T', cols, measures)] }), 'DSC-004');
  assert.equal(mixed.findings.length, 0, '3 columns + 2 measures are different kinds');

  const hiddenCols = ['Alpha', 'Beta', 'Gamma'].map((n) => col(n, text, { isHidden: true }));
  const withHidden = rule(snapshot({ tables: [table('T', [...cols.slice(0, 4), ...hiddenCols.slice(0, 2)])] }), 'DSC-004');
  assert.equal(withHidden.findings.length, 0, 'hidden columns are not in AI scope and do not count');

  const variants = ['Calculated value used in dashboards and reports.', 'calculated value used in dashboards and reports', 'Calculated  value used in dashboards, and reports!'];
  const five = ['A1', 'B1', 'C1', 'D1', 'E1'].map((n, i) => col(n, variants[i % variants.length]));
  assert.equal(rule(snapshot({ tables: [table('T', five)] }), 'DSC-004').findings.length, 5, 'case and punctuation do not hide duplicates');
});

test('DSC-004 reports the reason for each rejected description', () => {
  const snap = snapshot({
    tables: [
      table('Orders', [
        col('Order Status', 'TBD'),
        col('Customer Name', 'Name of each customer'),
        col('Amount', 'Net revenue of the order line in US dollars.'),
        col('Qty', 'Few'),
      ]),
    ],
  });
  const messages = Object.fromEntries(rule(snap, 'DSC-004').findings.map((f) => [f.objectPath, f.message]));
  assert.equal(messages['Orders.Order Status'], DESCRIPTION_PROBLEM_MESSAGE.placeholder);
  assert.equal(messages['Orders.Customer Name'], DESCRIPTION_PROBLEM_MESSAGE['restates-name']);
  assert.equal(messages['Orders.Qty'], DESCRIPTION_PROBLEM_MESSAGE.short);
  assert.equal(messages['Orders.Amount'], undefined);
});

test('DSC-004 stays linear on large models', () => {
  const columns = Array.from({ length: 4000 }, (_, i) => col(`Column ${i}`, `Distinct explanation number ${i} of what this field holds for the business.`));
  const tables = Array.from({ length: 5 }, (_, i) => table(`Table ${i}`, columns.slice(i * 800, (i + 1) * 800)));
  const started = Date.now();
  const r = rule(snapshot({ tables }), 'DSC-004');
  assert.equal(r.findings.length, 0);
  assert.ok(Date.now() - started < 5000, 'evaluation of 4000 columns finishes well within five seconds');
});

// ---------------------------------------------------------------------------
// INS-002: length is not enough
// ---------------------------------------------------------------------------

const GOOD_INSTRUCTIONS = [
  'This model describes retail sales for the European stores of the company. Revenue means net invoiced amounts after returns and before tax.',
  'Unless the user names another period, answer for the current fiscal year, which starts on the first of July.',
  'Always use the measure Total Sales for revenue questions and the measure Average Order Value for basket questions.',
  'A customer is active when they placed an order in the last twelve months. Regions follow the sales organisation, not the shipping address.',
].join(' ');

test('INS-002 accepts a genuine, varied paragraph', () => {
  const r = ins(GOOD_INSTRUCTIONS, 'INS-002');
  assert.equal(r.score, 1, r.evidence);
  assert.equal(r.findings.length, 0);
});

test('INS-002 rejects long but repetitive filler', () => {
  const filler = 'Use this model to answer questions. '.repeat(20);
  assert.ok(filler.length >= 300);
  const r = ins(filler, 'INS-002');
  assert.ok(r.score < 0.5, `score ${r.score}`);
  assert.equal(r.findings.length, 1);
  assert.match(r.evidence, /distinct word/);
});

test('INS-002 needs at least 40 distinct words', () => {
  const words = (n) => Array.from({ length: n }, (_, i) => `concept${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`);
  const padded = (distinct) => {
    const w = words(distinct);
    const out = [];
    while (out.length < 100) out.push(...w);
    return out.slice(0, 100).join(' ');
  };
  assert.equal(ins(padded(40), 'INS-002').score, 1, '40 distinct words in 100 (ratio 0.4) is enough');
  const short = ins(padded(39), 'INS-002');
  assert.ok(short.score < 0.5, `39 distinct words: ${short.score}`);
});

test('INS-002 needs a distinct-to-total word ratio of at least 0.35', () => {
  const unique = Array.from({ length: 45 }, (_, i) => `topic${i}`).join(' ');
  const filler = ' again and again'.repeat(100);
  const r = ins(unique + filler, 'INS-002');
  assert.ok(r.score < 0.5, `score ${r.score}`);
  assert.match(r.evidence, /distinct word/);
  assert.equal(ins(unique + ' again and again'.repeat(10), 'INS-002').score, 1, 'a little repetition is fine');
});

test('INS-002 keeps its length rules', () => {
  assert.equal(ins('', 'INS-002').score, 0);
  const short = ins('Revenue means net sales.', 'INS-002');
  assert.ok(short.score > 0 && short.score < 0.2);
  const long = ins(GOOD_INSTRUCTIONS + ' ' + 'x'.repeat(10000), 'INS-002');
  assert.equal(long.score, 0.5);
});

test('INS-001 is unchanged: any non-blank text counts', () => {
  assert.equal(ins('x', 'INS-001').score, 1);
  assert.equal(ins('   \n ', 'INS-001').score, 0);
});

// ---------------------------------------------------------------------------
// INS-003: a heading alone does not count
// ---------------------------------------------------------------------------

test('INS-003 does not count section headings without content', () => {
  const headingsOnly = '# Business context\n\n# Terminology\n\n# Defaults\n\n# Preferred measures\n';
  const r = ins(headingsOnly, 'INS-003');
  assert.equal(r.score, 0, r.evidence);
  assert.equal(r.findings.length, 4);
});

test('INS-003 does not count a heading with only a few words below it', () => {
  const thin = '# Business context\nRetail sales.\n\n# Terminology\n- Net sales\n\n## Preferred measures\n';
  assert.equal(ins(thin, 'INS-003').score, 0);
});

test('INS-003 counts a heading followed by at least eight words', () => {
  const text = '# Business context\nRetail sales analysis for the European stores covering orders, returns and refunds each day.\n';
  const r = ins(text, 'INS-003');
  assert.equal(r.score, 0.25, r.evidence);
  assert.equal(r.findings.length, 3);
  assert.ok(!r.findings.some((f) => f.data?.missing === 'context'));
});

test('INS-003 counts a heading followed by at least two bullets', () => {
  const text = '## Terminology\n- Net sales: sales after returns\n- Churn: lost customers\n';
  const r = ins(text, 'INS-003');
  assert.equal(r.score, 0.25, r.evidence);
  const one = ins('## Terminology\n- Net sales: sales after returns\n', 'INS-003');
  assert.equal(one.score, 0);
});

test('INS-003 counts a keyword in prose only when enough words follow it', () => {
  assert.equal(ins('By default, show the current year unless the user asks for another period of time in the question.', 'INS-003').score, 0.25);
  assert.equal(ins('Default is the current year.', 'INS-003').score, 0);
});

test('INS-003 recognises plain and bold headings and all four topics', () => {
  const text = [
    '**Business context**',
    'Retail sales analysis for the European stores covering orders, returns and refunds each day.',
    '',
    'Terminology',
    '- Net sales are sales after returns',
    '- Active customers ordered within a year',
    '',
    '## Defaults',
    'Unless told otherwise, show the current fiscal year to date in euros for all stores.',
    '',
    '### Preferred measures',
    'Always use Total Sales for revenue and Average Order Value for basket size questions.',
  ].join('\n');
  const r = ins(text, 'INS-003');
  assert.equal(r.score, 1, r.evidence);
});

// ---------------------------------------------------------------------------
// The tool's own generated text must keep scoring as informative
// ---------------------------------------------------------------------------

test('generated template descriptions and instructions pass the stricter rules', async () => {
  const parts = sloppySalesModel();
  const out = await proposeFixes({ parts, name: 'Sloppy Sales' });
  const applied = applyProposals({ parts, name: 'Sloppy Sales' }, out.proposals);
  assert.equal(applied.skipped.length, 0);
  const byId = Object.fromEntries(applied.score.rules.map((r) => [r.ruleId, r]));
  assert.equal(byId['DSC-004'].score, 1, byId['DSC-004'].evidence);
  assert.equal(byId['INS-002'].score, 1, byId['INS-002'].evidence);
  assert.equal(byId['INS-003'].score, 1, byId['INS-003'].evidence);
  const snap = buildSnapshot(applied.parts, { name: 'Sloppy Sales' });
  assert.ok(snap.copilot.instructions && snap.copilot.instructions.length >= 300);
});
