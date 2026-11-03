const byId = (id) => document.getElementById(id);
const defaults = [
  { id: 'SALES-101', title: 'Executive KPI cards', state: 'Queued' },
  { id: 'SALES-102', title: 'Monthly sales performance', state: 'Queued' },
  { id: 'SALES-103', title: 'Accounts needing attention', state: 'Queued' },
];
const icons = ['◈', '▥', '◎'];
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
  byId('tickets').replaceChildren(
    ...tickets.map((ticket, index) => {
      const card = document.createElement('article');
      card.className = 'ticket';
      const icon = document.createElement('div');
      icon.className = 'ticket-icon';
      icon.textContent = icons[index] ?? '◈';
      const text = document.createElement('div');
      const id = document.createElement('span');
      id.className = 'ticket-id';
      id.textContent = ticket.id;
      const title = document.createElement('h3');
      title.textContent = ticket.title;
      const state = document.createElement('span');
      state.className = `state ${ticket.state === 'Merged' ? 'done' : ['Needs attention', 'Needs approval'].includes(ticket.state) ? 'attention' : ''}`;
      state.textContent = ticket.state;
      text.append(id, title, state);
      card.append(icon, text);
      return card;
    }),
  );
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
