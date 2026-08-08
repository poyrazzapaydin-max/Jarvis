// ============================================================
// JARVIS - Backend-Server
// Übernimmt drei Aufgaben, damit keine Secret-Keys im Frontend-
// Code landen:
//  1) Liefert die statische Frontend-App aus (index.html etc.)
//  2) Kapselt die Gemini-API (Key bleibt serverseitig)
//  3) Kapselt die MEXC-Futures-API inkl. HMAC-Signierung (Secret
//     bleibt serverseitig)
// Zusätzlich: TTS über edge-tts + ein Allzweck-Proxy für News (GDELT).
//
// Alle Keys werden über Umgebungsvariablen (process.env) gelesen,
// NICHT aus einer Datei im Repo. Lokal: lege eine ".env"-Datei an
// (siehe .env.example). Auf Render.com: im Dashboard unter
// "Environment" eintragen.
// ============================================================

try { require('dotenv').config(); } catch (err) { /* dotenv optional, z.B. auf Render nicht nötig */ }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- Konfiguration aus Umgebungsvariablen ----
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const MEXC_API_KEY = process.env.MEXC_API_KEY || '';
const MEXC_API_SECRET = process.env.MEXC_API_SECRET || '';

// ============================================================
// Frontend ausliefern (index.html, config.js entfällt komplett)
// ============================================================
app.use(express.static(path.join(__dirname)));

// ============================================================
// Konfigurations-Status (NIE die echten Keys zurückgeben - nur ob
// sie gesetzt sind. Das Frontend nutzt das für UI-Zustände.)
// ============================================================
app.get('/api/config/status', (req, res) => {
  res.json({
    geminiConfigured: !!GEMINI_API_KEY,
    geminiModel: GEMINI_MODEL,
    mexcConfigured: !!(MEXC_API_KEY && MEXC_API_SECRET)
  });
});

// ============================================================
// Gemini-Proxy - der Browser schickt nur { contents, systemInstruction },
// der Key wird hier serverseitig angehängt und nie an den Client gesendet.
// ============================================================
app.post('/api/gemini/generate', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(400).json({ error: { message: 'Gemini ist serverseitig nicht konfiguriert (GEMINI_API_KEY fehlt).' } });
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    console.error('Gemini-Proxy-Fehler:', err);
    res.status(500).json({ error: { message: err.message || 'Gemini-Proxy-Fehler.' } });
  }
});

// ============================================================
// MEXC-Futures-Proxy (signiert serverseitig, Secret bleibt hier)
// Das Frontend schickt nur { path, params }, z.B.
// { path: "/api/v1/private/account/assets", params: {} }
// ============================================================
app.post('/api/mexc/signed', async (req, res) => {
  if (!MEXC_API_KEY || !MEXC_API_SECRET) {
    return res.status(400).json({ error: 'MEXC ist serverseitig nicht konfiguriert (MEXC_API_KEY/MEXC_API_SECRET fehlen).' });
  }
  const { path: mexcPath, params } = req.body || {};
  if (!mexcPath || !mexcPath.startsWith('/api/v1/private/')) {
    return res.status(400).json({ error: 'Ungültiger oder nicht erlaubter Pfad.' });
  }

  try {
    const timestamp = String(Date.now());
    const safeParams = params || {};
    const sortedKeys = Object.keys(safeParams).sort();
    const requestParamString = sortedKeys.map(k => `${k}=${safeParams[k]}`).join('&');
    const signTarget = MEXC_API_KEY + timestamp + requestParamString;
    const signature = crypto.createHmac('sha256', MEXC_API_SECRET).update(signTarget).digest('hex');

    const url = `https://contract.mexc.com${mexcPath}${requestParamString ? '?' + requestParamString : ''}`;
    const upstream = await fetch(url, {
      headers: {
        'ApiKey': MEXC_API_KEY,
        'Request-Time': timestamp,
        'Signature': signature,
        'Content-Type': 'application/json'
      }
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    console.error('MEXC-Proxy-Fehler:', err);
    res.status(500).json({ error: err.message || 'MEXC-Proxy-Fehler.' });
  }
});

// ============================================================
// Sprachausgabe über edge-tts (msedge-tts) - kein Key nötig.
// Ruhige, männliche deutsche Stimme als Standard.
// ============================================================
const DEFAULT_VOICE = 'de-DE-ConradNeural';
const ALLOWED_VOICES = new Set([
  'de-DE-ConradNeural',
  'de-DE-KillianNeural',
  'de-DE-FlorianMultilingualNeural'
]);

app.post('/api/tts', async (req, res) => {
  const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
  const requestedVoice = req.body && req.body.voice ? String(req.body.voice) : '';
  const voice = ALLOWED_VOICES.has(requestedVoice) ? requestedVoice : DEFAULT_VOICE;

  if (!text) {
    return res.status(400).json({ error: 'Kein Text übergeben.' });
  }

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);

    res.setHeader('Content-Type', 'audio/mpeg');
    audioStream.pipe(res);
    audioStream.on('error', (err) => {
      console.error('TTS-Stream-Fehler:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Fehler bei der Sprachsynthese.' });
    });
  } catch (err) {
    console.error('TTS-Fehler:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Fehler bei der Sprachsynthese.' });
  }
});

