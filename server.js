/**
 * MediFastBD Mail Server (CareLink + transactional)
 *
 * Free-tier friendly Node.js server that:
 *  1. Runs a missed-dose check every 15 minutes and emails caregivers
 *     when 2+ consecutive doses are missed (CareLink).
 *  2. Exposes a tiny /send HTTP endpoint the Flutter app can use to send
 *     transactional emails (receipts, order updates, password-reset mirror).
 *
 * Deploy on Render (Free) or any Node 18+ host.
 * Keep it alive on the Render free tier by pinging /keepalive every
 * <15 min from cron-job.org / UptimeRobot / GitHub Actions cron.
 *
 * Required environment variables:
 *   FIREBASE_SERVICE_ACCOUNT   — JSON string of Firebase service account key
 *   GMAIL_CLIENT_ID            — OAuth client ID (Desktop app) from Google Cloud
 *   GMAIL_CLIENT_SECRET        — matching OAuth client secret
 *   GMAIL_REFRESH_TOKEN        — minted once via `node get-token.js`
 *   MAIL_USER                  — the Gmail address that sends the email
 *   MAIL_SHARED_SECRET         — secret header value for the /send endpoint
 *   PORT                       — optional, defaults to 3000
 */

const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");

// ─── Configuration ──────────────────────────────────────────────────────

// ⚠️ TEST VALUES — tighten before production:
//   GRACE_PERIOD_MINUTES: 10 (test)  →  120 (real 2-hour grace)
//   ALERT_THRESHOLD:       1  (test)  →  2    (alert after 2 misses)
const GRACE_PERIOD_MINUTES = 10;
const ALERT_THRESHOLD = 1; // consecutive missed doses before an email goes out
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const APP_TZ = "Asia/Dhaka";
const SEND_RATE_WINDOW_MS = 60 * 1000; // 1 minute
const SEND_RATE_MAX = 30;              // 30 emails / minute / IP
const SHARED_SECRET = process.env.MAIL_SHARED_SECRET || "";

// True when the reminder has at least one usable caregiver address.
function hasCaregiver(reminder) {
  const e1 = (reminder.caregiverEmail1 || "").trim();
  const e2 = (reminder.caregiverEmail2 || "").trim();
  return e1.length > 0 || e2.length > 0;
}

// ─── Initialize Firebase Admin ──────────────────────────────────────────

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is not set. Exiting.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});

const db = admin.firestore();

// ─── Email sending (Gmail API over HTTPS) ──────────────────────────────
// Render blocks outbound SMTP ports (25/465/587) on every plan, so Gmail
// SMTP is unreachable from there — and free email providers (Brevo,
// SMTP2GO, …) gate signups behind SMS verification or custom domains.
// The Gmail API is plain HTTPS, works from any host, and needs nothing
// new: just the Google account already running the Firebase project.
// A refresh token is minted once by get-token.js; access tokens are
// refreshed here automatically.

const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_TIMEOUT_MS = 20000;

let gmailAccessToken = null;
let gmailTokenExpiresAt = 0;

function mailConfigured() {
  return Boolean(
    process.env.GMAIL_CLIENT_ID &&
      process.env.GMAIL_CLIENT_SECRET &&
      process.env.GMAIL_REFRESH_TOKEN &&
      process.env.MAIL_USER
  );
}

function warnMailDisabled() {
  for (const key of [
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
    "MAIL_USER",
  ]) {
    if (!process.env[key]) {
      console.warn(`⚠️  ${key} not set. Email disabled.`);
    }
  }
}

async function getAccessToken() {
  if (gmailAccessToken && Date.now() < gmailTokenExpiresAt - 60000) {
    return gmailAccessToken;
  }
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error || "";
    } catch (_) {}
    const err = new Error(
      `gmail token refresh failed (${res.status}): ${detail}`
    );
    err.transient = res.status === 429 || res.status >= 500;
    throw err;
  }
  const data = await res.json();
  gmailAccessToken = data.access_token;
  gmailTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return gmailAccessToken;
}

function rfc2822({ to, subject, text, html, replyTo, fromName }) {
  // B-encode the subject so non-ASCII characters survive intact.
  const encSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const from = fromName
    ? `${fromName} <${process.env.MAIL_USER}>`
    : process.env.MAIL_USER;
  const boundary = "mfbd_" + crypto.randomBytes(12).toString("hex");

  const headers = [
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(", ") : to}`,
    `Subject: ${encSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);

  const parts = [];
  if (text) {
    parts.push(
      `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${text}\r\n`
    );
  }
  if (html) {
    parts.push(
      `--${boundary}\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n${html}\r\n`
    );
  }
  parts.push(`--${boundary}--\r\n`);

  return headers.join("\r\n") + "\r\n\r\n" + parts.join("");
}

