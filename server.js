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
 *   MAIL_USER                  — Gmail address that sends email
 *   MAIL_APP_PASSWORD          — Gmail App Password (NOT the real password)
 *   MAIL_SHARED_SECRET         — secret header value for the /send endpoint
 *   PORT                       — optional, defaults to 3000
 */

const express = require("express");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

// ─── Configuration ──────────────────────────────────────────────────────

const GRACE_PERIOD_HOURS = 2;
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const APP_TZ = "Asia/Dhaka";
const SEND_RATE_WINDOW_MS = 60 * 1000; // 1 minute
const SEND_RATE_MAX = 30;              // 30 emails / minute / IP
const SHARED_SECRET = process.env.MAIL_SHARED_SECRET || "";

// ─── Initialize Firebase Admin ──────────────────────────────────────────

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is not set. Exiting.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});

const db = admin.firestore();

// ─── Email Transport (lazy) ─────────────────────────────────────────────

let cachedTransport = null;
function getTransport() {
  if (cachedTransport) return cachedTransport;
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.warn("⚠️  MAIL_USER / MAIL_APP_PASSWORD not set. Email disabled.");
    return null;
  }
cachedTransport = nodemailer.createTransport({
         host: "smtp.gmail.com",                                                                              Code Indexing
         port: 465,                                                                                           • Disabled
         secure: true, // SSL — works on Render Free; STARTTLS:587 often blocked
         auth: { user, pass },                                                                                LSP
         pool: true,                                                                                          LSPs are disabled
         maxConnections: 3,
         rateDelta: 1000,                                                                                     ▼ Modified Files
         rateLimit: 5, // nodemailer internal throttle                                                        .env.example                     +12 █
       });
  return cachedTransport;
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

  const transport = getTransport();
  if (!transport) return res.status(503).json({ error: "mail_disabled" });

  try {
    await sendWithRetry({
      from: `"MediFastBD" <${process.env.MAIL_USER}>`,
      to: recipients.join(", "),
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

  const scheduledUTC = dhakaToUtc(
    parts.year, parts.month, parts.day, r.hour, r.minute
  );
  const deadline = new Date(scheduledUTC.getTime() + GRACE_PERIOD_HOURS * 3600000);
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
      await handleMissed(reminderDoc, r, dateKey);
      return;
    }
  }

  await handleMissed(reminderDoc, r, dateKey);
}

async function handleMissed(reminderDoc, reminder, dateKey) {
  const reminderId = reminderDoc.id;
  const userId = reminder.userId;
  const logId = `${reminderId}_${dateKey}`;

  const ctx = { shouldAlert: false, newCount: 0 };

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
      newCount >= 2 &&
      !current.alertSentForCurrentStreak &&
      current.careLinkEnabled &&
      (current.caregiverEmail1 || "").trim().length > 0;

    if (shouldAlert) update.alertSentForCurrentStreak = true;

    tx.update(db.collection("reminders").doc(reminderId), update);

    ctx.shouldAlert = shouldAlert;
    ctx.newCount = newCount;
  });

  if (ctx.shouldAlert) {
    await sendCareLinkEmail(
      userId,
      reminder.medicineName,
      reminder.caregiverEmail1,
      reminder.caregiverEmail2,
      ctx.newCount,
      reminder.hour,
      reminder.minute
    );
  }
}

async function sendCareLinkEmail(
  userId, medicineName, email1, email2, count, hour, minute
) {
  const transport = getTransport();
  if (!transport) return;

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
        <p>MediFastBD CareLink has detected <strong>two or more consecutive missed medication doses</strong>.</p>
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
    from: `"MediFastBD CareLink" <${process.env.MAIL_USER}>`,
    to: recipients.join(", "),
    subject,
    html,
    text: `MediFastBD CareLink – Medication Adherence Alert\n\nPatient: ${patientName}\nMedicine: ${medicineName}\nScheduled: ${time}\nMissed doses: ${count} consecutive\n\nPlease check on the patient if necessary.\n\nThis is an automated message from MediFastBD. Not a medical emergency.`,
  });
  console.log(`  📧 CareLink email → ${recipients.length} caregiver(s)`);
}

// ─── Send with retry ────────────────────────────────────────────────────

async function sendWithRetry(mail, attempts = 3) {
  const transport = getTransport();
  if (!transport) throw new Error("mail_disabled");
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await transport.sendMail(mail);
      return;
    } catch (e) {
      lastErr = e;
      const transient = /ETIMEDOUT|ECONNRESET|EAI_AGAIN|421|4\.7\.0/i.test(e.message || "");
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