app.get('/api/tts/health', (req, res) => {
  res.json({ ok: true, defaultVoice: DEFAULT_VOICE, allowedVoices: [...ALLOWED_VOICES] });
});

// ============================================================
// Allzweck-Proxy (nur lesend, feste Host-Allowlist)
// Manche APIs setzen keine CORS-Header, ein Browser blockiert
// direkte Anfragen dorthin dann mit "Failed to fetch". Node
// unterliegt dieser Browser-Beschränkung nicht.
// - GDELT: News-Suche für die News-Seite (kein Key nötig)
// ============================================================
const PROXY_ALLOWED_HOSTS = new Set(['api.gdeltproject.org']);

app.post('/api/mexc-proxy', async (req, res) => {
  try {
    const { url, headers } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Keine URL übergeben.' });

    const target = new URL(url);
    if (!PROXY_ALLOWED_HOSTS.has(target.hostname)) {
      return res.status(400).json({ error: 'Nicht erlaubter Host.' });
    }

    const upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: headers || {}
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    console.error('Proxy-Fehler:', err);
    res.status(500).json({ error: err.message || 'Proxy-Fehler.' });
  }
});

// ============================================================
// AUTO TRADER - Paper Trading (reine Simulation)
//
// SICHERHEIT: Dieser gesamte Block liest NUR öffentliche Binance-
// Kursdaten (keine Authentifizierung, kein MEXC-Zugriff) und
// verändert ausschließlich lokal gespeicherte, simulierte Werte.
// Es gibt hier KEINEN Codepfad, der eine echte Order auf MEXC oder
// einer anderen Börse auslösen könnte. NICHT AUTOMATISCH AUSFÜHREN
// - NUR SIMULATION. Falls das jemals in echten Handel überführt
// werden soll, müsste an dieser Stelle bewusst und separat ein
// echter, signierter Order-Endpoint ergänzt werden - das ist NICHT
// Teil dieses Codes.
// ============================================================
const PAPER_DATA_FILE = path.join(__dirname, 'paper-trading-data.json');

const PAPER_DEFAULT_SETTINGS = {
  enabled: false,
  riskPerTradeEur: 0.5,
  riskRewardRatio: 2,
  watchedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  startCapitalEur: 100,
  maxOpenPositions: 3
};

