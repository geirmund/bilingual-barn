# Wick Timesheet

A very small web app for two people to log **time (in days)** and **expenses (with receipts)** against Wick Award projects, and to generate **invoices** and **expense claims**.

- Plain HTML/CSS/JS – no build step, no server code.
- [Supabase](https://supabase.com) (free tier) provides logins, the database and private receipt storage.
- Host the files anywhere static: GitHub Pages, Netlify, Cloudflare Pages.

## How it works

| Page | What you do there |
|---|---|
| **Time** | Log a date, project, fraction of a day (¼ ½ ¾ 1, or any value like 0.3) and a note. |
| **Expenses** | Log date, project, category, amount and attach a receipt photo or PDF (phones open the camera). |
| **Invoices** | See what's not yet invoiced, pick a period, preview and create an **Invoice** (time + expenses) or **Expense claim** (expenses only). |
| **Projects** | Add projects with an optional grant/budget reference. Archive finished ones. |
| **Settings** | Your name, address, bank details, day rate and invoice numbering; Wick Award's address and payment terms. |

- Each person invoices separately with their own day rate and numbering (e.g. `AE-001`).
- Invoices are grouped by project with subtotals, which helps Wick Award allocate costs to grants.
- Receipts are numbered R1, R2… on the invoice and appended as pages at the end. PDF receipts are rendered as images so everything prints as **one PDF** (use *Print / Save PDF*).
- Creating an invoice locks its entries so nothing gets billed twice. **Void** unlocks them, e.g. to fix a mistake and re-issue.
- Each invoice stores a frozen copy of its lines, so changing your day rate later doesn't alter old invoices.
- Both people can see everything (tick *Show everyone*), but can only edit their own entries.
- CSV export is available on the Time, Expenses and invoice pages.

## Try it now (demo mode)

With `js/config.js` left empty, the app runs in demo mode and saves data only in your browser:

```sh
python3 -m http.server 8000
# open http://localhost:8000 and sign in as alex@example.com (any password)
```

(Opening `index.html` directly from disk won't work – browsers block ES modules on `file://`.)

## Setting it up for real (about 15 minutes)

### 1. Create the Supabase project
1. Sign up at [supabase.com](https://supabase.com) and create a new project (choose the **London** region).
2. Open **SQL Editor → New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.

### 2. Add the two users and turn off sign-ups
1. **Authentication → Sign In / Providers**: turn **off** “Allow new users to sign up”.
2. **Authentication → Users → Add user → Create new user**: enter each person's email and a password, and tick **Auto confirm user**. Do this twice.

### 3. Connect the app
Under **Project Settings → API**, copy the **Project URL** and the **anon / publishable key** into `js/config.js`:

```js
export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...';
```

The anon key is meant to be public. Without a login it can't read anything, because of the row-level-security rules in `schema.sql`.

### 4. Publish
**GitHub Pages:** repo **Settings → Pages → Deploy from a branch → `main` / root**. The site appears at `https://<user>.github.io/<repo>/`. If the repo is private, you need a paid GitHub plan for Pages. Otherwise use Netlify or Cloudflare Pages (free with private repos): connect the repo, with no build command and publish directory `/`.

### 5. First login
Each person signs in and lands on **Settings**. Fill in name, address, bank details, day rate and an invoice prefix (e.g. your initials). If you've already issued invoices elsewhere, set **Next invoice number** to carry on the sequence. Then add projects under **Projects**.

## Good to know

- **Free-tier pausing:** Supabase pauses free projects after about a week with no activity. Logging time weekly keeps it awake. If it does pause, click *Restore* in the Supabase dashboard; no data is lost.
- **Backups:** the free tier has no point-in-time restore. Occasionally export CSVs, or download the tables from the Supabase *Table Editor*.
- **Receipts** up to 10 MB each are stored privately and are only viewable by signed-in users through short-lived links.

## Files

```
index.html          page shell
css/styles.css      styles, including print layout for invoices
js/config.js        Supabase URL + key (empty = demo mode)
js/api.js           data access: Supabase backend + localStorage demo backend
js/app.js           pages: time, expenses, invoices, projects, settings
js/invoice.js       building, rendering and printing invoices/receipts
js/util.js          small helpers
supabase/schema.sql tables, security rules and receipt bucket
```
