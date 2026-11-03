import data from './data.js';
import kpis from './components/kpis.js';
import chart from './components/chart.js';
import accounts from './components/accounts.js';
import { validate } from './acceptance.mjs';

const components = { 'SALES-101': kpis, 'SALES-102': chart, 'SALES-103': accounts };
const requested = process.argv.slice(2);
if (requested.length > 1 || (requested[0] && !Object.hasOwn(components, requested[0]))) {
  console.error('Usage: node check.mjs [SALES-101|SALES-102|SALES-103]');
  process.exitCode = 1;
} else {
  for (const ticket of requested.length ? requested : Object.keys(components)) {
    try {
      // Exercise both presentation data and an alternate dataset to reject hard-coded results.
      const alternate = {
        previousRevenue: 100,
        months: [{ month: 'Jul', revenue: 125 }],
        accounts: [
          { name: 'B', revenue: 50, daysSinceContact: 30 },
          { name: 'A', revenue: 75, daysSinceContact: 45 },
        ],
      };
      for (const input of [data, alternate]) {
        const copy = structuredClone(input);
        const result = components[ticket](copy);
        validate(ticket, result, input);
        if (JSON.stringify(copy) !== JSON.stringify(input)) throw new Error('Input data must not be mutated');
      }
      console.log(`PASS ${ticket}`);
    } catch (error) {
      console.error(`FAIL ${ticket}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
