# registration office — LINK online services portal

Internal back-office for DASPA, ABN Assist, GST Register and CGT Clearance:
one place to see every lead (full submissions), work the pipeline
(new → in progress → lodged → cleared, + refunded/dead), get notified the
moment a lead arrives, and (admins) watch revenue per business.

Static HTML + Vercel serverless functions, zero npm dependencies — the same
pattern as the sites. The portal reads each site's Supabase with service-role
keys server-side only; the browser never holds a key. Not crawlable
(robots.txt + X-Robots-Tag + everything behind login).

**Users** — admin: James, Chris, Juan · team: France, Mary.
Admins additionally see revenue/ads/ROI panels.

## Deploy (once)

1. **Vercel**: import this repo as a new project, then add the domain
   `registrationoffice.com.au` in project → Settings → Domains.
2. **Supabase**: run `supabase/portal-schema.sql` once in the SQL editor of
   the project you want the portal's own tables in (the shared ARO project
   is fine).
3. **Vercel env vars**:

   | Var | Purpose |
   |---|---|
   | `PORTAL_SUPABASE_URL` / `PORTAL_SUPABASE_KEY` | portal tables (falls back to `ARO_*`) |
   | `DASPA_SUPABASE_URL` / `DASPA_SUPABASE_KEY` | DASPA claims project (service role) |
   | `ARO_SUPABASE_URL` / `ARO_SUPABASE_KEY` | shared ARO project — abn_orders, gst_orders, gst_leads (service role) |
   | `GSTR_SUPABASE_URL` / `GSTR_SUPABASE_KEY` | only if GST Register moves off the shared project |
   | `CGT_SUPABASE_URL` / `CGT_SUPABASE_KEY` | when the CGT Clearance rebuild lands |
   | `SETUP_SECRET` | guards the one-time user bootstrap |
   | `PORTAL_SESSION_SECRET` | optional; session signing (falls back to a hash of the portal key) |
   | `AHREFS_API_KEY` | SEO panel — Ahrefs API v3 |
   | `GOOGLE_ADS_DEV_TOKEN` | Ads panel — developer token from the MCC's API Center |
   | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client (Google Cloud console) for the in-portal "connect google ads" flow; redirect URI: `<PORTAL_URL>/api/google-oauth` |
   | `GOOGLE_ADS_MCC_ID` | manager account id, digits only |
   | `PORTAL_URL` | defaults to `https://registrationoffice.com.au` |

   For SEO + ads also run `supabase/2026-07-15-seo-ads.sql` (snapshots +
   stored OAuth connection).

4. **Bootstrap the five accounts** (once, after deploy):

   ```
   curl -X POST https://registrationoffice.com.au/api/auth \
     -H 'Content-Type: application/json' \
     -d '{"action":"bootstrap","secret":"<SETUP_SECRET>"}'
   ```

   Default accounts are james/chris/juan (admin) and france/mary (team) at
   `@link.com.au` — pass a `users` array in the same request to use different
   emails. The response contains each person's **temporary password, shown
   once**. Everyone is forced to set their own password at first login.

## How it fits together

- `api/_lib/config.js` — site registry (tables, colors, normalisers), Supabase
  REST helpers, scrypt + HMAC session auth (7-day tokens).
- `api/auth.js` — login / me / users / change-password / bootstrap.
- `api/leads.js` — unified lead feed, single-lead detail (full raw submission
  + payload), and the lightweight `?since=` poll the in-app notifications use
  (45s; browser notifications fire when permission is granted).
- `api/lead-action.js` — take / assign / status / note. Every action is an
  event; the timeline is the audit trail.
- `api/stats.js` — per-user volumes (who took/lodged/cleared what) for
  everyone; revenue per day per site for admins only.
- Pipeline state lives in the portal's own tables — the sites' databases are
  never written to.

## Phase 2 / 3 (stubs are in the nav)

- **Usage reports** — self-hosted rrweb session recorder on every site
  (sensitive fields masked), agent-written daily/weekly/monthly conversion
  reports with recommendations.
- **Google Ads** — spend + ROI per business via the MCC.
- **SEO** — Ahrefs API rankings per site.
- **CGT Clearance** — wired when the rebuild lands (currently WooCommerce).