function loadPaperData() {
  try {
    const raw = fs.readFileSync(PAPER_DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.settings = { ...PAPER_DEFAULT_SETTINGS, ...(parsed.settings || {}) };
    parsed.lastPrices = parsed.lastPrices || {};
    return parsed;
  } catch (err) {
    return {
      settings: { ...PAPER_DEFAULT_SETTINGS },
      balanceEur: PAPER_DEFAULT_SETTINGS.startCapitalEur,
      balanceHistory: [{ time: Date.now(), balance: PAPER_DEFAULT_SETTINGS.startCapitalEur }],
      openTrades: [],
      closedTrades: [],
      lastPrices: {},
      lastCheck: null
    };
  }
}

function savePaperData() {
  try {
    fs.writeFileSync(PAPER_DATA_FILE, JSON.stringify(paperData, null, 2));
  } catch (err) {
    console.error('Paper-Trading: Speichern fehlgeschlagen:', err);
  }
}

let paperData = loadPaperData();

async function fetchPaperCandles(symbol, interval = '15m', limit = 200) {
  const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`Kline-Fehler für ${symbol}: HTTP ${res.status}`);
  const raw = await res.json();
  return raw.map(k => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) }));
}

// Lokale Hoch-/Tiefpunkte: eine Kerze gilt als "lokal", wenn ihr High/Low
// extremer ist als das der `lookback` Kerzen davor UND danach.
function findLocalExtrema(candles, lookback = 4) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const windowSlice = candles.slice(i - lookback, i + lookback + 1);
    if (candles[i].high === Math.max(...windowSlice.map(c => c.high))) {
      highs.push({ index: i, price: candles[i].high });
    }
    if (candles[i].low === Math.min(...windowSlice.map(c => c.low))) {
      lows.push({ index: i, price: candles[i].low });
    }
  }
  return { highs, lows };
}

// Vereinfachte Heuristik, keine Garantie für korrekte Mustererkennung.
// Erkennt: Liquidation Sweep (Docht durchbricht ein vorheriges lokales
// Hoch/Tief, Schlusskurs kehrt zurück) gefolgt von einem Break of
// Structure (Schlusskurs durchbricht ein vorheriges lokales Hoch/Tief)
// innerhalb eines Fensters von ~15 Kerzen, nahe (<=2%) der Sweep-Zone.
// Interpretation der "Support/Resistance-Nähe": die gesweepte Zone
// selbst dient als Referenzlevel für die Abstandsprüfung.
function detectPaperSetup(candles) {
  const { highs, lows } = findLocalExtrema(candles, 4);
  const n = candles.length;
  const windowSize = 15;
  const searchStart = Math.max(0, n - windowSize - 10);

  const downSweeps = [];
  const upBos = [];
  for (let i = searchStart; i < n; i++) {
    const priorLows = lows.filter(l => l.index < i);
    if (priorLows.length) {
      const refLow = priorLows[priorLows.length - 1];
      if (candles[i].low < refLow.price && candles[i].close > refLow.price) {
        downSweeps.push({ index: i, sweptLevel: refLow.price, sweepExtreme: candles[i].low });
      }
    }
    const priorHighs = highs.filter(h => h.index < i);
    if (priorHighs.length) {
      const refHigh = priorHighs[priorHighs.length - 1];
      if (candles[i].close > refHigh.price) {
        upBos.push({ index: i, brokenLevel: refHigh.price });
      }
    }
  }
  for (const sweep of downSweeps) {
    const bos = upBos.find(b => b.index > sweep.index && b.index - sweep.index <= windowSize);
    if (bos) {
      const distancePct = Math.abs(candles[bos.index].close - sweep.sweptLevel) / sweep.sweptLevel * 100;
      if (distancePct <= 2) {
        return {
          direction: 'long',
          sweepExtreme: sweep.sweepExtreme,
          reason: `Liquidation Sweep unter ${sweep.sweptLevel.toFixed(4)}, danach Break of Structure über ${bos.brokenLevel.toFixed(4)} (${distancePct.toFixed(2)}% Abstand zur Zone).`
        };
      }
    }
  }

  const upSweeps = [];
  const downBos = [];
  for (let i = searchStart; i < n; i++) {
    const priorHighs = highs.filter(h => h.index < i);
    if (priorHighs.length) {
      const refHigh = priorHighs[priorHighs.length - 1];
      if (candles[i].high > refHigh.price && candles[i].close < refHigh.price) {
        upSweeps.push({ index: i, sweptLevel: refHigh.price, sweepExtreme: candles[i].high });
      }
    }
    const priorLows = lows.filter(l => l.index < i);
    if (priorLows.length) {
      const refLow = priorLows[priorLows.length - 1];
      if (candles[i].close < refLow.price) {
        downBos.push({ index: i, brokenLevel: refLow.price });
      }
    }
  }
  for (const sweep of upSweeps) {
    const bos = downBos.find(b => b.index > sweep.index && b.index - sweep.index <= windowSize);
    if (bos) {
      const distancePct = Math.abs(candles[bos.index].close - sweep.sweptLevel) / sweep.sweptLevel * 100;
      if (distancePct <= 2) {
        return {
          direction: 'short',
          sweepExtreme: sweep.sweepExtreme,
          reason: `Liquidation Sweep über ${sweep.sweptLevel.toFixed(4)}, danach Break of Structure unter ${bos.brokenLevel.toFixed(4)} (${distancePct.toFixed(2)}% Abstand zur Zone).`
        };
      }
    }
  }

  return null;
}

