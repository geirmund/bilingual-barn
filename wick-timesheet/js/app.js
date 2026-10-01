import { api, DEMO } from './api.js';
import { buildInvoice, renderInvoice, renderReceipts } from './invoice.js';
import {
  $, $$, esc, isoDate, monthRange, fmtDate, fmtDays, money, round2,
  invoiceNumber, downloadCsv, toast,
} from './util.js';

const CATEGORIES = ['Travel', 'Subsistence', 'Materials', 'Venue hire', 'Printing', 'Equipment', 'Other'];

const state = {
  user: null,
  profile: null,
  profiles: [],
  settings: null,
  projects: [],
  month: isoDate().slice(0, 7),
  everyone: false,
};

const main = () => $('#main');
const projectName = (id) => state.projects.find((p) => p.id === id)?.name ?? '?';
const personName = (id) => state.profiles.find((p) => p.id === id)?.full_name ?? '?';
const activeProjects = () => state.projects.filter((p) => p.active);

// ---------------------------------------------------------------------------
// Startup, auth, routing
// ---------------------------------------------------------------------------

async function loadShared() {
  [state.profiles, state.projects, [state.settings]] = await Promise.all([
    api.select('profiles'),
    api.select('projects', { order: ['name'] }),
    api.select('settings'),
  ]);
  state.profile = state.profiles.find((p) => p.id === state.user.id);
}

async function setUser(user) {
  state.user = user;
  if (!user) return renderLogin();
  try {
    await loadShared();
  } catch (err) {
    return showError(err);
  }
  if (!state.profile) return showError(new Error('No profile found for this login. Re-run supabase/schema.sql.'));
  renderShell();
  if (!state.profile.full_name || !Number(state.profile.day_rate)) {
    location.hash = '#/settings';
    toast('Welcome! Please fill in your details and day rate first.');
  }
  route();
}

function renderLogin() {
  document.body.classList.add('logged-out');
  $('#app').innerHTML = `
    <form class="login card" id="login">
      <h1>Wick Timesheet</h1>
      ${DEMO ? '<p class="demo-note">Demo mode: sign in as <b>alex@example.com</b> or <b>sam@example.com</b> with any password. Data stays in this browser.</p>' : ''}
      <label>Email <input type="email" name="email" required autocomplete="username"></label>
      <label>Password <input type="password" name="password" ${DEMO ? '' : 'required'} autocomplete="current-password"></label>
      <button class="primary">Sign in</button>
      <p class="error-text" hidden></p>
    </form>`;
  $('#login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try {
      await api.signIn(f.get('email'), f.get('password'));
    } catch (err) {
      const p = $('.error-text');
      p.textContent = err.message;
      p.hidden = false;
    }
  });
}

function renderShell() {
  document.body.classList.remove('logged-out');
  $('#app').innerHTML = `
    ${DEMO ? '<div class="demo-banner">Demo mode – data is only saved in this browser. See README to connect Supabase.</div>' : ''}
    <header class="topbar">
      <span class="brand">Wick Timesheet</span>
      <nav>
        <a href="#/time">Time</a>
        <a href="#/expenses">Expenses</a>
        <a href="#/invoices">Invoices</a>
        <a href="#/projects">Projects</a>
        <a href="#/settings">Settings</a>
      </nav>
      <span class="who">${esc(state.profile.full_name || state.user.email)} <button class="link" id="signout">Sign out</button></span>
    </header>
    <main id="main"></main>`;
  $('#signout').addEventListener('click', () => api.signOut());
}

const routes = {
  time: renderTime,
  expenses: renderExpenses,
  invoices: renderInvoices,
  invoice: renderInvoiceView,
  projects: renderProjects,
  settings: renderSettings,
};

async function route() {
  if (!state.user || !main()) return;
  const [, name = 'time', arg] = location.hash.split('/');
  const view = routes[name] ?? renderTime;
  // Fresh element each time so event listeners from the previous view go away.
  const fresh = document.createElement('main');
  fresh.id = 'main';
  main().replaceWith(fresh);
  $$('.topbar nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${name === 'invoice' ? 'invoices' : name}`));
  try {
    await view(arg);
  } catch (err) {
    showError(err);
  }
}

function showError(err) {
  console.error(err);
  toast(err.message || String(err), true);
}

// Wraps an async event handler so failures show up as a toast.
const safe = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { showError(err); }
};

