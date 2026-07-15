// Tax invoice engine — called by each site's Stripe webhook the moment an
// order is paid. POST { secret, site, orderId, email, name, amountCents, description }
// Guarded by INVOICE_SECRET (shared env var across the site projects).
// Idempotent per (site, orderId): retries and webhook replays can't double-invoice.
//
// Issues a sequential invoice number, emails an ATO-compliant tax invoice via
// Resend (correct entity per site), and stores it in portal_invoices.

const { PORTAL, sbGet, sbWrite } = require('./_lib/config');

const ENTITIES = {
  gstregister: { brand: 'GST Register', entity: 'Australian Registration and Lodgement Services Pty Ltd', abn: '53 630 861 219', site: 'www.gstregister.com.au' },
  abnassist: { brand: 'ABN Assist', entity: 'Australian Registration Office Pty Ltd', abn: '58 645 964 156', site: 'www.abnassist.com.au' },
  daspa: { brand: 'DASPA', entity: 'Australian Registration Office Pty Ltd', abn: '58 645 964 156', site: 'daspa.com.au' },
  cgt: { brand: 'CGT Clearance', entity: 'Australian Registration Office Pty Ltd', abn: '58 645 964 156', site: 'cgtclearance.com.au' },
};

const fmt$ = (c) => '$' + (c / 100).toLocaleString('en-AU', { minimumFractionDigits: 2 });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  try {
    const { secret, site, orderId, email, name, amountCents, description } = req.body || {};
    if (!process.env.INVOICE_SECRET || secret !== process.env.INVOICE_SECRET) return res.status(401).json({ error: 'bad secret' });
    const ent = ENTITIES[site];
    if (!ent || !orderId || !amountCents || !email) return res.status(400).json({ error: 'need site, orderId, amountCents, email' });

    const existing = ((await sbGet(PORTAL, `portal_invoices?site=eq.${site}&order_id=eq.${encodeURIComponent(orderId)}&select=invoice_no`)) || [])[0];
    if (existing) return res.status(200).json({ invoiceNo: existing.invoice_no, duplicate: true });

    const gst = Math.round(amountCents / 11); // GST-inclusive prices: GST component is 1/11th
    const inserted = await sbWrite(PORTAL, 'portal_invoices', 'POST', {
      site, order_id: String(orderId), email: String(email).toLowerCase(), name: name || null,
      amount_cents: amountCents, gst_cents: gst, description: description || `${ent.brand} service`,
    }, 'return=representation');
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    const invoiceNo = 'INV-' + String(10000 + row.id);
    await sbWrite(PORTAL, `portal_invoices?id=eq.${row.id}`, 'PATCH', { invoice_no: invoiceNo });

    if (process.env.RESEND_API_KEY) {
      const today = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${ent.brand} <no-reply@registrationoffice.com.au>`,
          to: email,
          subject: `Tax invoice ${invoiceNo} — ${ent.brand}`,
          html: `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:28px 10px;color:#0F0F10">
  <table width="100%" style="border-collapse:collapse"><tr>
    <td><div style="font-size:22px;font-weight:800">${ent.brand}</div>
        <div style="color:#55555C;font-size:13px">${ent.entity}<br>ABN ${ent.abn} · ${ent.site}</div></td>
    <td align="right"><div style="font-size:18px;font-weight:800;letter-spacing:1px">TAX INVOICE</div>
        <div style="color:#55555C;font-size:13px">${invoiceNo}<br>${today}</div></td>
  </tr></table>
  <p style="margin:22px 0 6px">Billed to: <b>${(name || email)}</b> (${email})</p>
  <table width="100%" style="border-collapse:collapse;font-size:14px">
    <tr style="background:#0F0F10;color:#fff"><td style="padding:9px 12px">Description</td><td style="padding:9px 12px" align="right">Amount</td></tr>
    <tr><td style="padding:10px 12px;border:1px solid #E5E5E3">${description || ent.brand + ' service'} (order ${orderId})</td>
        <td style="padding:10px 12px;border:1px solid #E5E5E3" align="right">${fmt$(amountCents)}</td></tr>
    <tr><td style="padding:8px 12px;color:#55555C" align="right">Total GST included</td><td style="padding:8px 12px;border:1px solid #E5E5E3" align="right">${fmt$(gst)}</td></tr>
    <tr><td style="padding:8px 12px;font-weight:800" align="right">Total paid (inc GST)</td><td style="padding:8px 12px;border:1px solid #E5E5E3;font-weight:800" align="right">${fmt$(amountCents)}</td></tr>
  </table>
  <p style="color:#8B8B93;font-size:12px;margin-top:20px">Paid in full by card. This document is a tax invoice for GST purposes. Keep it for your records — the fee is generally tax deductible.</p>
</div>`,
        }),
      });
      if (r.ok) await sbWrite(PORTAL, `portal_invoices?id=eq.${row.id}`, 'PATCH', { sent_at: new Date().toISOString() });
      else console.error('invoice email failed', r.status, (await r.text()).slice(0, 200));
    }
    return res.status(200).json({ invoiceNo });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'invoice failed' });
  }
};
