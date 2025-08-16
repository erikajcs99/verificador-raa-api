// server.js
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: "*" }));

// ---------- Health ----------
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ---------- Navegador compartido (más rápido) ----------
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    console.log("[boot] lanzando Chromium…");
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    }).then(b => {
      console.log("[boot] Chromium listo");
      return b;
    }).catch(err => {
      console.error("[boot] fallo al lanzar Chromium:", err);
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

// ---------- Endpoints de debug ----------
app.get("/debug/launch", async (_, res) => {
  try {
    const browser = await getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.close();
    await context.close();
    res.json({ ok: true, stage: "launch-only" });
  } catch (e) {
    console.error("[debug/launch]", e);
    res.status(500).json({ ok: false, stage: "launch-only", error: String(e) });
  }
});

app.get("/debug/example", async (_, res) => {
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 60000 });
    const title = await page.title();
    await ctx.close();
    res.json({ ok: true, stage: "goto-example", title });
  } catch (e) {
    console.error("[debug/example]", e);
    res.status(500).json({ ok: false, stage: "goto-example", error: String(e) });
  }
});

app.get("/debug/raa-title", async (_, res) => {
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext({ userAgent: "Mozilla/5.0" });
    const page = await ctx.newPage();
    await page.goto("https://www.raa.org.co/", { waitUntil: "domcontentloaded", timeout: 90000 });
    const title = await page.title().catch(() => null);
    await ctx.close();
    res.json({ ok: true, stage: "goto-raa", title });
  } catch (e) {
    console.error("[debug/raa-title]", e);
    res.status(500).json({ ok: false, stage: "goto-raa", error: String(e) });
  }
});

// ---------- Helpers de scraping ----------
async function closeMaintenancePopup(page) {
  const start = Date.now();
  const maxMs = 6000;
  const sels = [
    ".ui-dialog .ui-dialog-titlebar .ui-dialog-titlebar-close",
    ".ui-dialog-titlebar-close",
    'button[aria-label="Close"]',
    'button[title="Close"]',
    'button:has-text("×")',
    'button:has-text("Cerrar")',
  ];
  while (Date.now() - start < maxMs) {
    for (const sel of sels) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 150 })) {
          await loc.click({ timeout: 800 });
          await page.waitForTimeout(150);
          if (!(await page.locator(".ui-dialog:visible").count())) return;
        }
      } catch {}
    }
    try { await page.keyboard.press("Escape"); } catch {}
    await page.waitForTimeout(150);
    if (!(await page.locator(".ui-dialog:visible").count())) return;
    try {
      const overlay = page.locator(".ui-widget-overlay, .ui-front.ui-widget-overlay").first();
      if (await overlay.isVisible({ timeout: 150 })) {
        await overlay.click({ timeout: 800 });
        await page.waitForTimeout(150);
        if (!(await page.locator(".ui-dialog:visible").count())) return;
      }
    } catch {}
  }
}

function parse(items) {
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

// ---------- Cache simple ----------
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map();
const hit = (code) => {
  const v = cache.get(code);
  return v && Date.now() - v.at < CACHE_TTL_MS ? v.data : null;
};
const put = (code, data) => cache.set(code, { at: Date.now(), data });

// ---------- Endpoint principal ----------
app.post("/verify", async (req, res) => {
  let raw = String(req.body?.code || "").trim().toUpperCase();
  raw = raw.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[^A-Z0-9-]/g, "");
  if (!/^AVAL-\d{9,11}$/.test(raw)) {
    return res.status(400).json({ valid: false, active: false, reason: "pattern", code: raw });
  }

  const cached = hit(raw);
  if (cached) return res.json({ cached: true, code: raw, ...cached });

  let ctx, page;
  try {
    console.log("[verify] start", raw);
    const browser = await getBrowser();
    ctx = await browser.newContext({ userAgent: "Mozilla/5.0" });
    page = await ctx.newPage();

    console.log("[verify] goto raa");
    await page.goto("https://www.raa.org.co/", { waitUntil: "domcontentloaded", timeout: 90000 });

    console.log("[verify] close modal if any");
    await closeMaintenancePopup(page);

    console.log("[verify] fill code");
    const input = page.locator('input[type="text"], #edit-code').first();
    await input.waitFor({ timeout: 20000 });
    await input.fill(raw);

    console.log("[verify] click submit");
    const btn = page.locator('input[type="submit"][value="Revisar"], #edit-submit, input[value="VALIDAR"]').first();
    await btn.click({ timeout: 20000 });

    console.log("[verify] wait results");
    await page.waitForSelector("div.top-item", { timeout: 90000 });

    const items = await page.$$eval("div.top-item", nodes => nodes.map(n => n.textContent.trim()));
    const parsed = parse(items);
    console.log("[verify] parsed", parsed);

    put(raw, parsed);
    res.json({ cached: false, code: raw, ...parsed });
  } catch (e) {
    console.error("[verify] error", e);
    res.status(502).json({ ok: false, stage: "verify", message: String(e) });
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (ctx) await ctx.close(); } catch {}
  }
});

// ---------- Server ----------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`API de RAA escuchando en :${PORT}`);
});
server.requestTimeout = 180000; // 180s
server.headersTimeout = 180000;