function computePaperTradePlan(direction, entryPrice, sweepExtreme, settings) {
  const bufferPct = 0.0015;
  let stopLoss, distance;
  if (direction === 'long') {
    stopLoss = sweepExtreme * (1 - bufferPct);
    distance = entryPrice - stopLoss;
  } else {
    stopLoss = sweepExtreme * (1 + bufferPct);
    distance = stopLoss - entryPrice;
  }
  const distancePct = distance / entryPrice;
  const takeProfit = direction === 'long'
    ? entryPrice + distance * settings.riskRewardRatio
    : entryPrice - distance * settings.riskRewardRatio;
  const positionSizeEur = distancePct > 0 ? settings.riskPerTradeEur / distancePct : 0;
  return { stopLoss, takeProfit, positionSizeEur };
}

// NUR SIMULATION - prüft offene Paper-Trades auf SL/TP und öffnet ggf.
// neue Paper-Trades. Löst zu keinem Zeitpunkt eine echte Order aus.
async function checkPaperSymbol(symbol) {
  const candles = await fetchPaperCandles(symbol, '15m', 200);
  const lastPrice = candles[candles.length - 1].close;
  paperData.lastPrices[symbol] = lastPrice;

  paperData.openTrades = paperData.openTrades.filter(trade => {
    if (trade.symbol !== symbol) return true;
    let closeReason = null;
    if (trade.direction === 'long') {
      if (lastPrice >= trade.takeProfit) closeReason = 'TP';
      else if (lastPrice <= trade.stopLoss) closeReason = 'SL';
    } else {
      if (lastPrice <= trade.takeProfit) closeReason = 'TP';
      else if (lastPrice >= trade.stopLoss) closeReason = 'SL';
    }
    if (!closeReason) return true;

    const exitPrice = lastPrice;
    const pnlEur = trade.direction === 'long'
      ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
      : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;
    paperData.balanceEur += pnlEur;
    paperData.balanceHistory.push({ time: Date.now(), balance: paperData.balanceEur });
    paperData.closedTrades.unshift({ ...trade, exitPrice, closeReason, pnlEur, closedAt: Date.now() });
    if (paperData.closedTrades.length > 200) paperData.closedTrades.length = 200;
    return false;
  });

  const hasOpenForSymbol = paperData.openTrades.some(t => t.symbol === symbol);
  if (hasOpenForSymbol || paperData.openTrades.length >= paperData.settings.maxOpenPositions) return;

  const setup = detectPaperSetup(candles);
  if (!setup) return;

  const entryPrice = lastPrice;
  const plan = computePaperTradePlan(setup.direction, entryPrice, setup.sweepExtreme, paperData.settings);
  paperData.openTrades.push({
    id: crypto.randomUUID(),
    symbol,
    direction: setup.direction,
    entryPrice,
    stopLoss: plan.stopLoss,
    takeProfit: plan.takeProfit,
    positionSizeEur: plan.positionSizeEur,
    riskEur: paperData.settings.riskPerTradeEur,
    reason: setup.reason,
    openedAt: Date.now()
  });
}

