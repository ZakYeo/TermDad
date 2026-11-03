const byId = (id) => document.getElementById(id);
const defaults = [
  { id: 'SALES-101', title: 'Executive KPI cards', state: 'Queued' },
  { id: 'SALES-102', title: 'Monthly sales performance', state: 'Queued' },
  { id: 'SALES-103', title: 'Accounts needing attention', state: 'Queued' },
];
const icons = ['◈', '▥', '◎'];
const activity = [];
const previous = new Map();
let revealed = false;
let released = false;
let mode = 'before';
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
function render(status) {
  const tickets = status.tickets.length ? status.tickets : defaults;
  const merged = tickets.filter((ticket) => ticket.state === 'Merged').length;
  byId('completed').replaceChildren(
    document.createTextNode(String(merged)),
    Object.assign(document.createElement('span'), { textContent: '/3' }),
  );
  byId('progress-fill').style.width = `${Math.min(100, (merged / 3) * 100)}%`;
  byId('connection').textContent = status.available ? '● Live observations' : '○ Observation unavailable';
  byId('connection').className = status.available ? 'connected' : 'unavailable';
  byId('message').textContent = status.message;
  byId('observed').textContent = status.updatedAt
    ? `Last observation ${new Date(status.updatedAt).toLocaleTimeString()}`
    : 'Waiting for the first observation';
  byId('tickets').replaceChildren(
    ...tickets.map((ticket, index) => {
      const prior = previous.get(ticket.id);
      if (prior && prior !== ticket.state) activity.unshift(`${ticket.id} · ${ticket.state}`);
      previous.set(ticket.id, ticket.state);
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
      state.className = `state ${ticket.state === 'Merged' ? 'done' : ticket.state === 'Needs attention' ? 'attention' : ''}`;
      state.textContent = ticket.state;
      text.append(id, title, state);
      card.append(icon, text);
      return card;
    }),
  );
  activity.splice(6);
  byId('activity').replaceChildren(
    ...activity.map((entry) => Object.assign(document.createElement('li'), { textContent: entry })),
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
    byId('message').textContent = 'Preview server unavailable. Last observed progress remains visible.';
    released = false;
    byId('after').disabled = true;
  } finally {
    setTimeout(poll, 2000);
  }
}
void poll();