// ---------------------------------------------------------------------------
// Shared bits for the time and expenses pages
// ---------------------------------------------------------------------------

function projectOptions(selected) {
  const list = state.projects.filter((p) => p.active || p.id === selected);
  if (!list.length) return '<option value="">Add a project first</option>';
  return list.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

function periodControls() {
  return `
    <div class="filters">
      <label>Month <input type="month" id="month" value="${state.month}"></label>
      <label class="check"><input type="checkbox" id="everyone" ${state.everyone ? 'checked' : ''}> Show everyone</label>
      <button class="secondary" id="csv">Export CSV</button>
    </div>`;
}

function bindPeriodControls(onCsv) {
  $('#month').addEventListener('change', (ev) => { state.month = ev.target.value || isoDate().slice(0, 7); route(); });
  $('#everyone').addEventListener('change', (ev) => { state.everyone = ev.target.checked; route(); });
  $('#csv').addEventListener('click', onCsv);
}

function periodQuery(dateCol) {
  const [start, end] = monthRange(state.month);
  const q = { gte: { [dateCol]: start }, lte: { [dateCol]: end }, order: [dateCol, 'desc'] };
  if (!state.everyone) q.eq = { user_id: state.user.id };
  return q;
}

async function invoiceNumbers() {
  const invoices = await api.select('invoices');
  return new Map(invoices.map((i) => [i.id, i.number]));
}

function statusCell(row, numbers) {
  if (row.invoice_id) return `<span class="tag">${esc(numbers.get(row.invoice_id) ?? 'Invoiced')}</span>`;
  if (row.user_id !== state.user.id) return '';
  return `<button class="link" data-edit="${row.id}">Edit</button> <button class="link danger" data-delete="${row.id}">Delete</button>`;
}

function projectTotals(rows, valueKey, fmt) {
  const totals = new Map();
  for (const r of rows) totals.set(r.project_id, round2((totals.get(r.project_id) ?? 0) + Number(r[valueKey])));
  if (!totals.size) return '';
  const all = round2([...totals.values()].reduce((a, b) => a + b, 0));
  return `
    <div class="totals">
      ${[...totals].map(([id, v]) => `<span><b>${esc(projectName(id))}</b> ${fmt(v)}</span>`).join('')}
      <span class="all"><b>Total</b> ${fmt(all)}</span>
    </div>`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

async function renderTime() {
  const [rows, numbers] = await Promise.all([api.select('time_entries', periodQuery('work_date')), invoiceNumbers()]);
  let editing = null;

  main().innerHTML = `
    <h2>Log time</h2>
    <form class="card entry-form" id="time-form">
      <label>Date <input type="date" name="work_date" required value="${isoDate()}"></label>
      <label>Project <select name="project_id" required>${projectOptions()}</select></label>
      <label>Days
        <span class="days-input">
          <input type="number" name="days" required min="0.05" max="2" step="0.05" value="1">
          ${[0.25, 0.5, 0.75, 1].map((d) => `<button type="button" class="chip" data-days="${d}">${{ 0.25: '¼', 0.5: '½', 0.75: '¾', 1: '1' }[d]}</button>`).join('')}
        </span>
      </label>
      <label class="wide">What did you do? <input name="description" placeholder="e.g. Planning session with volunteers"></label>
      <div class="actions"><button class="primary" id="time-save">Add time</button> <button type="button" class="secondary" id="time-cancel" hidden>Cancel</button></div>
    </form>

    ${periodControls()}
    ${projectTotals(rows, 'days', (v) => fmtDays(v) + ' days')}
    <table class="list">
      <thead><tr><th>Date</th>${state.everyone ? '<th>Who</th>' : ''}<th>Project</th><th class="num">Days</th><th>Description</th><th></th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td class="nowrap">${fmtDate(r.work_date)}</td>
            ${state.everyone ? `<td>${esc(personName(r.user_id))}</td>` : ''}
            <td>${esc(projectName(r.project_id))}</td>
            <td class="num">${fmtDays(r.days)}</td>
            <td>${esc(r.description)}</td>
            <td class="nowrap right">${statusCell(r, numbers)}</td>
          </tr>`).join('') || `<tr><td colspan="6" class="empty">No time logged this month.</td></tr>`}
      </tbody>
    </table>`;

  const form = $('#time-form');
  const reset = () => {
    editing = null;
    form.reset();
    form.work_date.value = isoDate();
    $('#time-save').textContent = 'Add time';
    $('#time-cancel').hidden = true;
  };

  $$('[data-days]', form).forEach((b) => b.addEventListener('click', () => { form.days.value = b.dataset.days; }));
  $('#time-cancel').addEventListener('click', reset);

  form.addEventListener('submit', safe(async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    const row = {
      work_date: f.get('work_date'),
      project_id: f.get('project_id'),
      days: Number(f.get('days')),
      description: f.get('description').trim(),
    };
    if (!row.project_id) throw new Error('Add a project on the Projects page first.');
    if (editing) await api.update('time_entries', editing, row);
    else await api.insert('time_entries', { ...row, user_id: state.user.id });
    toast(editing ? 'Updated' : 'Time added');
    state.month = row.work_date.slice(0, 7);
    await route();
  }));

  main().addEventListener('click', safe(async (ev) => {
    const editId = ev.target.dataset.edit;
    const deleteId = ev.target.dataset.delete;
    if (editId) {
      const r = rows.find((x) => x.id === editId);
      editing = r.id;
      form.work_date.value = r.work_date;
      form.project_id.innerHTML = projectOptions(r.project_id);
      form.days.value = r.days;
      form.description.value = r.description;
      $('#time-save').textContent = 'Save changes';
      $('#time-cancel').hidden = false;
      form.scrollIntoView({ behavior: 'smooth' });
    } else if (deleteId && confirm('Delete this time entry?')) {
      await api.remove('time_entries', deleteId);
      await route();
    }
  }));

  bindPeriodControls(() => downloadCsv(`time-${state.month}.csv`, [
    ['Date', 'Person', 'Project', 'Grant ref', 'Days', 'Description', 'Invoice'],
    ...rows.map((r) => [r.work_date, personName(r.user_id), projectName(r.project_id),
      state.projects.find((p) => p.id === r.project_id)?.code, r.days, r.description, numbers.get(r.invoice_id) ?? '']),
  ]));
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

async function renderExpenses() {
  const [rows, numbers] = await Promise.all([api.select('expenses', periodQuery('spent_on')), invoiceNumbers()]);
  let editing = null;

  main().innerHTML = `
    <h2>Log an expense</h2>
    <form class="card entry-form" id="exp-form">
      <label>Date <input type="date" name="spent_on" required value="${isoDate()}"></label>
      <label>Project <select name="project_id" required>${projectOptions()}</select></label>
      <label>Category <select name="category">${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label>Amount (£) <input type="number" name="amount" required min="0" step="0.01" inputmode="decimal"></label>
      <label class="wide">Description <input name="description" placeholder="e.g. Train to Hackney Wick"></label>
      <label class="wide">Receipt <input type="file" name="receipt" accept="image/*,application/pdf"><span class="hint" id="current-receipt"></span></label>
      <div class="actions"><button class="primary" id="exp-save">Add expense</button> <button type="button" class="secondary" id="exp-cancel" hidden>Cancel</button></div>
    </form>

    ${periodControls()}
    ${projectTotals(rows, 'amount', money)}
    <table class="list">
      <thead><tr><th>Date</th>${state.everyone ? '<th>Who</th>' : ''}<th>Project</th><th>Category</th><th>Description</th><th class="num">Amount</th><th>Receipt</th><th></th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td class="nowrap">${fmtDate(r.spent_on)}</td>
            ${state.everyone ? `<td>${esc(personName(r.user_id))}</td>` : ''}
            <td>${esc(projectName(r.project_id))}</td>
            <td>${esc(r.category)}</td>
            <td>${esc(r.description)}</td>
            <td class="num">${money(r.amount)}</td>
            <td>${r.receipt_path ? `<button class="link" data-receipt="${r.id}">View</button>` : '<span class="warn">Missing</span>'}</td>
            <td class="nowrap right">${statusCell(r, numbers)}</td>
          </tr>`).join('') || `<tr><td colspan="8" class="empty">No expenses this month.</td></tr>`}
      </tbody>
    </table>`;

  const form = $('#exp-form');
  const reset = () => {
    editing = null;
    form.reset();
    form.spent_on.value = isoDate();
    $('#current-receipt').textContent = '';
    $('#exp-save').textContent = 'Add expense';
    $('#exp-cancel').hidden = true;
  };
  $('#exp-cancel').addEventListener('click', reset);

  form.addEventListener('submit', safe(async (ev) => {
    ev.preventDefault();
    const button = $('#exp-save');
    const f = new FormData(form);
    const row = {
      spent_on: f.get('spent_on'),
      project_id: f.get('project_id'),
      category: f.get('category'),
      amount: round2(f.get('amount')),
      description: f.get('description').trim(),
    };
    if (!row.project_id) throw new Error('Add a project on the Projects page first.');
    const file = f.get('receipt');
    button.disabled = true;
    try {
      const old = editing && rows.find((r) => r.id === editing);
      if (file && file.size) {
        if (file.size > 10 * 1024 * 1024) throw new Error('Receipt is over 10 MB – please use a smaller photo or PDF.');
        row.receipt_path = await api.uploadReceipt(state.user.id, file);
        row.receipt_name = file.name;
      }
      if (editing) await api.update('expenses', editing, row);
      else await api.insert('expenses', { ...row, user_id: state.user.id });
      if (old?.receipt_path && row.receipt_path) await api.removeReceipt(old.receipt_path).catch(() => {});
    } finally {
      button.disabled = false;
    }
    toast(editing ? 'Updated' : 'Expense added');
    state.month = row.spent_on.slice(0, 7);
    await route();
  }));

  main().addEventListener('click', safe(async (ev) => {
    const { edit, delete: del, receipt } = ev.target.dataset;
    if (receipt) {
      const r = rows.find((x) => x.id === receipt);
      const w = window.open('', '_blank');
      let url = await api.receiptUrl(r.receipt_path);
      // Browsers refuse to open data: URLs directly (demo mode), so go via a blob.
      if (url.startsWith('data:')) url = URL.createObjectURL(await (await fetch(url)).blob());
      if (w) w.location = url;
    } else if (edit) {
      const r = rows.find((x) => x.id === edit);
      editing = r.id;
      form.spent_on.value = r.spent_on;
      form.project_id.innerHTML = projectOptions(r.project_id);
      form.category.value = r.category;
      form.amount.value = r.amount;
      form.description.value = r.description;
      $('#current-receipt').textContent = r.receipt_name ? `Current: ${r.receipt_name} (choose a file to replace it)` : '';
      $('#exp-save').textContent = 'Save changes';
      $('#exp-cancel').hidden = false;
      form.scrollIntoView({ behavior: 'smooth' });
    } else if (del && confirm('Delete this expense and its receipt?')) {
      const r = rows.find((x) => x.id === del);
      await api.remove('expenses', del);
      if (r.receipt_path) await api.removeReceipt(r.receipt_path).catch(() => {});
      await route();
    }
  }));

  bindPeriodControls(() => downloadCsv(`expenses-${state.month}.csv`, [
    ['Date', 'Person', 'Project', 'Grant ref', 'Category', 'Description', 'Amount', 'Receipt', 'Invoice'],
    ...rows.map((r) => [r.spent_on, personName(r.user_id), projectName(r.project_id),
      state.projects.find((p) => p.id === r.project_id)?.code, r.category, r.description, r.amount,
      r.receipt_name ?? '', numbers.get(r.invoice_id) ?? '']),
  ]));
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

async function uninvoiced(kind, start, end) {
  const mine = { user_id: state.user.id };
  const [time, expenses] = await Promise.all([
    kind === 'claim' ? [] : api.select('time_entries', { eq: mine, gte: { work_date: start }, lte: { work_date: end }, isNull: ['invoice_id'] }),
    api.select('expenses', { eq: mine, gte: { spent_on: start }, lte: { spent_on: end }, isNull: ['invoice_id'] }),
  ]);
  return { time, expenses };
}

async function renderInvoices() {
  const invoices = await api.select('invoices', { order: ['created_at', 'desc'] });
  const [time, expenses] = await Promise.all([
    api.select('time_entries', { eq: { user_id: state.user.id }, isNull: ['invoice_id'] }),
    api.select('expenses', { eq: { user_id: state.user.id }, isNull: ['invoice_id'] }),
  ]);

  // Default period: last month if there is anything left in it, otherwise this month.
  const [lastStart, lastEnd] = monthRange(isoDate(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)).slice(0, 7));
  const anyLastMonth = [...time.map((t) => t.work_date), ...expenses.map((e) => e.spent_on)].some((d) => d <= lastEnd);
  const [start, end] = anyLastMonth ? [lastStart, lastEnd] : monthRange(isoDate().slice(0, 7));
  const earliest = [...time.map((t) => t.work_date), ...expenses.map((e) => e.spent_on)].sort()[0];

  const pending = new Map();
  for (const t of time) {
    const p = pending.get(t.project_id) ?? { days: 0, exp: 0 };
    p.days = round2(p.days + Number(t.days));
    pending.set(t.project_id, p);
  }
  for (const e of expenses) {
    const p = pending.get(e.project_id) ?? { days: 0, exp: 0 };
    p.exp = round2(p.exp + Number(e.amount));
    pending.set(e.project_id, p);
  }
  const rate = Number(state.profile.day_rate);

  main().innerHTML = `
    <h2>Not yet invoiced <span class="muted small">(${esc(state.profile.full_name)})</span></h2>
    ${pending.size ? `
      <table class="list compact">
        <thead><tr><th>Project</th><th class="num">Days</th><th class="num">Time</th><th class="num">Expenses</th></tr></thead>
        <tbody>${[...pending].map(([id, p]) => `<tr><td>${esc(projectName(id))}</td><td class="num">${fmtDays(p.days)}</td><td class="num">${money(p.days * rate)}</td><td class="num">${money(p.exp)}</td></tr>`).join('')}</tbody>
      </table>
      ${earliest && earliest < start ? `<p class="hint">Oldest un-invoiced item is from ${fmtDate(earliest)}.</p>` : ''}`
    : '<p class="muted">Everything is invoiced.</p>'}

    <h2>Create</h2>
    <form class="card entry-form" id="inv-form">
      <label>Type
        <select name="kind">
          <option value="invoice">Invoice (time + expenses)</option>
          <option value="claim">Expense claim (expenses only)</option>
        </select>
      </label>
      <label>From <input type="date" name="start" required value="${start}"></label>
      <label>To <input type="date" name="end" required value="${end}"></label>
      <label>Invoice date <input type="date" name="issued" required value="${isoDate()}"></label>
      <div class="actions"><button class="primary">Preview</button></div>
    </form>
    <div id="preview"></div>

    <h2>History</h2>
    <table class="list">
      <thead><tr><th>Number</th><th>Who</th><th>Type</th><th>Date</th><th>Period</th><th class="num">Total</th><th></th></tr></thead>
      <tbody>
        ${invoices.map((i) => `
          <tr>
            <td>${esc(i.number)}</td>
            <td>${esc(personName(i.user_id))}</td>
            <td>${i.kind === 'claim' ? 'Expense claim' : 'Invoice'}</td>
            <td class="nowrap">${fmtDate(i.issued_on)}</td>
            <td class="nowrap">${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}</td>
            <td class="num">${money(i.total)}</td>
            <td class="right"><a href="#/invoice/${i.id}">Open</a></td>
          </tr>`).join('') || '<tr><td colspan="7" class="empty">No invoices yet.</td></tr>'}
      </tbody>
    </table>`;

  const form = $('#inv-form');
  form.addEventListener('submit', safe(async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    const kind = f.get('kind');
    const [s, e, issued] = [f.get('start'), f.get('end'), f.get('issued')];
    if (s > e) throw new Error('"From" date is after "To" date.');
    const entries = await uninvoiced(kind, s, e);
    const preview = $('#preview');
    if (!entries.time.length && !entries.expenses.length) {
      preview.innerHTML = '<p class="card muted">Nothing un-invoiced in that period.</p>';
      return;
    }
    const number = invoiceNumber(state.profile.invoice_prefix, state.profile.next_invoice_number);
    const data = buildInvoice({
      kind, number, issuedOn: issued, periodStart: s, periodEnd: e,
      profile: state.profile, settings: state.settings, projects: state.projects, ...entries,
    });
    const missing = entries.expenses.filter((x) => !x.receipt_path).length;
    preview.innerHTML = `
      <div class="preview-bar card">
        <span>Preview of <b>${esc(number)}</b> – ${money(data.total)}${missing ? ` · <span class="warn">${missing} expense(s) without a receipt</span>` : ''}</span>
        <button class="primary" id="inv-create">Create ${data.kind === 'claim' ? 'expense claim' : 'invoice'}</button>
      </div>
      <div class="paper">${renderInvoice(data)}</div>`;
    preview.scrollIntoView({ behavior: 'smooth' });

    $('#inv-create').addEventListener('click', safe(async (ev2) => {
      ev2.target.disabled = true;
      // Re-check in case something changed since the preview.
      const fresh = await uninvoiced(kind, s, e);
      if (fresh.time.length !== entries.time.length || fresh.expenses.length !== entries.expenses.length) {
        ev2.target.disabled = false;
        throw new Error('Entries changed since the preview – please preview again.');
      }
      const invoice = await api.insert('invoices', {
        user_id: state.user.id, kind, number, issued_on: issued,
        period_start: s, period_end: e, total: data.total, data,
      });
      await api.updateMany('time_entries', entries.time.map((t) => t.id), { invoice_id: invoice.id });
      await api.updateMany('expenses', entries.expenses.map((x) => x.id), { invoice_id: invoice.id });
      state.profile = await api.update('profiles', state.user.id, { next_invoice_number: state.profile.next_invoice_number + 1 });
      toast(`${number} created`);
      location.hash = `#/invoice/${invoice.id}`;
    }));
  }));
}

