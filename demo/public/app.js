const byId = (id) => document.getElementById(id);
const defaults = [
  { id: 'SALES-101', title: 'Executive KPI cards', state: 'Queued' },
  { id: 'SALES-102', title: 'Monthly sales performance', state: 'Queued' },
  { id: 'SALES-103', title: 'Accounts needing attention', state: 'Queued' },
];
const icons = ['◈', '▥', '◎'];
const cards = new Map();
let nextDescriptionId = 0;
function updateTickets(tickets) {
  const active = new Set(tickets.map((ticket) => ticket.id));
  for (const [id, item] of cards) {
    if (!active.has(id)) {
      item.card.remove();
      cards.delete(id);
    }
  }
  tickets.forEach((ticket, index) => {
    let item = cards.get(ticket.id);
    if (!item) {
      const card = document.createElement('article');
      card.className = 'ticket';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ticket-toggle';
      button.setAttribute('aria-expanded', 'false');
      const icon = document.createElement('span');
      icon.className = 'ticket-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = icons[index] ?? '◈';
      const summary = document.createElement('span');
      summary.className = 'ticket-summary';
      const id = document.createElement('span');
      id.className = 'ticket-id';
      const title = document.createElement('span');
      title.className = 'ticket-title';
      const state = document.createElement('span');
      state.setAttribute('role', 'status');
      const chevron = document.createElement('span');
      chevron.className = 'ticket-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '⌄';
      summary.append(id, title, state);
      button.append(icon, summary, chevron);
      const panel = document.createElement('div');
      panel.className = 'ticket-details';
      panel.id = `ticket-description-${++nextDescriptionId}`;
      panel.inert = true;
      panel.setAttribute('aria-hidden', 'true');
      button.setAttribute('aria-controls', panel.id);
      const inner = document.createElement('div');
      const description = document.createElement('p');
      inner.append(description);
      panel.append(inner);
      card.append(button, panel);
      item = { card, button, id, title, state, panel, description };
      button.addEventListener('click', () => {
        const expanded = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(expanded));
        button.setAttribute(
          'aria-label',
          `${expanded ? 'Minimise' : 'Expand'} ${item.id.textContent}: ${item.title.textContent}`,
        );
        panel.setAttribute('aria-hidden', String(!expanded));
        panel.inert = !expanded;
        card.classList.toggle('expanded', expanded);
      });
      cards.set(ticket.id, item);
    }
    item.id.textContent = ticket.id;
    item.title.textContent = ticket.title;
    item.state.textContent = ticket.state;
    item.state.className = `state ${ticket.state === 'Merged' ? 'done' : ['Needs attention', 'Needs approval'].includes(ticket.state) ? 'attention' : ''}`;
    item.description.textContent = ticket.description || 'Description will appear when the demo connects.';
    item.button.setAttribute(
      'aria-label',
      `${item.button.getAttribute('aria-expanded') === 'true' ? 'Minimise' : 'Expand'} ${ticket.id}: ${ticket.title}`,
    );
    // Preserve DOM identity and focus on normal status polls.
    const current = byId('tickets').children[index];
    if (current !== item.card) byId('tickets').insertBefore(item.card, current ?? null);
  });
}
let revealed = false;
let released = false;
let mode = 'before';
let startToken;
let startPending = false;
function show(which) {
  if (which === 'after' && !released) return;
  mode = which;
  byId('dashboard').src = `/${which}/`;
  for (const value of ['before', 'after']) {
    byId(value).classList.toggle('selected', value === which);
    byId(value).setAttribute('aria-pressed', String(value === which));
  }
  byId('preview-title').textContent =
    which === 'after' ? 'Ready for the board meeting' : 'Before the team gets to work';
  byId('caption').textContent =
    which === 'after'
      ? 'Three contributions, checked and merged into one dashboard.'
      : 'The starting point. The finished dashboard appears once the changes are checked and merged.';
}
byId('before').onclick = () => show('before');
byId('after').onclick = () => show('after');
function renderExecution(status) {
  byId('launch').hidden = !status.execution;
  if (!status.execution) return;
  startToken = status.startToken;
  const waiting = status.execution === 'waiting';
  byId('start-demo').disabled = !waiting || startPending || !startToken;
  byId('start-demo').textContent = waiting
    ? startPending
      ? 'Starting…'
      : 'Start demo →'
    : status.execution === 'failed'
      ? 'Start failed'
      : status.execution === 'starting'
        ? 'Starting…'
        : 'Demo running';
  byId('launch-title').textContent = waiting
    ? 'Your team is ready to begin.'
    : status.execution === 'failed'
      ? 'The demo could not start.'
      : 'Dad is taking it from here.';
  byId('launch-copy').textContent =
    status.execution === 'failed'
      ? 'Check the launcher terminal. Restart the launcher to try again.'
      : waiting
        ? 'Start when you are ready to present. Dad will launch three workers and automatically approve permission prompts scoped to this demo.'
        : 'Follow the workers in WezTerm and watch the results come together here.';
}
byId('start-demo').onclick = async () => {
  if (startPending || !startToken) return;
  startPending = true;
  byId('start-demo').disabled = true;
  byId('start-demo').textContent = 'Starting…';
  try {
    const response = await fetch('/start', { method: 'POST', headers: { 'X-Demo-Start-Token': startToken } });
    if (!response.ok && response.status !== 409) throw new Error('Start unavailable');
  } catch {
    byId('launch-title').textContent = 'Start could not be confirmed.';
    byId('launch-copy').textContent = 'Check the launcher terminal. Progress will update if the request reached Dad.';
  } finally {
    startPending = false;
  }
};
function render(status) {
  renderExecution(status);
  const tickets = status.tickets.length ? status.tickets : defaults;
  const merged = tickets.filter((ticket) => ticket.state === 'Merged').length;
  byId('completed').replaceChildren(
    document.createTextNode(String(merged)),
    Object.assign(document.createElement('span'), { textContent: '/3' }),
  );
  byId('progress-fill').style.width = `${Math.min(100, (merged / 3) * 100)}%`;
  byId('connection').textContent = status.available ? '● Live observations' : '○ Observation unavailable';
  byId('connection').className = status.available ? 'connected' : 'unavailable';
  byId('connection').title = status.updatedAt
    ? `Last observation ${new Date(status.updatedAt).toLocaleTimeString()}`
    : 'Waiting for the first observation';
  updateTickets(tickets);
  released = status.available && status.released;
  byId('after').disabled = !released;
  if (!released && mode === 'after') show('before');
  if (released && !revealed) {
    revealed = true;
    show('after');
  }
}
render({ available: false, tickets: [], released: false, updatedAt: null, message: 'Connecting to TermDad…' });
async function poll() {
  try {
    const response = await fetch('/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unavailable');
    render(await response.json());
  } catch {
    byId('connection').textContent = '○ Connection lost';
    byId('connection').className = 'unavailable';
    byId('connection').title = 'Preview server unavailable. Last observed progress remains visible.';
    released = false;
    byId('after').disabled = true;
    byId('start-demo').disabled = true;
  } finally {
    setTimeout(poll, 2000);
  }
}
void poll();