async function runPaperTradingCycle() {
  if (!paperData.settings.enabled) return;
  for (const symbol of paperData.settings.watchedSymbols) {
    try {
      await checkPaperSymbol(symbol);
    } catch (err) {
      console.error(`Paper-Trading-Fehler bei ${symbol}:`, err.message || err);
    }
  }
  paperData.lastCheck = Date.now();
  savePaperData();
}

const PAPER_CHECK_INTERVAL_MS = 7 * 60 * 1000; // alle 7 Minuten (Vorgabe: 5-10 Min)
setInterval(runPaperTradingCycle, PAPER_CHECK_INTERVAL_MS);

app.get('/api/paper-trading/state', (req, res) => {
  const openWithPnl = paperData.openTrades.map(t => {
    const currentPrice = paperData.lastPrices[t.symbol] ?? null;
    let unrealizedPnlEur = null;
    if (currentPrice != null) {
      unrealizedPnlEur = t.direction === 'long'
        ? (currentPrice - t.entryPrice) / t.entryPrice * t.positionSizeEur
        : (t.entryPrice - currentPrice) / t.entryPrice * t.positionSizeEur;
    }
    return { ...t, currentPrice, unrealizedPnlEur };
  });
  res.json({ ...paperData, openTrades: openWithPnl });
});

app.post('/api/paper-trading/settings', (req, res) => {
  const incoming = req.body || {};
  const wasEnabled = paperData.settings.enabled;
  paperData.settings = {
    enabled: !!incoming.enabled,
    riskPerTradeEur: Number(incoming.riskPerTradeEur) > 0 ? Number(incoming.riskPerTradeEur) : paperData.settings.riskPerTradeEur,
    riskRewardRatio: Number(incoming.riskRewardRatio) > 0 ? Number(incoming.riskRewardRatio) : paperData.settings.riskRewardRatio,
    watchedSymbols: Array.isArray(incoming.watchedSymbols) && incoming.watchedSymbols.length ? incoming.watchedSymbols : paperData.settings.watchedSymbols,
    startCapitalEur: Number(incoming.startCapitalEur) > 0 ? Number(incoming.startCapitalEur) : paperData.settings.startCapitalEur,
    maxOpenPositions: Number(incoming.maxOpenPositions) > 0 ? Number(incoming.maxOpenPositions) : paperData.settings.maxOpenPositions
  };
  savePaperData();
  if (paperData.settings.enabled && !wasEnabled) runPaperTradingCycle();
  res.json({ ok: true, settings: paperData.settings });
});

app.post('/api/paper-trading/reset', (req, res) => {
  paperData = {
    settings: paperData.settings,
    balanceEur: paperData.settings.startCapitalEur,
    balanceHistory: [{ time: Date.now(), balance: paperData.settings.startCapitalEur }],
    openTrades: [],
    closedTrades: [],
    lastPrices: {},
    lastCheck: null
  };
  savePaperData();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 5055;
app.listen(PORT, () => {
  console.log(`Jarvis-Server läuft auf http://localhost:${PORT}`);
  console.log(`Gemini konfiguriert: ${!!GEMINI_API_KEY} (Modell: ${GEMINI_MODEL})`);
  console.log(`MEXC konfiguriert: ${!!(MEXC_API_KEY && MEXC_API_SECRET)}`);
});
