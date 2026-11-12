import type { DefinitionParts } from './types.js';

const T = '\t';

/**
 * A deliberately "AI-unready" sales model used for demos, tests and the one-click
 * "Deploy sample model" action. Data is generated in Power Query (no data source or
 * credentials needed). It has technical names, no descriptions, no AI
 * instructions, implicit aggregation, visible keys and a bi-directional relationship.
 */
export function sloppySalesModel(): DefinitionParts {
  const num = (name: string, type: 'int64' | 'double', extra: string[] = []) =>
    [`${T}column ${name}`, `${T}${T}dataType: ${type}`, ...extra.map((e) => `${T}${T}${e}`), `${T}${T}summarizeBy: sum`, `${T}${T}sourceColumn: ${name}`, ''].join('\n');
  const str = (name: string) =>
    [`${T}column ${name}`, `${T}${T}dataType: string`, `${T}${T}summarizeBy: none`, `${T}${T}sourceColumn: ${name}`, ''].join('\n');
  const dt = (name: string) =>
    [`${T}column ${name}`, `${T}${T}dataType: dateTime`, `${T}${T}formatString: Long Date`, `${T}${T}summarizeBy: none`, `${T}${T}sourceColumn: ${name}`, ''].join('\n');
  const partition = (name: string, m: string[]) =>
    [
      `${T}partition ${name} = m`,
      `${T}${T}mode: import`,
      `${T}${T}source =`,
      ...m.map((l) => `${T}${T}${T}${l}`),
      '',
    ].join('\n');

  const custTable = [
    'table dim_cust',
    '',
    num('cust_id', 'int64'),
    str('cust_nm'),
    str('cntry_cd'),
    str('seg'),
    partition('dim_cust', [
      'let',
      '    Source = #table(type table [cust_id = Int64.Type, cust_nm = text, cntry_cd = text, seg = text],',
      '        {{1, "Contoso Retail", "US", "Enterprise"}, {2, "Fabrikam Stores", "UK", "SMB"}, {3, "Northwind Traders", "DE", "Enterprise"},',
      '         {4, "Adventure Works", "US", "Consumer"}, {5, "Tailspin Toys", "FR", "SMB"}, {6, "Wide World Importers", "NL", "Enterprise"}})',
      'in',
      '    Source',
    ]),
  ].join('\n');

  const prodTable = [
    'table dim_prod',
    '',
    num('prod_id', 'int64'),
    str('prod_nm'),
    str('cat'),
    num('list_prc', 'double'),
    partition('dim_prod', [
      'let',
      '    Source = #table(type table [prod_id = Int64.Type, prod_nm = text, cat = text, list_prc = Currency.Type],',
      '        {{1, "Road Bike", "Bikes", 1200}, {2, "Mountain Bike", "Bikes", 1500}, {3, "Helmet", "Accessories", 60},',
      '         {4, "Water Bottle", "Accessories", 12}, {5, "Cycling Jersey", "Clothing", 80}})',
      'in',
      '    Source',
    ]),
  ].join('\n');

  const dateTable = [
    'table dim_date',
    '',
    dt('dt'),
    num('yr', 'int64'),
    num('mth_no', 'int64'),
    str('mth_nm'),
    str('qtr'),
    partition('dim_date', [
      'let',
      '    Dates = List.Dates(#date(2024, 1, 1), 366, #duration(1, 0, 0, 0)),',
      '    T = Table.FromList(Dates, Splitter.SplitByNothing(), type table [dt = date]),',
      '    A = Table.AddColumn(T, "yr", each Date.Year([dt]), Int64.Type),',
      '    B = Table.AddColumn(A, "mth_no", each Date.Month([dt]), Int64.Type),',
      '    C = Table.AddColumn(B, "mth_nm", each Date.MonthName([dt]), type text),',
      '    D = Table.AddColumn(C, "qtr", each "Q" & Text.From(Date.QuarterOfYear([dt])), type text)',
      'in',
      '    D',
    ]),
  ].join('\n');

  const factTable = [
    'table fact_sales_tbl',
    '',
    num('ord_id', 'int64'),
    num('cust_id', 'int64'),
    num('prod_id', 'int64'),
    dt('dt'),
    num('qty', 'int64'),
    num('amt', 'double'),
    num('cost_amt', 'double'),
    num('disc_pct', 'double'),
    `${T}measure tot_amt = SUM(fact_sales_tbl[amt])`,
    `${T}measure tot_qty = SUM(fact_sales_tbl[qty])`,
    `${T}measure margin = SUM(fact_sales_tbl[amt]) - SUM(fact_sales_tbl[cost_amt])`,
    '',
    partition('fact_sales_tbl', [
      'let',
      '    Rows = List.Transform({1..300}, (n) => [',
      '        ord_id = n,',
      '        cust_id = Number.Mod(n * 7, 6) + 1,',
      '        prod_id = Number.Mod(n * 3, 5) + 1,',
      '        dt = Date.AddDays(#date(2024, 1, 1), Number.Mod(n * 11, 366)),',
      '        qty = Number.Mod(n * 5, 9) + 1,',
      '        amt = (Number.Mod(n * 13, 50) + 10) * (Number.Mod(n * 5, 9) + 1),',
      '        cost_amt = (Number.Mod(n * 13, 50) + 6) * (Number.Mod(n * 5, 9) + 1),',
      '        disc_pct = Number.Mod(n, 4) * 0.05',
      '    ]),',
      '    T = Table.FromRecords(Rows, type table [ord_id = Int64.Type, cust_id = Int64.Type, prod_id = Int64.Type, dt = date, qty = Int64.Type, amt = Currency.Type, cost_amt = Currency.Type, disc_pct = Number.Type])',
      'in',
      '    T',
    ]),
  ].join('\n');

  const relationships = [
    'relationship fact_cust',
    `${T}fromColumn: fact_sales_tbl.cust_id`,
    `${T}toColumn: dim_cust.cust_id`,
    '',
    'relationship fact_prod',
    `${T}crossFilteringBehavior: bothDirections`,
    `${T}fromColumn: fact_sales_tbl.prod_id`,
    `${T}toColumn: dim_prod.prod_id`,
    '',
    'relationship fact_date',
    `${T}fromColumn: fact_sales_tbl.dt`,
    `${T}toColumn: dim_date.dt`,
    '',
  ].join('\n');

  return {
    'definition.pbism': JSON.stringify(
      {
        $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json',
        version: '4.2',
        settings: { qnaEnabled: true },
      },
      null,
      2,
    ),
    'definition/database.tmdl': 'database\n\tcompatibilityLevel: 1702\n\tcompatibilityMode: powerBI\n',
    'definition/model.tmdl': [
      'model Model',
      `${T}culture: en-US`,
      `${T}defaultPowerBIDataSourceVersion: powerBI_V3`,
      '',
      'ref table dim_cust',
      'ref table dim_prod',
      'ref table dim_date',
      'ref table fact_sales_tbl',
      '',
    ].join('\n'),
    'definition/relationships.tmdl': relationships,
    'definition/tables/dim_cust.tmdl': custTable,
    'definition/tables/dim_prod.tmdl': prodTable,
    'definition/tables/dim_date.tmdl': dateTable,
    'definition/tables/fact_sales_tbl.tmdl': factTable,
  };
}
