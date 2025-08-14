const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

/** ====== util: cache simple en memoria (TTL 12h) ====== */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map(); // key=code, value={ at:number, data:any }
function getCached(code) {
  const hit = cache.get(code);
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.data : null;
}
function setCached(code, data) {
  cache.set(code, { at: Date.now(), data });
}

/** ====== util: rate‑limit básico por IP (una cada 5s) ====== */
const lastHit = new Map(); // key=ip, value=timestamp
function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const now = Date.now();
  const prev = lastHit.get(ip) || 0;
  if (now - prev < 5000) {
    return res.status(429).json({ error: "rate_limited", retryInMs: 5000 - (now - prev) });
  }
  lastHit.set(ip, now);
  next();
}

/** ====== cerrar modal de mantenimiento con varias estrategias ====== */
async function closeMaintenancePopup(page) {
  const start = Date.now();
  const maxMs = 6000;
  const selectors = [
    ".ui-dialog .ui-dialog-titlebar .ui-dialog-titlebar-close",
    ".ui-dialog-titlebar-close",
    'button[aria-label="Close"]',
    'button[title="Close"]',
    'button:has-text("×")',
    'button:has-text("Cerrar")',
  ];
  while (Date.now() - start < maxMs) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 150 })) {
          await loc.click({ timeout: 800 });
          await page.waitForTimeout(150);
          if (!(await page.locator(".ui-dialog:visible").count())) return;
        }
      } catch (_) {}
    }
    try {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      if (!(await page.locator(".ui-dialog:visible").count())) return;
    } catch (_) {}
    try {
      const overlay = page.locator(".ui-widget-overlay, .ui-front.ui-widget-overlay").first();
      if (await overlay.isVisible({ timeout: 150 })) {
        await overlay.click({ timeout: 800 });
        await page.waitForTimeout(150);
        if (!(await page.locator(".ui-dialog:visible").count())) return;
      }
    } catch (_) {}
    await page.waitForTimeout(150);
  }
}

function parseTopItems(items) {
  const nombre        = items[0] || null;
  const era           = items[1] || null;
  const estado        = items[2] || null;
  const fechaRegistro = (items.find(t => t.startsWith("Fecha de registro:")) || "")
                        .replace("Fecha de registro:", "").trim() || null;
  const codigo        = (items.find(t => t.startsWith("Código:")) || "")
                        .replace("Código:", "").trim() || null;
  const fechaAprob    = (items.find(t => t.startsWith("Fecha de Aprobación:")) || "")
                        .replace("Fecha de Aprobación:", "").trim() || null;
  const valid  = Boolean(nombre && estado);
  const active = valid && /^activo$/i.test(estado || "");
  return { valid, active, nombre, era, estado, fechaRegistro, fechaAprobacion: fechaAprob, codigo };
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: "*"})); // si deseas, restringe al dominio de Lovable

app.post("/verify", rateLimit, async (req, res) => {
  let raw = String(req.body?.code || "").trim().toUpperCase();
  raw = raw.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[^A-Z0-9-]/g, "");
  if (!/^AVAL-\d{9,11}$/.test(raw)) {
    return res.status(400).json({ valid: false, active: false, reason: "pattern", code: raw });
  }

  // cache
  const cached = getCached(raw);
  if (cached) return res.json({ cached: true, code: raw, ...cached });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage({ userAgent: "Mozilla/5.0" });
    await page.goto("https://www.raa.org.co/", { waitUntil: "domcontentloaded", timeout: 45000 });

    await closeMaintenancePopup(page);

    const input = page.locator('input[type="text"], #edit-code').first();
    await input.waitFor({ timeout: 15000 });
    await input.fill(raw);

    const btn = page.locator('input[type="submit"][value="Revisar"], #edit-submit, input[value="VALIDAR"]').first();
    await btn.click({ timeout: 15000 });

    await page.waitForSelector("div.top-item", { timeout: 30000 });
    const items = await page.$$eval("div.top-item", nodes => nodes.map(n => n.textContent.trim()));
    const parsed = parseTopItems(items);

    setCached(raw, parsed);
    return res.json({ cached: false, code: raw, ...parsed });
  } catch (err) {
    console.error("verify error:", err);
    return res.status(502).json({ ok: false, error: "upstream_or_parse", message: String(err) });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RAA API listening on :${PORT}`));