async function renderInvoiceView(id) {
  const [invoice] = await api.select('invoices', { eq: { id } });
  if (!invoice) {
    main().innerHTML = '<p>Invoice not found. <a href="#/invoices">Back</a></p>';
    return;
  }
  const own = invoice.user_id === state.user.id;
  main().innerHTML = `
    <div class="toolbar no-print">
      <a href="#/invoices">← Invoices</a>
      <span class="spacer"></span>
      <button class="secondary" id="inv-csv">CSV</button>
      ${own ? '<button class="secondary danger" id="inv-void">Void</button>' : ''}
      <button class="primary" id="inv-print">Print / Save PDF</button>
    </div>
    <div class="paper">${renderInvoice(invoice.data)}</div>`;

  $('#inv-print').addEventListener('click', () => window.print());
  $('#inv-csv').addEventListener('click', () => {
    const d = invoice.data;
    downloadCsv(`${invoice.number}.csv`, [
      ['Project', 'Grant ref', 'Type', 'Date', 'Description', 'Days', 'Amount', 'Receipt'],
      ...d.projects.flatMap((p) => [
        ...p.time.map((t) => [p.name, p.code, 'Time', t.date, t.description, t.days, round2(t.days * d.day_rate), '']),
        ...p.expenses.map((e) => [p.name, p.code, e.category, e.date, e.description, '', e.amount, e.ref]),
      ]),
    ]);
  });
  $('#inv-void')?.addEventListener('click', safe(async () => {
    if (!confirm(`Void ${invoice.number}? Its time and expenses become un-invoiced again so you can re-issue.`)) return;
    const [time, expenses] = await Promise.all([
      api.select('time_entries', { eq: { invoice_id: invoice.id } }),
      api.select('expenses', { eq: { invoice_id: invoice.id } }),
    ]);
    await api.updateMany('time_entries', time.map((t) => t.id), { invoice_id: null });
    await api.updateMany('expenses', expenses.map((x) => x.id), { invoice_id: null });
    await api.remove('invoices', invoice.id);
    // If this was the most recent number, reuse it so there is no gap.
    const p = state.profile;
    if (invoice.number === invoiceNumber(p.invoice_prefix, p.next_invoice_number - 1)) {
      state.profile = await api.update('profiles', p.id, { next_invoice_number: p.next_invoice_number - 1 });
    }
    toast(`${invoice.number} voided`);
    location.hash = '#/invoices';
  }));

  await renderReceipts($('.inv-receipts'), invoice.data);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async function renderProjects() {
  state.projects = await api.select('projects', { order: ['name'] });
  main().innerHTML = `
    <h2>Projects</h2>
    <form class="card entry-form" id="proj-form">
      <label class="wide">Project name <input name="name" required></label>
      <label>Grant / budget ref <input name="code" placeholder="optional"></label>
      <div class="actions"><button class="primary">Add project</button></div>
    </form>
    <table class="list">
      <thead><tr><th>Name</th><th>Grant ref</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.projects.map((p) => `
          <tr class="${p.active ? '' : 'inactive'}">
            <td>${esc(p.name)}</td>
            <td>${esc(p.code)}</td>
            <td>${p.active ? 'Active' : 'Archived'}</td>
            <td class="right nowrap">
              <button class="link" data-rename="${p.id}">Edit</button>
              <button class="link" data-toggle="${p.id}">${p.active ? 'Archive' : 'Restore'}</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="4" class="empty">No projects yet – add the first one above.</td></tr>'}
      </tbody>
    </table>
    <p class="hint">Archived projects disappear from the dropdowns but keep their history.</p>`;

  $('#proj-form').addEventListener('submit', safe(async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    await api.insert('projects', { name: f.get('name').trim(), code: f.get('code').trim(), active: true });
    await route();
  }));
  main().addEventListener('click', safe(async (ev) => {
    const { rename, toggle } = ev.target.dataset;
    const p = state.projects.find((x) => x.id === (rename || toggle));
    if (!p) return;
    if (toggle) {
      await api.update('projects', p.id, { active: !p.active });
    } else {
      const name = prompt('Project name', p.name);
      if (name === null) return;
      const code = prompt('Grant / budget reference', p.code);
      if (code === null) return;
      await api.update('projects', p.id, { name: name.trim() || p.name, code: code.trim() });
    }
    await route();
  }));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function renderSettings() {
  const p = state.profile;
  const s = state.settings;
  main().innerHTML = `
    <h2>My details <span class="muted small">(appear on your invoices)</span></h2>
    <form class="card entry-form" id="me-form">
      <label>Full name <input name="full_name" required value="${esc(p.full_name)}"></label>
      <label>Email <input type="email" name="email" value="${esc(p.email)}"></label>
      <label>Day rate (£) <input type="number" name="day_rate" min="0" step="0.01" required value="${esc(p.day_rate)}"></label>
      <label>Invoice prefix <input name="invoice_prefix" value="${esc(p.invoice_prefix)}"></label>
      <label>Next invoice number <input type="number" name="next_invoice_number" min="1" step="1" value="${esc(p.next_invoice_number)}"></label>
      <label class="wide">Address <textarea name="address" rows="3">${esc(p.address)}</textarea></label>
      <label class="wide">Bank details <textarea name="bank_details" rows="3" placeholder="Account name, sort code, account number">${esc(p.bank_details)}</textarea></label>
      <div class="actions"><button class="primary">Save my details</button></div>
    </form>
    <p class="hint">Changing your day rate affects future invoices only – existing invoices keep the rate they were created with.</p>

    <h2>Client <span class="muted small">(shared)</span></h2>
    <form class="card entry-form" id="client-form">
      <label>Client name <input name="client_name" required value="${esc(s.client_name)}"></label>
      <label>Payment terms (days) <input type="number" name="payment_terms_days" min="0" step="1" value="${esc(s.payment_terms_days)}"></label>
      <label class="wide">Client address <textarea name="client_address" rows="3">${esc(s.client_address)}</textarea></label>
      <label class="wide">Note at the bottom of invoices <textarea name="invoice_notes" rows="2" placeholder="e.g. Thank you!">${esc(s.invoice_notes)}</textarea></label>
      <div class="actions"><button class="primary">Save client</button></div>
    </form>`;

  $('#me-form').addEventListener('submit', safe(async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    state.profile = await api.update('profiles', p.id, {
      ...f,
      day_rate: Number(f.day_rate),
      next_invoice_number: Math.max(1, parseInt(f.next_invoice_number, 10) || 1),
    });
    state.profiles = state.profiles.map((x) => (x.id === p.id ? state.profile : x));
    renderShell();
    toast('Saved');
    await route();
  }));
  $('#client-form').addEventListener('submit', safe(async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    state.settings = await api.update('settings', 1, { ...f, payment_terms_days: parseInt(f.payment_terms_days, 10) || 0 });
    toast('Saved');
  }));
}

// ---------------------------------------------------------------------------

window.addEventListener('hashchange', route);
await setUser(await api.currentUser());
api.onAuthChange((user) => {
  if ((user?.id ?? null) !== (state.user?.id ?? null)) setUser(user);
});
