// server.js
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: "*" }));

// --- healthchecks para Render/tu prueba ---
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.json({ ok: true }));

// cache simple (12h)
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map();
const hit = (code) => {
  const v = cache.get(code);
  return v && Date.now() - v.at < CACHE_TTL_MS ? v.data : null;
};
const put = (code, data) => cache.set(code, { at: Date.now(), data });

// cierra modal mantenimiento (igual que local)
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
      } catch {}
    }
    try {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      if (!(await page.locator(".ui-dialog:visible").count())) return;
    } catch {}
    try {
      const overlay = page.locator(".ui-widget-overlay, .ui-front.ui-widget-overlay").first();
      if (await overlay.isVisible({ timeout: 150 })) {
        await overlay.click({ timeout: 800 });
        await page.waitForTimeout(150);
        if (!(await page.locator(".ui-dialog:visible").count())) return;
      }
    } catch {}
    await page.waitForTimeout(150);
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

app.post("/verify", async (req, res) => {
  let raw = String(req.body?.code || "").trim().toUpperCase();
  raw = raw.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[^A-Z0-9-]/g, "");
  if (!/^AVAL-\d{9,11}$/.test(raw)) {
    return res.status(400).json({ valid: false, active: false, reason: "pattern", code: raw });
  }

  // cache
  const cached = hit(raw);
  if (cached) return res.json({ cached: true, code: raw, ...cached });

  let browser;
  try {
    // ⚠️ flags recomendados para contenedores (evitan 502 por crash/timeout)
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // evita /dev/shm pequeño en contenedores
      ],
    });

    const page = await browser.newPage({ userAgent: "Mozilla/5.0" });
    await page.goto("https://www.raa.org.co/", { waitUntil: "domcontentloaded", timeout: 90000 });

    await closeMaintenancePopup(page);

    const input = page.locator('input[type="text"], #edit-code').first();
    await input.waitFor({ timeout: 20000 });
    await input.fill(raw);

    const btn = page.locator('input[type="submit"][value="Revisar"], #edit-submit, input[value="VALIDAR"]').first();
    await btn.click({ timeout: 20000 });

    await page.waitForSelector("div.top-item", { timeout: 90000 });
    const items = await page.$$eval("div.top-item", nodes => nodes.map(n => n.textContent.trim()));
    const parsed = parse(items);

    put(raw, parsed);
    return res.json({ cached: false, code: raw, ...parsed });
  } catch (err) {
    console.error("verify error:", err);
    return res.status(502).json({ ok: false, error: "upstream_or_browser", message: String(err) });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("////////////////////////////////////////");
  console.log(`API de RAA escuchando en :${PORT}`);
  console.log("////////////////////////////////////////");
});