/**
 * Sends one email through the Gmail API. `to` is a string or an array of
 * strings; `fromName` labels MAIL_USER. Throws an Error with
 * `e.transient = true` for retryable failures.
 */
async function sendMail({ to, subject, text, html, replyTo, fromName }) {
  if (!mailConfigured()) {
    warnMailDisabled();
    throw new Error("mail_disabled");
  }

  const token = await getAccessToken();
  const raw = Buffer.from(
    rfc2822({ to, subject, text, html, replyTo, fromName }),
    "utf8"
  ).toString("base64url");

  let res;
  try {
    res = await fetch(GMAIL_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(`gmail network error: ${e.message}`);
    err.transient = true;
    throw err;
  }

  if (res.status === 401) {
    // Access token rejected — drop the cache so the next try refreshes it.
    gmailAccessToken = null;
    const err = new Error("gmail 401: access token rejected");
    err.transient = true;
    throw err;
  }
  if (res.status >= 200 && res.status < 300) return;

  let detail = "";
  try {
    const errBody = await res.json();
    detail = errBody.error?.message || "";
  } catch (_) {}
  const err = new Error(`gmail ${res.status}${detail ? ": " + detail : ""}`);
  err.transient = res.status === 429 || res.status >= 500;
  throw err;
}

// ─── Time helpers ───────────────────────────────────────────────────────

function dhakaParts(date = new Date()) {
  // Returns { year, month, day, hour, minute } in Asia/Dhaka.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function dhakaDateKey(date = new Date()) {
  const p = dhakaParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// Compute the UTC instant for a (year, month, day, hour, minute) wall time
// in Asia/Dhaka. We solve by guessing UTC and reading back the Dhaka parts.
function dhakaToUtc(year, month, day, hour, minute) {
  // First guess: treat Dhaka as UTC+6, then refine.
  let utc = Date.UTC(year, month - 1, day, hour - 6, minute, 0, 0);
  for (let i = 0; i < 3; i++) {
    const parts = dhakaParts(new Date(utc));
    const deltaMin =
      (parts.year !== year ||
      parts.month !== month ||
      parts.day !== day ||
      parts.hour !== hour ||
      parts.minute !== minute)
        ? (Date.UTC(year, month - 1, day, hour, minute) -
            Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute))
        : 0;
    if (deltaMin === 0) break;
    utc += deltaMin;
  }
  return new Date(utc);
}

// ─── Express app ────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "64kb" }));
app.set("trust proxy", true);

let lastCheckTime = null;
let lastCheckError = null;

app.get("/", (_req, res) => {
  res.json({
    service: "MediFastBD Mail Server",
    status: "running",
    lastCheck: lastCheckTime,
    lastError: lastCheckError,
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Cheap endpoint used by uptime monitors to keep the Render free instance
// from sleeping. The actual missed-dose check runs on its own setInterval.
app.get("/keepalive", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Rate limiter for /send ─────────────────────────────────────────────

const buckets = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = buckets.get(ip) || { count: 0, resetAt: now + SEND_RATE_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + SEND_RATE_WINDOW_MS;
  }
  bucket.count += 1;
  buckets.set(ip, bucket);
  if (bucket.count > SEND_RATE_MAX) {
    return res.status(429).json({ error: "rate_limited" });
  }
  next();
}

// Periodic cleanup so the Map doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [ip, bucket] of buckets) {
    if (bucket.resetAt < cutoff) buckets.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function requireSecret(req, res, next) {
  if (!SHARED_SECRET) {
    return res.status(503).json({ error: "shared_secret_not_configured" });
  }
  const got = req.get("x-mail-secret") || "";
  if (got.length !== SHARED_SECRET.length || !safeEqual(got, SHARED_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function safeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post("/send", rateLimit, requireSecret, async (req, res) => {
  const { to, subject, text, html, replyTo } = req.body || {};
  if (!to || !subject || (!text && !html)) {
    return res.status(400).json({ error: "missing_fields" });
  }
  const recipients = Array.isArray(to) ? to : [to];
  if (recipients.length === 0 || recipients.some((r) => !EMAIL_RE.test(r))) {
    return res.status(400).json({ error: "invalid_recipient" });
  }
  if (subject.length > 200) {
    return res.status(400).json({ error: "subject_too_long" });
  }

  if (!mailConfigured()) {
    warnMailDisabled();
    return res.status(503).json({ error: "mail_disabled" });
  }

  try {
    await sendWithRetry({
      fromName: "MediFastBD",
      to: recipients,
      subject,
      text: text || stripHtml(html),
      html: html || `<pre>${escapeHtml(text || "")}</pre>`,
      replyTo,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("send failed:", err.message);
    res.status(502).json({ error: "send_failed", detail: err.message });
  }
});

// ─── CareLink scheduler ─────────────────────────────────────────────────

async function runCheck() {
  lastCheckTime = new Date().toISOString();
  lastCheckError = null;
  console.log(`\n⏰ CareLink check at ${lastCheckTime}`);

  try {
    const snap = await db
      .collection("reminders")
      .where("careLinkEnabled", "==", true)
      .where("enabled", "==", true)
      .get();

    if (snap.empty) {
      console.log("No CareLink reminders.");
      return;
    }

    for (const doc of snap.docs) {
      try {
        await processReminder(doc);
      } catch (e) {
        console.error(`Reminder ${doc.id} failed:`, e.message);
      }
    }
    console.log("✅ CareLink check complete.\n");
  } catch (e) {
    lastCheckError = e.message;
    console.error("❌ CareLink check failed:", e.message);
  }
}

async function processReminder(reminderDoc) {
  const r = reminderDoc.data();
  const reminderId = reminderDoc.id;
  const userId = r.userId;

  const now = new Date();
  const dateKey = dhakaDateKey(now);
  const parts = dhakaParts(now);

  // Weekly reminders only count as missed on their scheduled weekdays.
  if (r.frequency === "weekly" && Array.isArray(r.daysOfWeek) && r.daysOfWeek.length > 0) {
    // ISO weekday (1 = Mon … 7 = Sun), matching the model's daysOfWeek.
    const dhakaNow = new Date(now.toLocaleString("en-US", { timeZone: APP_TZ }));
    const iso = dhakaNow.getDay() === 0 ? 7 : dhakaNow.getDay();
    if (!r.daysOfWeek.includes(iso)) return;
  }

  const scheduledUTC = dhakaToUtc(
    parts.year, parts.month, parts.day, r.hour, r.minute
  );
  const deadline = new Date(
    scheduledUTC.getTime() + GRACE_PERIOD_MINUTES * 60000
  );
  if (now < deadline) return;

  const logId = `${reminderId}_${dateKey}`;
  const logDoc = await db.collection("dose_logs").doc(logId).get();

  if (logDoc.exists) {
    const outcome = logDoc.data().outcome;
    if (outcome === "taken") {
      if ((r.consecutiveMissed || 0) > 0 || r.alertSentForCurrentStreak) {
        await db.collection("reminders").doc(reminderId).update({
          consecutiveMissed: 0,
          alertSentForCurrentStreak: false,
          lastDoseStatus: "taken",
          lastTakenAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      return;
    }
    if (outcome === "skipped" || outcome === "missed") {
      // The user already told us — do NOT overwrite their log with an
      // auto-detected "missed" record, and do not wait for the grace period.
      // Update the streak from the real outcome instead.
      await recordOutcome(reminderId, r, outcome, dateKey);
      return;
    }
  }

  await handleMissed(reminderDoc, r, dateKey);
}

/**
 * Evaluates the CareLink alert after the user has logged the dose themselves
 * ("skipped" or "missed"). The Flutter app ALREADY incremented
 * `consecutiveMissed` when it wrote the log (see ReminderProvider.logDose),
 * so this must NOT count again — it only decides whether the alert email
 * goes out now, without waiting for the grace period to expire.
 */
async function recordOutcome(reminderId, reminder, outcome, dateKey) {
  const ctx = { shouldAlert: false, newCount: 0, current: null };

  await db.runTransaction(async (tx) => {
    const currentDoc = await tx.get(db.collection("reminders").doc(reminderId));
    if (!currentDoc.exists) return;
    const current = currentDoc.data();

    const newCount = current.consecutiveMissed || 0;

    const shouldAlert =
      newCount >= ALERT_THRESHOLD &&
      !current.alertSentForCurrentStreak &&
      current.careLinkEnabled &&
      hasCaregiver(current);

    if (shouldAlert) {
      tx.update(db.collection("reminders").doc(reminderId), {
        alertSentForCurrentStreak: true,
        lastCountedDateKey: dateKey,
      });
      ctx.shouldAlert = true;
      ctx.newCount = newCount;
      ctx.current = current;
    }
    // No update when not alerting — the client already did the bookkeeping.
  });

  if (ctx.shouldAlert) {
    await sendCareLinkEmail(
      reminder.userId,
      reminder.medicineName,
      ctx.current.caregiverEmail1,
      ctx.current.caregiverEmail2,
      ctx.newCount,
      reminder.hour,
      reminder.minute
    );
  }
}

async function handleMissed(reminderDoc, reminder, dateKey) {
  const reminderId = reminderDoc.id;
  const userId = reminder.userId;
  const logId = `${reminderId}_${dateKey}`;

  const ctx = { shouldAlert: false, newCount: 0, current: null };

  await db.runTransaction(async (tx) => {
    const currentDoc = await tx.get(db.collection("reminders").doc(reminderId));
    if (!currentDoc.exists) return;
    const current = currentDoc.data();

    const logRef = db.collection("dose_logs").doc(logId);
    const existing = await tx.get(logRef);
    if (existing.exists) return; // race lost

    tx.set(logRef, {
      userId,
      reminderId,
      dateKey,
      outcome: "missed",
      loggedAt: Date.now(),
      autoDetected: true,
    });

    const newCount = (current.consecutiveMissed || 0) + 1;
    const update = {
      consecutiveMissed: newCount,
      lastDoseStatus: "missed",
      lastMissedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const shouldAlert =
      newCount >= ALERT_THRESHOLD &&
      !current.alertSentForCurrentStreak &&
      current.careLinkEnabled &&
      hasCaregiver(current);

    if (shouldAlert) update.alertSentForCurrentStreak = true;

    tx.update(db.collection("reminders").doc(reminderId), update);

    ctx.shouldAlert = shouldAlert;
    ctx.newCount = newCount;
    ctx.current = current;
  });

  if (ctx.shouldAlert) {
    await sendCareLinkEmail(
      userId,
      reminder.medicineName,
      ctx.current.caregiverEmail1,
      ctx.current.caregiverEmail2,
      ctx.newCount,
      reminder.hour,
      reminder.minute
    );
  }
}

async function sendCareLinkEmail(
  userId, medicineName, email1, email2, count, hour, minute
) {
  if (!mailConfigured()) {
    warnMailDisabled();
    return;
  }

  let patientName = "A patient";
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (userDoc.exists) {
      const u = userDoc.data();
      patientName = u.fullName || u.displayName || patientName;
    }
  } catch (_) {}

  const recipients = [email1, email2]
    .filter((e) => e && e.trim().length > 0)
    .map((e) => e.trim());
  if (recipients.length === 0) return;

  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const subject = "MediFastBD CareLink – Medication Adherence Alert";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <div style="background:#1B5E20;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:18px;">MediFastBD CareLink</h2>
        <p style="margin:4px 0 0;font-size:13px;opacity:0.9;">Medication Adherence Alert</p>
      </div>
      <div style="border:1px solid #e0e0e0;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
        <p>Hello,</p>
        <p>MediFastBD CareLink has detected <strong>${count} consecutive missed medication dose${count === 1 ? "" : "s"}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:8px 12px;color:#666;border-bottom:1px solid #eee;">Patient</td><td style="padding:8px 12px;font-weight:bold;border-bottom:1px solid #eee;">${esc(patientName)}</td></tr>
          <tr><td style="padding:8px 12px;color:#666;border-bottom:1px solid #eee;">Medicine</td><td style="padding:8px 12px;font-weight:bold;border-bottom:1px solid #eee;">${esc(medicineName)}</td></tr>
          <tr><td style="padding:8px 12px;color:#666;border-bottom:1px solid #eee;">Scheduled time</td><td style="padding:8px 12px;font-weight:bold;border-bottom:1px solid #eee;">${time}</td></tr>
          <tr><td style="padding:8px 12px;color:#666;border-bottom:1px solid #eee;">Missed doses</td><td style="padding:8px 12px;font-weight:bold;border-bottom:1px solid #eee;color:#d32f2f;">${count} consecutive doses</td></tr>
        </table>
        <p>Please check on the patient if necessary.</p>
        <p style="color:#666;font-size:13px;margin-top:24px;border-top:1px solid #eee;padding-top:16px;">
          Automated medication-adherence notification from MediFastBD. This is not a medical emergency.
        </p>
      </div>
    </div>`;

  await sendWithRetry({
    fromName: "MediFastBD CareLink",
    to: recipients,
    subject,
    html,
    text: `MediFastBD CareLink – Medication Adherence Alert\n\nPatient: ${patientName}\nMedicine: ${medicineName}\nScheduled: ${time}\nMissed doses: ${count} consecutive\n\nPlease check on the patient if necessary.\n\nThis is an automated message from MediFastBD. Not a medical emergency.`,
  });
  console.log(`  📧 CareLink email → ${recipients.length} caregiver(s)`);
}

// ─── Send with retry ────────────────────────────────────────────────────

async function sendWithRetry(mail, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await sendMail(mail);
      return;
    } catch (e) {
      lastErr = e;
      const transient =
        e.transient === true ||
        /ETIMEDOUT|ECONNRESET|EAI_AGAIN|timeout|abort/i.test(e.message || "");
      if (!transient || i === attempts - 1) throw e;
      await sleep(500 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── HTML helpers ───────────────────────────────────────────────────────

function esc(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtml(s) {
  return esc(s).replace(/'/g, "&#039;");
}

function stripHtml(s) {
  if (!s) return "";
  return String(s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// ─── Boot ───────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`MediFastBD Mail Server listening on :${PORT}`);
  runCheck();
  setInterval(runCheck, CHECK_INTERVAL_MS).unref();
});

function shutdown(sig) {
  console.log(`${sig} received, shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
