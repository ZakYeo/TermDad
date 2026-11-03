import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fixture = fileURLToPath(new URL('../demo/fixture/', import.meta.url));

const implementations = {
  kpis: `export default data => {
    const revenue = data.months.reduce((sum, month) => sum + month.revenue, 0);
    return [{label:'Revenue',value:revenue,format:'currency'},
      {label:'Customers',value:data.accounts.length,format:'number'},
      {label:'Growth',value:Math.round((revenue-data.previousRevenue)/data.previousRevenue*1000)/10,format:'percent'}];
  };`,
  chart: `export default data => data.months.map(({month,revenue}) => ({month,revenue}));`,
  accounts: `export default data => data.accounts.map(({name,revenue,daysSinceContact}) => ({name,revenue,
    risk:daysSinceContact>=45?'High':daysSinceContact>=30?'Medium':'Low'})).sort((a,b) =>
    ['High','Medium','Low'].indexOf(a.risk)-['High','Medium','Low'].indexOf(b.risk)||a.name.localeCompare(b.name));`,
};

async function copyFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'demo fixture '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, { recursive: true });
  return root;
}

function check(root: string, ticket?: string) {
  return spawnSync(process.execPath, ['check.mjs', ...(ticket ? [ticket] : [])], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('demo starter fails all unfinished ticket checks', () => {
  const run = check(fixture);
  assert.equal(run.status, 1);
  for (const id of ['SALES-101', 'SALES-102', 'SALES-103']) assert.match(run.stderr, new RegExp(`FAIL ${id}`));
});

test('demo accepts independent components then the combined result in a path with spaces', async (t) => {
  const root = await copyFixture(t);
  for (const [index, [name, source]] of Object.entries(implementations).entries()) {
    await writeFile(join(root, 'components', `${name}.js`), source);
    const run = check(root, `SALES-${101 + index}`);
    assert.equal(run.status, 0, run.stderr);
  }
  const run = check(root);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim().split('\n').length, 3);
});

test('demo rejects inaccurate KPI values, omitted months and reversed account priority', async (t) => {
  const root = await copyFixture(t);
  const broken = {
    kpis: implementations.kpis.replace('value:revenue', 'value:revenue+1'),
    chart: implementations.chart.replace('data.months.map', 'data.months.slice(1).map'),
    accounts: implementations.accounts
      .replace('indexOf(a.risk)-', 'indexOf(b.risk)-')
      .replace('indexOf(b.risk)||', 'indexOf(a.risk)||'),
  };
  for (const [index, [name, source]] of Object.entries(broken).entries()) {
    await writeFile(join(root, 'components', `${name}.js`), source);
    assert.equal(check(root, `SALES-${101 + index}`).status, 1);
  }
});

test('demo rejects hard-coded fixture answers and mutation of source data', async (t) => {
  const root = await copyFixture(t);
  await writeFile(
    join(root, 'components/chart.js'),
    'export default data => { data.months.reverse(); return data.months; };',
  );
  assert.equal(check(root, 'SALES-102').status, 1);
  await writeFile(join(root, 'components/chart.js'), implementations.chart);
  const hardCoded = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "import data from './data.js'; console.log(JSON.stringify(data.months));"],
    { cwd: root, encoding: 'utf8' },
  );
  await writeFile(join(root, 'components/chart.js'), `export default () => ${hardCoded};`);
  assert.equal(check(root, 'SALES-102').status, 1);
  assert.equal(check(root, 'SALES-999').status, 1);
});
