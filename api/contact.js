/**
 * Contact form delivery.
 *
 * Same scheme as bioflex.ie: Resend when RESEND_API_KEY, CONTACT_TO_EMAIL and
 * CONTACT_FROM_EMAIL are all set, FormSubmit otherwise. FormSubmit needs no key
 * and no DNS; the first message to a new address sends it an activation link,
 * and delivery starts once someone clicks it.
 */

const SITE_ORIGIN = "https://www.halcyonblue.ai";
const DEFAULT_TO = "hello@halcyonblue.ai";
const MAX = { name: 120, email: 200, phone: 40, company: 160, subject: 200, message: 5000 };

// Per-instance throttle: partial cover against a script posting in a loop.
const RATE = { max: 4, windowMs: 60000 };
const hits = new Map();

function overRateLimit(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < RATE.windowMs);
  const over = recent.length >= RATE.max;
  if (!over) recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return over;
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

async function viaFormSubmit(p, to) {
  const res = await fetch("https://formsubmit.co/ajax/" + encodeURIComponent(to), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // FormSubmit rejects requests without a Referer, and its bot filter
      // answers 403 to a bare datacentre fetch.
      Referer: SITE_ORIGIN + "/",
      Origin: SITE_ORIGIN,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "Accept-Language": "en-IE,en;q=0.9",
    },
    body: JSON.stringify({
      _subject: "Website enquiry: " + p.subject,
      _template: "table",
      _replyto: p.email,
      name: p.name,
      email: p.email,
      phone: p.phone || "not given",
      company: p.company || "not given",
      subject: p.subject,
      message: p.message,
    }),
  });
  const body = await res.json().catch(() => null);
  const ok = body && (body.success === true || body.success === "true");
  if (!res.ok || !ok) {
    console.error("[contact] FormSubmit rejected the enquiry", res.status, body && body.message);
    return false;
  }
  return true;
}

async function viaResend(p, apiKey, to, from) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: p.email,
      subject: "Website enquiry: " + p.subject,
      text: [
        "Name:    " + p.name,
        "Email:   " + p.email,
        "Phone:   " + (p.phone || "not given"),
        "Company: " + (p.company || "not given"),
        "",
        p.message,
      ].join("\n"),
    }),
  });
  if (!res.ok) {
    console.error("[contact] Resend rejected the enquiry", res.status, await res.text());
    return false;
  }
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const b = req.body && typeof req.body === "object" ? req.body : {};

  // Honeypot: real people never fill this in. Pretend success so bots learn nothing.
  if (str(b.website)) return res.status(200).json({ ok: true });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (overRateLimit(ip)) {
    return res.status(429).json({ ok: false, error: "Too many messages. Please wait a minute and try again." });
  }

  const p = {
    name: str(b.name),
    email: str(b.email),
    phone: str(b.phone),
    company: str(b.company),
    subject: str(b.subject),
    message: str(b.message),
  };

  if (!p.name || !p.email || !p.subject || !p.message) {
    return res.status(400).json({ ok: false, error: "Please fill in all required fields." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email)) {
    return res.status(400).json({ ok: false, error: "That email address does not look valid." });
  }
  for (const k of Object.keys(MAX)) {
    if (p[k].length > MAX[k]) {
      return res.status(400).json({ ok: false, error: "One of the fields is too long." });
    }
  }

  const to = process.env.CONTACT_TO_EMAIL || DEFAULT_TO;
  const key = process.env.RESEND_API_KEY;
  const from = process.env.CONTACT_FROM_EMAIL;

  let sent = false;
  try {
    sent = key && from ? await viaResend(p, key, to, from) : await viaFormSubmit(p, to);
  } catch (err) {
    console.error("[contact] Delivery threw", err);
  }

  if (!sent) {
    return res.status(502).json({ ok: false, error: "Sending failed." });
  }
  return res.status(200).json({ ok: true });
};
