// Building and rendering invoices / expense claims.
import { api } from './api.js';
import { esc, fmtDate, fmtDays, money, round2, addDays } from './util.js';

// Turns raw entries into the frozen snapshot stored with the invoice.
export function buildInvoice({ kind, number, issuedOn, periodStart, periodEnd, profile, settings, projects, time, expenses }) {
  const rate = Number(profile.day_rate);
  const byProject = new Map();
  const group = (id) => {
    if (!byProject.has(id)) {
      const p = projects.find((x) => x.id === id) ?? { name: 'Unknown project', code: '' };
      byProject.set(id, { name: p.name, code: p.code, time: [], expenses: [] });
    }
    return byProject.get(id);
  };

  const sortBy = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
  for (const t of [...time].sort(sortBy('work_date'))) {
    group(t.project_id).time.push({ date: t.work_date, description: t.description, days: Number(t.days) });
  }
  let ref = 0;
  for (const e of [...expenses].sort(sortBy('spent_on'))) {
    group(e.project_id).expenses.push({
      ref: e.receipt_path ? `R${++ref}` : '',
      date: e.spent_on,
      category: e.category,
      description: e.description,
      amount: Number(e.amount),
      receipt_path: e.receipt_path ?? null,
      receipt_name: e.receipt_name ?? null,
    });
  }

  const groups = [...byProject.values()].sort(sortBy('name'));
  for (const g of groups) {
    g.days = round2(g.time.reduce((s, t) => s + t.days, 0));
    g.time_amount = round2(g.days * rate);
    g.expense_amount = round2(g.expenses.reduce((s, e) => s + e.amount, 0));
    g.total = round2(g.time_amount + g.expense_amount);
  }
  const sum = (k) => round2(groups.reduce((s, g) => s + g[k], 0));

  return {
    kind,
    number,
    issued_on: issuedOn,
    due_on: addDays(issuedOn, Number(settings.payment_terms_days || 0)),
    period_start: periodStart,
    period_end: periodEnd,
    from: { name: profile.full_name, address: profile.address, email: profile.email, bank_details: profile.bank_details },
    to: { name: settings.client_name, address: settings.client_address },
    notes: settings.invoice_notes,
    day_rate: rate,
    projects: groups,
    total_days: sum('days'),
    time_total: sum('time_amount'),
    expense_total: sum('expense_amount'),
    total: sum('total'),
  };
}

const lines = (text) => esc(text).replace(/\n/g, '<br>');

export function renderInvoice(d) {
  const isClaim = d.kind === 'claim';
  const title = isClaim ? 'Expense claim' : 'Invoice';

  const projectBlocks = d.projects.map((p) => `
    <section class="inv-project">
      <h3>${esc(p.name)}${p.code ? ` <span class="muted">· ${esc(p.code)}</span>` : ''}</h3>
      ${p.time.length ? `
        <table class="inv-table">
          <thead><tr><th>Date</th><th>Work</th><th class="num">Days</th></tr></thead>
          <tbody>
            ${p.time.map((t) => `<tr><td class="nowrap">${fmtDate(t.date)}</td><td>${esc(t.description)}</td><td class="num">${fmtDays(t.days)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="2">Time: ${fmtDays(p.days)} days × ${money(d.day_rate)}</td><td class="num">${money(p.time_amount)}</td></tr></tfoot>
        </table>` : ''}
      ${p.expenses.length ? `
        <table class="inv-table">
          <thead><tr><th>Date</th><th>Expense</th><th>Receipt</th><th class="num">Amount</th></tr></thead>
          <tbody>
            ${p.expenses.map((e) => `<tr><td class="nowrap">${fmtDate(e.date)}</td><td>${esc(e.category)}${e.description ? ' – ' + esc(e.description) : ''}</td><td>${e.ref || '<span class="muted">none</span>'}</td><td class="num">${money(e.amount)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="3">Expenses</td><td class="num">${money(p.expense_amount)}</td></tr></tfoot>
        </table>` : ''}
      <p class="inv-subtotal">Total for ${esc(p.name)}: <strong>${money(p.total)}</strong></p>
    </section>`).join('');

  return `
    <article class="invoice">
      <header class="inv-head">
        <div>
          <h1>${title}</h1>
          <p class="inv-from"><strong>${esc(d.from.name)}</strong><br>${lines(d.from.address)}${d.from.email ? '<br>' + esc(d.from.email) : ''}</p>
        </div>
        <dl class="inv-meta">
          <dt>Number</dt><dd>${esc(d.number)}</dd>
          <dt>Date</dt><dd>${fmtDate(d.issued_on)}</dd>
          ${isClaim ? '' : `<dt>Due</dt><dd>${fmtDate(d.due_on)}</dd>`}
          <dt>Period</dt><dd>${fmtDate(d.period_start)} – ${fmtDate(d.period_end)}</dd>
        </dl>
      </header>
      <p class="inv-to"><span class="muted">To</span><br><strong>${esc(d.to.name)}</strong><br>${lines(d.to.address)}</p>

      ${projectBlocks}

      <table class="inv-summary">
        ${isClaim ? '' : `<tr><td>Time (${fmtDays(d.total_days)} days)</td><td class="num">${money(d.time_total)}</td></tr>`}
        <tr><td>Expenses</td><td class="num">${money(d.expense_total)}</td></tr>
        <tr class="grand"><td>Total due</td><td class="num">${money(d.total)}</td></tr>
      </table>

      ${d.from.bank_details ? `<div class="inv-pay"><h3>Payment details</h3><p>${lines(d.from.bank_details)}</p></div>` : ''}
      ${d.notes ? `<p class="inv-notes">${lines(d.notes)}</p>` : ''}
      <div class="inv-receipts"></div>
    </article>`;
}

// Appends receipt images (and PDF pages, via pdf.js) after the invoice so the
// whole thing prints as one document.
export async function renderReceipts(container, d) {
  const items = d.projects.flatMap((p) => p.expenses.filter((e) => e.receipt_path).map((e) => ({ ...e, project: p.name })));
  if (!items.length) return;
  container.innerHTML = '<h2 class="receipts-title">Receipts</h2>';
  for (const e of items) {
    const box = document.createElement('figure');
    box.className = 'receipt';
    box.innerHTML = `<figcaption><strong>${e.ref}</strong> · ${fmtDate(e.date)} · ${esc(e.project)} · ${esc(e.category)} · ${money(e.amount)}</figcaption><div class="receipt-body muted">Loading…</div>`;
    container.append(box);
    const body = box.querySelector('.receipt-body');
    try {
      const url = await api.receiptUrl(e.receipt_path);
      const isPdf = /\.pdf$/i.test(e.receipt_name || e.receipt_path) || url.startsWith('data:application/pdf');
      body.innerHTML = '';
      body.classList.remove('muted');
      if (isPdf) await renderPdf(body, url);
      else body.innerHTML = `<img src="${esc(url)}" alt="Receipt ${e.ref}">`;
    } catch (err) {
      body.textContent = `Could not load receipt (${err.message}).`;
    }
  }
}

let pdfjs;
async function renderPdf(target, url) {
  pdfjs ??= await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
    return m;
  });
  const data = await (await fetch(url)).arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/jpeg', 0.85);
    img.alt = `Receipt page ${i}`;
    target.append(img);
  }
}
