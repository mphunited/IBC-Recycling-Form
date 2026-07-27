// MPH United – IBC Recycling Request Form
// Vercel Serverless Function: handles form submission + SendGrid email

const sgMail   = require("@sendgrid/mail");
const PDFDocument = require("pdfkit");
const { randomBytes } = require("crypto");
const { Ratelimit } = require("@upstash/ratelimit");
const { Redis } = require("@upstash/redis");
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, "1 h"),
});

// ── PDF generator ────────────────────────────────────────────────────────────
function generatePDF(body, containers, ref_id) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: "LETTER" });
    const chunks = [];
    doc.on("data",  (c) => chunks.push(c));
    doc.on("end",   ()  => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W   = doc.page.width;
    const L   = 50;   // left margin
    const R   = W - 50; // right margin
    const BLU = "#1F3864";
    const LBL = "#6b7280";

    // ── Header bar ────────────────────────────────────────────────────────────
    doc.rect(L, 40, W - 100, 52).fill(BLU);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(14)
       .text("MPH United — IBC Pickup Request", L + 14, 53);
    doc.font("Helvetica").fontSize(9).fillColor("#a0b8d8")
       .text(`Reference: ${ref_id}`, L + 14, 72);

    let y = 112;

    // ── Section helper ────────────────────────────────────────────────────────
    function sectionTitle(title) {
      doc.moveTo(L, y).lineTo(R, y).strokeColor("#d6e4f0").stroke();
      y += 6;
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#2E5FA3")
         .text(title.toUpperCase(), L, y, { characterSpacing: 0.8 });
      y += 18;
    }

    // ── Row helper ────────────────────────────────────────────────────────────
    function row(label, value) {
      if (!value) return;
      doc.font("Helvetica").fontSize(9).fillColor(LBL)
         .text(label, L, y, { width: 150, continued: false });
      doc.font("Helvetica").fontSize(9).fillColor("#1a1a2e")
         .text(String(value), L + 155, y - 9, { width: R - L - 155 });
      y += 16;
    }

    // ── Shipper Information ───────────────────────────────────────────────────
    sectionTitle("Shipper Information");
    row("Company",       body.company);
    row("Address",       `${body.street_address}, ${body.city}, ${body.state} ${body.zip_code}`);
    row("Contact",       body.contact_name);
    row("Email",         body.email);
    row("Phone",         body.phone);
    if (body.fax)        row("Fax",          body.fax);
    row("Shipping Hours", body.shipping_hours);
    if (body.dock_bldg)  row("Dock / Bldg #", body.dock_bldg);
    if (body.pickup_date) {
      const [py, pm, pd] = body.pickup_date.split("-");
      row("Pickup Ready Date", `${pm}/${pd}/${py}`);
    }
    y += 8;

    // ── Container Details ─────────────────────────────────────────────────────
    sectionTitle("Container Details");

    // Table header
    const cols = [
      { label: "Qty",                   x: L,        w: 35  },
      { label: "Capacity",              x: L + 35,   w: 65  },
      { label: "Hazmat",                x: L + 100,  w: 55  },
      { label: "Triple Rinsed",         x: L + 155,  w: 70  },
      { label: "List ALL Last Contained Specific Product(s)", x: L + 225, w: 155 },
      { label: "Type",                  x: L + 380,  w: 80  },
    ];
    const rowH = 16;

    doc.rect(L, y, R - L, rowH).fill(BLU);
    cols.forEach((col) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#ffffff")
         .text(col.label, col.x + 3, y + 4, { width: col.w - 6, ellipsis: true });
    });
    y += rowH;

    containers.forEach((c, idx) => {
      if (y > doc.page.height - 80) {
        doc.addPage();
        y = 50;
      }
      const bg = idx % 2 === 0 ? "#f5f8ff" : "#ffffff";
      doc.rect(L, y, R - L, rowH).fill(bg);
      const vals = [c.qty, c.capacity, c.hazmat, c.rinsed, c.product, c.type];
      cols.forEach((col, ci) => {
        doc.font("Helvetica").fontSize(8).fillColor("#1a1a2e")
           .text(vals[ci] || "", col.x + 3, y + 4, { width: col.w - 6, ellipsis: true });
      });
      y += rowH;
    });
    y += 14;

    // ── Signature ─────────────────────────────────────────────────────────────
    if (y > doc.page.height - 80) { doc.addPage(); y = 50; }
    sectionTitle("Signature");
    row("Signed by", body.signature);
    if (body.sign_date) {
      const [sy, sm, sd] = body.sign_date.split("-");
      row("Date", `${sm}/${sd}/${sy}`);
    }
    y += 8;

    // ── Notes ─────────────────────────────────────────────────────────────────
    if (body.notes) {
      if (y > doc.page.height - 80) { doc.addPage(); y = 50; }
      sectionTitle("Notes");
      doc.font("Helvetica").fontSize(9).fillColor("#374151")
         .text(body.notes, L, y, { width: R - L, lineGap: 3 });
      y = doc.y + 12;
    }

    // ── Footer (flows after content, no absolute positioning) ─────────────────
    y = doc.y + 16;
    doc.moveTo(L, y).lineTo(R, y).strokeColor("#e5eaf2").stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(LBL)
       .text(
         `Submitted via mphunited.com/pick-up  |  ${new Date().toUTCString()}  |  Ref: ${ref_id}`,
         L, y + 6, { width: R - L, align: "center" }
       );

    doc.end();
  });
}

