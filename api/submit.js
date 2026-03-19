// MPH United – IBC Recycling Request Form
// Vercel Serverless Function: handles form submission + SendGrid email

const sgMail = require("@sendgrid/mail");
const { randomBytes } = require("crypto");

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  // Vercel auto-parses JSON bodies — use req.body directly
  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Could not parse request body." });
  }

  // ── Validate required fields ───────────────────────────────────────────────
  const required = [
    "company", "street_address", "city", "state", "zip_code",
    "contact_name", "email", "phone", "shipping_hours", "pickup_date", "signature", "sign_date",
  ];
  const missing = required.filter((f) => !body[f]?.trim());
  if (missing.length) {
    return res.status(400).json({
      error: `Missing required fields: ${missing.map((f) => f.replace(/_/g, " ")).join(", ")}`,
    });
  }

  // ── Collect container rows ─────────────────────────────────────────────────
  const containers = [];
  for (let i = 1; i <= 25; i++) {
    const qty = body[`qty_${i}`]?.trim();
    if (!qty) continue;
    containers.push({
      qty,
      capacity: body[`capacity_${i}`]?.trim() || "",
      hazmat:   body[`hazmat_${i}`]?.trim()   || "",
      rinsed:   body[`rinsed_${i}`]?.trim()   || "",
      product:  body[`product_${i}`]?.trim()  || "",
      type:     body[`type_${i}`]?.trim()     || "",
    });
  }

  if (!containers.length) {
    return res.status(400).json({ error: "Please enter at least one container." });
  }

  // ── Generate reference ID ──────────────────────────────────────────────────
  const date   = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const ref_id = `MPH-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;

  // ── Build HTML email ───────────────────────────────────────────────────────
  const containerRows = containers.map((c) => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #e5eaf2;">${c.qty}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5eaf2;">${c.capacity}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5eaf2;">${c.hazmat}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5eaf2;">${c.rinsed}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5eaf2;">${c.product}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5eaf2;">${c.type}</td>
    </tr>`).join("");

  const html = `
  <html><body style="font-family:Segoe UI,Arial,sans-serif;color:#1a1a2e;max-width:700px;margin:0 auto;">
    <div style="background:#1F3864;padding:20px 30px;border-radius:8px 8px 0 0;">
      <h2 style="color:#fff;margin:0;font-size:1.2rem;">MPH United — IBC Pickup Request</h2>
      <p style="color:#a0b8d8;margin:4px 0 0;font-size:0.85rem;">Reference: ${ref_id}</p>
    </div>
    <div style="background:#fff;border:1px solid #d6e4f0;border-top:none;padding:28px 30px;border-radius:0 0 8px 8px;">
      <h3 style="color:#2E5FA3;border-bottom:2px solid #d6e4f0;padding-bottom:6px;margin-bottom:14px;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;">Shipper Information</h3>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
        <tr><td style="padding:5px 0;color:#6b7280;width:180px;">Company</td><td style="padding:5px 0;font-weight:600;">${body.company}</td></tr>
        <tr><td style="padding:5px 0;color:#6b7280;">Address</td><td style="padding:5px 0;">${body.street_address}, ${body.city}, ${body.state} ${body.zip_code}</td></tr>
        <tr><td style="padding:5px 0;color:#6b7280;">Contact</td><td style="padding:5px 0;">${body.contact_name}</td></tr>
        <tr><td style="padding:5px 0;color:#6b7280;">Email</td><td style="padding:5px 0;"><a href="mailto:${body.email}" style="color:#2E5FA3;">${body.email}</a></td></tr>
        <tr><td style="padding:5px 0;color:#6b7280;">Phone</td><td style="padding:5px 0;">${body.phone}</td></tr>
        ${body.fax ? `<tr><td style="padding:5px 0;color:#6b7280;">Fax</td><td style="padding:5px 0;">${body.fax}</td></tr>` : ""}
        <tr><td style="padding:5px 0;color:#6b7280;">Shipping Hours</td><td style="padding:5px 0;">${body.shipping_hours}</td></tr>
        ${body.dock_bldg ? `<tr><td style="padding:5px 0;color:#6b7280;">Dock / Bldg #</td><td style="padding:5px 0;">${body.dock_bldg}</td></tr>` : ""}
        <tr><td style="padding:5px 0;color:#6b7280;">Pickup Ready Date</td><td style="padding:5px 0;font-weight:600;">${body.pickup_date ? (() => { const [y,m,d] = body.pickup_date.split("-"); return `${m}/${d}/${y}`; })() : ""}</td></tr>
      </table>
      <h3 style="color:#2E5FA3;border-bottom:2px solid #d6e4f0;padding-bottom:6px;margin:22px 0 12px;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;">
        Container Details
      </h3>
      <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
        <thead>
          <tr style="background:#1F3864;color:#fff;">
            <th style="padding:8px 10px;text-align:left;">Qty</th>
            <th style="padding:8px 10px;text-align:left;">Capacity</th>
            <th style="padding:8px 10px;text-align:left;">Hazmat</th>
            <th style="padding:8px 10px;text-align:left;">Triple Rinsed</th>
            <th style="padding:8px 10px;text-align:left;">Product Last Contained</th>
            <th style="padding:8px 10px;text-align:left;">Type</th>
          </tr>
        </thead>
        <tbody>${containerRows}</tbody>
      </table>
      <h3 style="color:#2E5FA3;border-bottom:2px solid #d6e4f0;padding-bottom:6px;margin:22px 0 12px;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;">Signature</h3>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem;">
        <tr><td style="padding:5px 0;color:#6b7280;width:180px;">Signed by</td><td style="padding:5px 0;font-weight:600;">${body.signature}</td></tr>
        <tr><td style="padding:5px 0;color:#6b7280;">Date</td><td style="padding:5px 0;">${body.sign_date ? (() => { const [y,m,d] = body.sign_date.split("-"); return `${m}/${d}/${y}`; })() : ""}</td></tr>
      </table>
      ${body.notes ? `
      <h3 style="color:#C4962A;border-bottom:2px solid #E8D5A3;padding-bottom:6px;margin:22px 0 12px;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;">Notes</h3>
      <p style="font-size:0.9rem;color:#374151;line-height:1.6;">${body.notes.replace(/\n/g, "<br>")}</p>` : ""}
      ${body.photo_name ? `<p style="margin-top:16px;font-size:0.82rem;color:#6b7280;">📎 Photo attached: ${body.photo_name}</p>` : ""}
      <p style="margin-top:24px;font-size:0.78rem;color:#9ca3af;border-top:1px solid #e5eaf2;padding-top:14px;">
        Submitted via mphunited.com/pick-up &nbsp;|&nbsp; ${new Date().toUTCString()} &nbsp;|&nbsp; Ref: ${ref_id}
      </p>
    </div>
  </body></html>`;

  // ── Send email via SendGrid ─────────────────────────────────────────────────
  try {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const msg = {
      to:       process.env.EMAIL_TO  || "matt@mphunited.com",
      from:     process.env.EMAIL_FROM,
      replyTo:  body.email,
      subject:  `[IBC Pickup Request] ${body.company} — ${ref_id}`,
      html,
    };
    if (body.photo_data && body.photo_name && body.photo_type) {
      msg.attachments = [{
        content:     body.photo_data,
        filename:    body.photo_name,
        type:        body.photo_type,
        disposition: "attachment",
      }];
    }
    await sgMail.send(msg);
  } catch (err) {
    const sgError = err?.response?.body || err.message;
    console.error("SendGrid error:", JSON.stringify(sgError));
    return res.status(500).json({
      error: "Email failed to send.",
      detail: JSON.stringify(sgError),
    });
  }

  return res.status(200).json({ ok: true, ref_id });
};
