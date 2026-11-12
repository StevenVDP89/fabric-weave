/** Naming heuristics shared by the rules and the deterministic fix generators. */

export const ABBREVIATIONS: Record<string, string> = {
  qty: 'Quantity',
  amt: 'Amount',
  cust: 'Customer',
  custs: 'Customers',
  nm: 'Name',
  cd: 'Code',
  desc: 'Description',
  descr: 'Description',
  num: 'Number',
  nbr: 'Number',
  nr: 'Number',
  dt: 'Date',
  ts: 'Timestamp',
  prod: 'Product',
  prd: 'Product',
  cat: 'Category',
  ctgry: 'Category',
  cntry: 'Country',
  ctry: 'Country',
  reg: 'Region',
  rgn: 'Region',
  emp: 'Employee',
  mgr: 'Manager',
  dept: 'Department',
  addr: 'Address',
  tel: 'Telephone',
  pct: 'Percent',
  avg: 'Average',
  cnt: 'Count',
  tot: 'Total',
  src: 'Source',
  tgt: 'Target',
  curr: 'Currency',
  cur: 'Currency',
  ord: 'Order',
  inv: 'Invoice',
  pmt: 'Payment',
  sls: 'Sales',
  rev: 'Revenue',
  cst: 'Cost',
  prc: 'Price',
  yr: 'Year',
  mth: 'Month',
  mon: 'Month',
  wk: 'Week',
  qtr: 'Quarter',
  loc: 'Location',
  seq: 'Sequence',
  flg: 'Flag',
  ind: 'Indicator',
  sts: 'Status',
  stat: 'Status',
  typ: 'Type',
  grp: 'Group',
  lvl: 'Level',
  crt: 'Created',
  upd: 'Updated',
  usr: 'User',
  acct: 'Account',
  bal: 'Balance',
  dscnt: 'Discount',
  disc: 'Discount',
  shp: 'Shipment',
  rcv: 'Received',
  vend: 'Vendor',
  supp: 'Supplier',
  whse: 'Warehouse',
  wh: 'Warehouse',
  mkt: 'Market',
  seg: 'Segment',
  chnl: 'Channel',
  chan: 'Channel',
  org: 'Organization',
  ref: 'Reference',
  val: 'Value',
  bu: 'Business Unit',
  mrg: 'Margin',
  gm: 'Gross Margin',
  tbl: 'Table',
  dim: 'Dimension',
  fct: 'Fact',
};

/** Acronyms that are legitimate in business names. */
const KEEP_UPPER = new Set(['id', 'sku', 'url', 'kpi', 'ytd', 'mtd', 'qtd', 'yoy', 'mom', 'qoq', 'vat', 'gdp', 'roi', 'uk', 'us', 'eu', 'ceo', 'cfo', 'hr', 'it', 'ai', 'api']);

const TABLE_PREFIX = /^(dim|fact|fct|stg|stage|tbl|vw|v|d|f|lkp|ref|bridge)[_\s-]+/i;
const TABLE_SUFFIX = /[_\s-]+(dim|fact|fct|tbl|table|vw|view|lkp|stg)$/i;

export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

export function isTechnicalTableName(name: string): boolean {
  if (TABLE_PREFIX.test(name) || TABLE_SUFFIX.test(name)) return true;
  if (/[_]/.test(name)) return true;
  if (!/\s/.test(name) && /[a-z][A-Z]/.test(name)) return true;
  if (/^[a-z0-9]+$/.test(name) && name.length > 3 && !/\s/.test(name) && tokenize(name).length === 1 && /(tbl|dim|fact)$/.test(name))
    return true;
  return false;
}

export function isTechnicalName(name: string): boolean {
  if (/_/.test(name)) return true;
  if (!/\s/.test(name) && /[a-z][A-Z]/.test(name)) return true;
  if (/^[a-z]+\d*$/.test(name) && ABBREVIATIONS[name.toLowerCase()]) return true;
  if (/^[A-Z0-9]{2,}$/.test(name) && !KEEP_UPPER.has(name.toLowerCase()) && ABBREVIATIONS[name.toLowerCase()]) return true;
  if (/^[a-z0-9]+$/.test(name) && name.length > 2 && !/\s/.test(name) && /\d/.test(name)) return true;
  return false;
}

export function abbreviationsIn(name: string): string[] {
  return tokenize(name)
    .map((t) => t.toLowerCase())
    .filter((t) => ABBREVIATIONS[t] !== undefined && !KEEP_UPPER.has(t));
}

function titleCase(word: string): string {
  const l = word.toLowerCase();
  if (KEEP_UPPER.has(l)) return l.toUpperCase();
  return l.charAt(0).toUpperCase() + l.slice(1);
}

/** Business-friendly rendering of a technical name: dim_cust -> Customer, cust_nm -> Customer Name. */
export function humanize(name: string, kind: 'table' | 'column' | 'measure' = 'column'): string {
  let base = name;
  if (kind === 'table') base = base.replace(TABLE_PREFIX, '').replace(TABLE_SUFFIX, '');
  const tokens = tokenize(base).map((t) => {
    const exp = ABBREVIATIONS[t.toLowerCase()];
    if (exp && t.toLowerCase() !== 'dim' && t.toLowerCase() !== 'tbl' && t.toLowerCase() !== 'fct') return exp;
    return titleCase(t);
  });
  const out = tokens.join(' ').trim();
  return out.length > 0 ? out : name;
}

export function isFriendlyName(name: string): boolean {
  return !isTechnicalName(name) && !/^\s*$/.test(name);
}

export function isKeyLikeName(name: string): boolean {
  const n = name.trim();
  if (/^(id|key|sk|pk|fk|guid|uuid)$/i.test(n)) return true;
  if (/[_\s-](id|key|sk|pk|fk|guid|uuid)$/i.test(n)) return true;
  if (/[a-z](ID|Id|Key|SK|Guid)$/.test(n)) return true;
  if (/^(id|sk|pk|fk)[_-]/i.test(n)) return true;
  return false;
}