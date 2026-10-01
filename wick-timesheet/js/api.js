// Data access. Two interchangeable backends with the same interface:
//   supabaseBackend - the real thing
//   demoBackend     - localStorage, for trying the app without any setup
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const DEMO = !SUPABASE_URL || !SUPABASE_ANON_KEY;

const PAGE = 1000;

async function supabaseBackend() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const check = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    async currentUser() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    onAuthChange(cb) {
      sb.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
    },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }));
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async select(table, q = {}) {
      const rows = [];
      for (let from = 0; ; from += PAGE) {
        let query = sb.from(table).select('*');
        for (const [k, v] of Object.entries(q.eq ?? {})) query = query.eq(k, v);
        for (const [k, v] of Object.entries(q.gte ?? {})) query = query.gte(k, v);
        for (const [k, v] of Object.entries(q.lte ?? {})) query = query.lte(k, v);
        for (const k of q.isNull ?? []) query = query.is(k, null);
        if (q.order) query = query.order(q.order[0], { ascending: q.order[1] !== 'desc' });
        const page = check(await query.range(from, from + PAGE - 1));
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
    },
    async insert(table, row) {
      return check(await sb.from(table).insert(row).select().single());
    },
    async update(table, id, patch) {
      return check(await sb.from(table).update(patch).eq('id', id).select().single());
    },
    async updateMany(table, ids, patch) {
      if (!ids.length) return;
      check(await sb.from(table).update(patch).in('id', ids));
    },
    async remove(table, id) {
      check(await sb.from(table).delete().eq('id', id));
    },
    async uploadReceipt(userId, file) {
      const safe = file.name.replace(/[^\w.-]+/g, '_');
      const path = `${userId}/${crypto.randomUUID()}-${safe}`;
      check(await sb.storage.from('receipts').upload(path, file, { contentType: file.type }));
      return path;
    },
    async receiptUrl(path) {
      return check(await sb.storage.from('receipts').createSignedUrl(path, 3600)).signedUrl;
    },
    async removeReceipt(path) {
      check(await sb.storage.from('receipts').remove([path]));
    },
  };
}

// ---------------------------------------------------------------------------

const DEMO_KEY = 'wick-timesheet-demo';
const DEMO_FILES_KEY = 'wick-timesheet-demo-files';

function demoSeed() {
  const users = [
    { id: 'u1', email: 'alex@example.com' },
    { id: 'u2', email: 'sam@example.com' },
  ];
  return {
    session: null,
    users,
    profiles: users.map((u, i) => ({
      id: u.id,
      email: u.email,
      full_name: i ? 'Sam Example' : 'Alex Example',
      address: '1 Example Street\nLondon E9 1AA',
      bank_details: 'Account name: ' + (i ? 'Sam Example' : 'Alex Example') + '\nSort code: 00-00-00\nAccount: 12345678',
      day_rate: i ? 300 : 350,
      invoice_prefix: i ? 'SE-' : 'AE-',
      next_invoice_number: 1,
    })),
    settings: [{ id: 1, client_name: 'Wick Award', client_address: '', payment_terms_days: 30, invoice_notes: '' }],
    projects: [
      { id: 'p1', name: 'Community Garden', code: 'GR-2026-01', active: true },
      { id: 'p2', name: 'Youth Media Lab', code: 'GR-2026-02', active: true },
    ],
    invoices: [],
    time_entries: [],
    expenses: [],
  };
}

function demoBackend() {
  let db;
  try { db = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { /* ignore */ }
  db ??= demoSeed();
  let files = {};
  try { files = JSON.parse(localStorage.getItem(DEMO_FILES_KEY)) ?? {}; } catch { /* ignore */ }
  const save = () => {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(db));
      localStorage.setItem(DEMO_FILES_KEY, JSON.stringify(files));
    } catch { /* storage full or blocked: keep in memory */ }
  };
  let listener = () => {};
  const clone = (x) => structuredClone(x);

  return {
    async currentUser() { return db.session; },
    onAuthChange(cb) { listener = cb; },
    async signIn(email) {
      const user = db.users.find((u) => u.email === email.trim().toLowerCase());
      if (!user) throw new Error('Demo users: ' + db.users.map((u) => u.email).join(' or '));
      db.session = user;
      save();
      listener(user);
    },
    async signOut() { db.session = null; save(); listener(null); },
    async select(table, q = {}) {
      let rows = db[table].filter((r) =>
        Object.entries(q.eq ?? {}).every(([k, v]) => r[k] === v) &&
        Object.entries(q.gte ?? {}).every(([k, v]) => r[k] >= v) &&
        Object.entries(q.lte ?? {}).every(([k, v]) => r[k] <= v) &&
        (q.isNull ?? []).every((k) => r[k] == null));
      if (q.order) {
        const [k, dir] = q.order;
        rows = [...rows].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      return clone(rows);
    },
    async insert(table, row) {
      const full = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row };
      db[table].push(full);
      save();
      return clone(full);
    },
    async update(table, id, patch) {
      const row = db[table].find((r) => r.id === id);
      Object.assign(row, patch);
      save();
      return clone(row);
    },
    async updateMany(table, ids, patch) {
      for (const r of db[table]) if (ids.includes(r.id)) Object.assign(r, patch);
      save();
    },
    async remove(table, id) {
      db[table] = db[table].filter((r) => r.id !== id);
      save();
    },
    async uploadReceipt(userId, file) {
      const path = `${userId}/${crypto.randomUUID()}-${file.name}`;
      files[path] = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      save();
      return path;
    },
    async receiptUrl(path) { return files[path] ?? ''; },
    async removeReceipt(path) { delete files[path]; save(); },
  };
}

export const api = DEMO ? demoBackend() : await supabaseBackend();
