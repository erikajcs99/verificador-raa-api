// server.js
// API HTTP para verificar códigos RAA con Playwright (Docker/Render)

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// ---- Body parser
app.use(express.json({ limit: "1mb" }));

// ---- CORS COMPLETO (incluye preflight OPTIONS)
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // responde a OPTIONS para todas las rutas

// ---- Health
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ===============================================
//   Lanzar Chromium una sola vez (singleton)
// ===============================================
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    console.log("[boot] lanzando Chromium…");
    browserPromise = chromium
      .launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--no-zygote",
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--disable-features=VizDisplayCompositor",
        ],
      })
      .then((b) => {
        console.log("[boot] Chromium listo");
        return b;
      })
      .catch((err) => {
        console.error("[boot] fallo al lanzar Chromium:", err);
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

// ===============================================
//   Endpoints de debug (opcionales)
// ===============================================
app.get("/debug/launch", async (_req, res) => {
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.close();
    await ctx.close();
    res.json({ ok: true, stage: "launch" });
  } catch (e) {
    console.error("[debug/launch]", e);
    res.status(500).json({ ok: false, stage: "launch", error: String(e) });
  }
});

// Comprobar red sin Chromium
app.get("/debug/node-fetch", async (_req, res) => {
  try {
    const r = await fetch("https://example.com", { redirect: "follow" });
    const text = await r.text();
    res.json({ ok: true, status: r.status, bytes: text.length });
  } catch (e) {
    console.error("[debug/node-fetch]", e);
    res.status(500).json({ ok: false, stage: "node-fetch", error: String(e) });
  }
});

// Abrir example.com con Chromium (solo diagnóstico)
app.get("/debug/example", async (_req, res) => {
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    try {
      await page.goto("https://example.com", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    } catch {
      await page.goto("http://example.com", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }
    const title = await page.title().catch(() => null);
    await ctx.close();
    res.json({ ok: true, stage: "goto-example", title });
  } catch (e) {
    console.error("[debug/example]", e);
    res.status(500).json({ ok: false, stage: "goto-example", error: String(e) });
  }
});

// Título de RAA
app.get("/debug/raa-title", async (_req, res) => {
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0",
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();
    await page.goto("https://www.raa.org.co/", {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    const title = await page.title().catch(() => null);
    await ctx.close();
    res.json({ ok: true, stage: "goto-raa", title });
  } catch (e) {
    console.error("[debug/raa-title]", e);
    res.status(500).json({ ok: false, stage: "goto-raa", error: String(e) });
  }
});

// ===============================================
//   Helpers RAA (cerrar modal de mantenimiento)
// ===============================================
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
    try {
      await page.keyboard.press("Escape");
    } catch {}
    await page.waitForTimeout(150);
    if (!(await page.locator(".ui-dialog:visible").count())) return;
    try {
      const overlay = page
        .locator(".ui-widget-overlay, .ui-front.ui-widget-overlay")
        .first();
      if (await overlay.isVisible({ timeout: 150 })) {
        await overlay.click({ timeout: 800 });
        await page.waitForTimeout(150);
        if (!(await page.locator(".ui-dialog:visible").count())) return;
      }
    } catch {}
  }
}

function parse(items) {
  const nombre = items[0] || null;
  const era = items[1] || null;
  const estado = items[2] || null;
  const fechaRegistro =
    (items.find((t) => t.startsWith("Fecha de registro:")) || "")
      .replace("Fecha de registro:", "")
      .trim() || null;
  const codigo =
    (items.find((t) => t.startsWith("Código:")) || "")
      .replace("Código:", "")
      .trim() || null;
  const fechaAprobacion =
    (items.find((t) => t.startsWith("Fecha de Aprobación:")) || "")
      .replace("Fecha de Aprobación:", "")
      .trim() || null;

  const valid = Boolean(nombre && estado);
  const active = valid && /^activo$/i.test(estado || "");
  return {
    valid,
    active,
    nombre,
    era,
    estado,
    fechaRegistro,
    fechaAprobacion,
    codigo,
  };
}

// Cache simple en memoria (12h)
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map();
const cacheGet = (code) => {
  const v = cache.get(code);
  return v && Date.now() - v.at < CACHE_TTL_MS ? v.data : null;
};
const cachePut = (code, data) => cache.set(code, { at: Date.now(), data });

// ===============================================
//   Endpoint principal: /verify
// ===============================================
app.post("/verify", async (req, res) => {
  // normaliza el código
  let raw = String(req.body?.code || "").trim().toUpperCase();
  raw = raw
    .replace(/[\u2010-\u2015\u2212]/g, "-") // guiones raros → "-"
    .replace(/[^A-Z0-9-]/g, ""); // quita otros símbolos

  // valida patrón
  if (!/^AVAL-\d{1,20}$/.test(raw)) {
    return res
      .status(400)
      .json({ valid: false, active: false, reason: "pattern", code: raw });
  }

  // cache
  const cached = cacheGet(raw);
  if (cached) return res.json({ cached: true, code: raw, ...cached });

  let ctx, page;
  try {
    console.log("[verify] start", raw);
    const browser = await getBrowser();
    ctx = await browser.newContext({
      userAgent: "Mozilla/5.0",
      ignoreHTTPSErrors: true,
    });
    page = await ctx.newPage();

    console.log("[verify] goto raa");
    await page.goto("https://www.raa.org.co/", {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    console.log("[verify] close modal if any");
    await closeMaintenancePopup(page);

    console.log("[verify] fill code");
    const input = page.locator('input[type="text"], #edit-code').first();
    await input.waitFor({ timeout: 20000 });
    await input.fill(raw);

    console.log("[verify] click submit");
    const btn = page
      .locator(
        'input[type="submit"][value="Revisar"], #edit-submit, input[value="VALIDAR"]'
      )
      .first();
    await btn.click({ timeout: 20000 });

    console.log("[verify] wait results");
    await page.waitForSelector("div.top-item", { timeout: 90000 });

    const items = await page.$$eval("div.top-item", (nodes) =>
      nodes.map((n) => n.textContent.trim())
    );
    const parsed = parse(items);
    console.log("[verify] parsed", parsed);

    cachePut(raw, parsed);
    res.json({ cached: false, code: raw, ...parsed });
  } catch (e) {
    console.error("[verify] error", e);
    res.status(502).json({ ok: false, stage: "verify", message: String(e) });
  } finally {
    try {
      if (page) await page.close();
    } catch {}
    try {
      if (ctx) await ctx.close();
    } catch {}
  }
});

// ---- Server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`API de RAA escuchando en :${PORT}`);
});
server.requestTimeout = 180000;
server.headersTimeout = 180000;
