import assert from 'node:assert/strict';

export function validate(ticket, value, data) {
  const revenue = data.months.reduce((sum, month) => sum + month.revenue, 0);
  if (ticket === 'SALES-101') {
    assert.deepEqual(
      value,
      [
        { label: 'Revenue', value: revenue, format: 'currency' },
        { label: 'Customers', value: data.accounts.length, format: 'number' },
        {
          label: 'Growth',
          value: Math.round(((revenue - data.previousRevenue) / data.previousRevenue) * 1000) / 10,
          format: 'percent',
        },
      ],
      'Executive KPIs must match the source data',
    );
  } else if (ticket === 'SALES-102') {
    assert.deepEqual(
      value,
      data.months.map(({ month, revenue }) => ({ month, revenue })),
      'Every month must appear in source order with accurate revenue',
    );
  } else if (ticket === 'SALES-103') {
    const rank = { High: 0, Medium: 1, Low: 2 };
    const expected = data.accounts.map(({ name, revenue, daysSinceContact }) => ({
      name,
      revenue,
      risk: daysSinceContact >= 45 ? 'High' : daysSinceContact >= 30 ? 'Medium' : 'Low',
    }));
    expected.sort((a, b) => rank[a.risk] - rank[b.risk] || a.name.localeCompare(b.name));
    assert.deepEqual(value, expected, 'All accounts must have accurate risk and consistent ordering');
  } else {
    throw new Error(`Unknown ticket: ${ticket}`);
  }
}
