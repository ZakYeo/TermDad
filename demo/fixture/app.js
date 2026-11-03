import data from './data.js';
import kpis from './components/kpis.js';
import chart from './components/chart.js';
import accounts from './components/accounts.js';

const currency = (value) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(value);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const placeholder = (title, ticket) => {
  const box = element('div', 'placeholder');
  box.append(element('strong', '', title), element('span', '', `${ticket} · Awaiting implementation`));
  return box;
};
try {
  const cards = kpis(structuredClone(data));
  for (const card of cards.length ? cards : ['Revenue', 'Customers', 'Growth'].map((label) => ({ label }))) {
    const box = element('article', `kpi${card.value === undefined ? ' pending' : ''}`);
    const value =
      card.value === undefined
        ? '—'
        : card.format === 'currency'
          ? currency(card.value)
          : card.format === 'percent'
            ? `${card.value > 0 ? '+' : ''}${card.value}%`
            : String(card.value);
    box.append(
      element('p', 'kpi-label', card.label),
      element('p', 'kpi-value', value),
      element(
        'p',
        'kpi-note',
        card.value === undefined
          ? 'SALES-101 · Awaiting implementation'
          : card.label === 'Growth'
            ? 'Compared with previous period'
            : 'First half · 2026',
      ),
    );
    document.querySelector('#kpis').append(box);
  }
  const months = chart(structuredClone(data));
  const chartRoot = document.querySelector('#chart');
  if (!months.length) chartRoot.append(placeholder('Monthly performance coming into focus', 'SALES-102'));
  else {
    const bars = element('div', 'chart');
    bars.setAttribute('role', 'img');
    bars.setAttribute('aria-label', months.map((item) => `${item.month}: ${currency(item.revenue)}`).join(', '));
    const max = Math.max(1, ...months.map((item) => item.revenue));
    for (const month of months) {
      const group = element('div', 'bar-group');
      const bar = element('div', 'bar');
      bar.style.height = `${Math.max(0, month.revenue / max) * 165}px`;
      group.append(
        element('span', 'bar-value', `${currency(month.revenue / 1000)}k`),
        bar,
        element('span', 'bar-label', month.month),
      );
      bars.append(group);
    }
    chartRoot.append(bars);
  }
  const rows = accounts(structuredClone(data));
  const accountsRoot = document.querySelector('#accounts');
  if (!rows.length) accountsRoot.append(placeholder('Know which customers need your attention', 'SALES-103'));
  else {
    const table = element('table', 'accounts');
    const head = element('thead');
    const header = element('tr');
    for (const label of ['Account', 'Revenue', 'Risk']) header.append(element('th', '', label));
    head.append(header);
    const body = element('tbody');
    for (const account of rows) {
      const row = element('tr');
      const risk = element('td');
      risk.append(element('span', `risk risk-${String(account.risk).toLowerCase()}`, account.risk));
      row.append(element('td', '', account.name), element('td', 'account-revenue', currency(account.revenue)), risk);
      body.append(row);
    }
    table.append(head, body);
    accountsRoot.append(table);
  }
} catch {
  const error = element('p', '', 'This dashboard could not be rendered. Check the component implementation.');
  error.id = 'error';
  document.querySelector('main').prepend(error);
}