// ── Allowed origins for CORS ─────────────────────────────────────────────────
// Same-origin requests from the form itself don't need CORS at all.
// This list only matters for cross-origin requests (other sites' JS).
const ALLOWED_ORIGINS = [
  "https://ibc-recycling-form.vercel.app",
  // Add more here if you ever embed the form on another domain:
  // "https://mphunited.com",
  // "https://www.mphunited.com",
];

// ── Main handler ─────────────────────────────────────────────────────────────
async function handler(req, res) {
  const origin = req.headers.origin;
  // Echo the origin back ONLY if it's on the allowlist.
  // Vercel preview deploys (project-name-<hash>.vercel.app) are also allowed.
  const isVercelPreview =
    typeof origin === "string" &&
    /^https:\/\/ibc-recycling-form(-[a-z0-9-]+)?\.vercel\.app$/.test(origin);
  if (origin && (ALLOWED_ORIGINS.includes(origin) || isVercelPreview)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  const { success } = await ratelimit.limit(ip);
  if (!success) {
    return res.status(429).json({
      error: "Too many requests. Please wait and try again.",
    });
  }

  // Vercel auto-parses JSON bodies — use req.body directly
  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Could not parse request body." });
  }

  // ── Validate required fields ───────────────────────────────────────────────
  const required = [
    "company", "street_address", "city", "state", "zip_code",
    "contact_name", "email", "phone", "shipping_hours", "signature", "sign_date",
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
            <th style="padding:8px 10px;text-align:left;">List ALL Last Contained Specific Product(s)</th>
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
      ${Array.isArray(body.photos) && body.photos.length ? `
      <h3 style="color:#C4962A;border-bottom:2px solid #E8D5A3;padding-bottom:6px;margin:22px 0 12px;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;">Container Photos</h3>
      <p style="font-size:0.85rem;color:#374151;">${body.photos.length} photo(s) attached to this email.</p>` : ""}
      <p style="margin-top:24px;font-size:0.78rem;color:#9ca3af;border-top:1px solid #e5eaf2;padding-top:14px;">
        Submitted via mphunited.com/pick-up &nbsp;|&nbsp; ${new Date().toUTCString()} &nbsp;|&nbsp; Ref: ${ref_id}
      </p>
    </div>
  </body></html>`;

  // ── Generate PDF attachment ───────────────────────────────────────────────
  let pdfAttachment;
  try {
    const pdfBuffer = await generatePDF(body, containers, ref_id);
    pdfAttachment = {
      content:     pdfBuffer.toString("base64"),
      filename:    `IBC-Pickup-Request-${ref_id}.pdf`,
      type:        "application/pdf",
      disposition: "attachment",
    };
  } catch (pdfErr) {
    console.error("PDF generation error:", pdfErr.message);
    // Non-fatal — email still sends without PDF if something goes wrong
    pdfAttachment = null;
  }

  // ── Build attachments (PDF first, then photos) ────────────────────────────
  const attachments = [];
  if (pdfAttachment) attachments.push(pdfAttachment);
  if (Array.isArray(body.photos)) {
    body.photos.forEach((p, i) => attachments.push({
      content:     p.data,           // raw base64, no data: prefix
      filename:    p.name || `photo-${i + 1}.jpg`,
      type:        p.type || "image/jpeg",
      disposition: "attachment",
    }));
  }

  // ── Send email via SendGrid ─────────────────────────────────────────────────
  try {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const ccAddresses = process.env.EMAIL_CC
      ? process.env.EMAIL_CC.split(",").map(e => e.trim()).filter(Boolean)
      : [];

    const msg = {
      to:       process.env.EMAIL_TO  || "recycling@mphunited.com",
      from:     process.env.EMAIL_FROM,
      replyTo:  body.email,
      subject:  `[IBC Pickup Request] ${body.company} — ${ref_id}`,
      html,
    };
    if (ccAddresses.length) msg.cc = ccAddresses;
    if (attachments.length) msg.attachments = attachments;
    await sgMail.send(msg);
  } catch (err) {
    const sgError = err?.response?.body || err.message;
    console.error("SendGrid error:", JSON.stringify(sgError));
    return res.status(500).json({ error: "Email failed to send." });
  }

  return res.status(200).json({ ok: true, ref_id });
}

// Increase body parser limit to handle base64 photo attachments
handler.config = {
  api: {
    bodyParser: {
      sizeLimit: "30mb",
    },
  },
};

module.exports = handler;
