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

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- Konfiguration aus Umgebungsvariablen ----
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const MEXC_API_KEY = process.env.MEXC_API_KEY || '';
const MEXC_API_SECRET = process.env.MEXC_API_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// ---- Postgres-Verbindung (für Auto-Trader / Paper-Trading-Daten) ----
// Render-Postgres verlangt SSL, erlaubt aber kein eigenes Zertifikat -
// daher rejectUnauthorized:false (Standardpraxis für Render/Heroku-Postgres).
const pgPool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

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
const PAPER_DEFAULT_SETTINGS = {
  enabled: false,
  riskPerTradeEur: 0.5,
  riskRewardRatio: 2,
  watchedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  startCapitalEur: 100,
  maxOpenPositions: 3,
  leverage: 5
};

// In-Memory-Cache nur für zuletzt gesehene Live-Preise (rein informativ
// für "unrealized P/L" in der UI, keine persistenten Daten, muss nicht
// in der DB liegen).
const paperLastPrices = {};

// Legt die Tabellen an, falls sie noch nicht existieren, und sorgt für
// genau eine Einstellungs-Zeile (Singleton, id=1).
async function initPaperTradingSchema() {
  if (!pgPool) {
    console.warn('Paper-Trading: DATABASE_URL nicht gesetzt - Auto Trader ist deaktiviert.');
    return;
  }
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      risk_per_trade_eur NUMERIC NOT NULL DEFAULT 0.5,
      risk_reward_ratio NUMERIC NOT NULL DEFAULT 2,
      watched_symbols TEXT[] NOT NULL DEFAULT ARRAY['BTCUSDT','ETHUSDT','SOLUSDT'],
      start_capital_eur NUMERIC NOT NULL DEFAULT 100,
      balance_eur NUMERIC NOT NULL DEFAULT 100,
      max_open_positions INTEGER NOT NULL DEFAULT 3,
      leverage INTEGER NOT NULL DEFAULT 5,
      last_check TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      stop_loss NUMERIC NOT NULL,
      take_profit NUMERIC NOT NULL,
      position_size_eur NUMERIC NOT NULL,
      risk_eur NUMERIC NOT NULL,
      leverage INTEGER NOT NULL DEFAULT 1,
      margin_eur NUMERIC NOT NULL DEFAULT 0,
      liquidation_price NUMERIC,
      liquidates_first BOOLEAN NOT NULL DEFAULT false,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL,
      exit_price NUMERIC,
      close_reason TEXT,
      pnl_eur NUMERIC,
      closed_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_balance_history (
      id SERIAL PRIMARY KEY,
      time TIMESTAMPTZ NOT NULL DEFAULT now(),
      balance NUMERIC NOT NULL
    );
  `);
  const { rows } = await pgPool.query('SELECT id FROM paper_settings WHERE id = 1');
  if (!rows.length) {
    await pgPool.query(
      `INSERT INTO paper_settings (id, enabled, risk_per_trade_eur, risk_reward_ratio, watched_symbols, start_capital_eur, balance_eur, leverage)
       VALUES (1, false, $1, $2, $3, $4, $4, $5)`,
      [PAPER_DEFAULT_SETTINGS.riskPerTradeEur, PAPER_DEFAULT_SETTINGS.riskRewardRatio, PAPER_DEFAULT_SETTINGS.watchedSymbols, PAPER_DEFAULT_SETTINGS.startCapitalEur, PAPER_DEFAULT_SETTINGS.leverage]
    );
    await pgPool.query('INSERT INTO paper_balance_history (balance) VALUES ($1)', [PAPER_DEFAULT_SETTINGS.startCapitalEur]);
  }
}

function rowToSettings(row) {
  return {
    enabled: row.enabled,
    riskPerTradeEur: Number(row.risk_per_trade_eur),
    riskRewardRatio: Number(row.risk_reward_ratio),
    watchedSymbols: row.watched_symbols,
    startCapitalEur: Number(row.start_capital_eur),
    balanceEur: Number(row.balance_eur),
    maxOpenPositions: Number(row.max_open_positions),
    leverage: Number(row.leverage),
    lastCheck: row.last_check ? new Date(row.last_check).getTime() : null
  };
}

async function getPaperSettings() {
  const { rows } = await pgPool.query('SELECT * FROM paper_settings WHERE id = 1');
  return rowToSettings(rows[0]);
}

function rowToTrade(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    positionSizeEur: Number(row.position_size_eur),
    riskEur: Number(row.risk_eur),
    leverage: Number(row.leverage),
    marginEur: Number(row.margin_eur),
    liquidationPrice: row.liquidation_price != null ? Number(row.liquidation_price) : null,
    liquidatesFirst: row.liquidates_first,
    reason: row.reason,
    openedAt: new Date(row.opened_at).getTime(),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    closeReason: row.close_reason,
    pnlEur: row.pnl_eur != null ? Number(row.pnl_eur) : null,
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null
  };
}

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

// Hebel-Berechnung (siehe Erklärung im Chat für die Herleitung):
// - Der Stop-Loss bleibt am technischen Sweep-Level (unverändert durch Hebel).
// - Positionsgröße (Nominalwert) = Max. Risiko€ * Hebel / prozentualer SL-Abstand,
//   d.h. bei höherem Hebel wird für dasselbe Margin-Kapital eine größere
//   Position eröffnet -> derselbe technische SL/TP-Move ergibt ein um den
//   Hebel vervielfachtes Euro-Ergebnis.
// - Margin (eingesetztes Kapital) = Positionsgröße / Hebel = Risiko€ / SL-Abstand%
//   (unabhängig vom Hebel - der Hebel bestimmt nur, wie viel Nominalwert
//   diese Margin kontrolliert).
// - Liquidationspreis (grobe Näherung, ohne Gebühren/Maintenance-Margin):
//   ca. 1/Hebel prozentuale Gegenbewegung vom Einstieg entfernt.
// - Liegt der Liquidationspreis NÄHER am Einstieg als der technische SL,
//   würde die Position real schon vor dem SL liquidiert werden -> Warnung
//   (liquidatesFirst) und die Simulation behandelt das als Totalverlust
//   der Margin statt eines normalen SL-Treffers.
function computePaperTradePlan(direction, entryPrice, sweepExtreme, settings) {
  const bufferPct = 0.0015;
  const leverage = Math.max(1, Number(settings.leverage) || 1);
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

  const positionSizeEur = distancePct > 0 ? (settings.riskPerTradeEur * leverage) / distancePct : 0;
  const marginEur = leverage > 0 ? positionSizeEur / leverage : positionSizeEur;

  const liquidationDistancePct = 1 / leverage;
  const liquidationPrice = direction === 'long'
    ? entryPrice * (1 - liquidationDistancePct)
    : entryPrice * (1 + liquidationDistancePct);
  const liquidatesFirst = liquidationDistancePct < distancePct;

  return { stopLoss, takeProfit, positionSizeEur, marginEur, leverage, liquidationPrice, liquidatesFirst };
}

// NUR SIMULATION - prüft offene Paper-Trades auf SL/TP und öffnet ggf.
// neue Paper-Trades. Löst zu keinem Zeitpunkt eine echte Order aus.
// maxOpenPositions wird als Parameter übergeben (statt erneut abgefragt),
// da mehrere Coins pro Zyklus dieselbe Settings-Zeile teilen.
async function checkPaperSymbol(symbol, settings) {
  const candles = await fetchPaperCandles(symbol, '15m', 200);
  const lastPrice = candles[candles.length - 1].close;
  paperLastPrices[symbol] = lastPrice;

  const { rows: openRows } = await pgPool.query(
    "SELECT * FROM paper_trades WHERE symbol = $1 AND status = 'open'",
    [symbol]
  );

  for (const row of openRows) {
    const trade = rowToTrade(row);
    let closeReason = null;
    let exitPrice = lastPrice;
    let pnlEur = null;

    // NUR SIMULATION: Liquidation wird zuerst geprüft, da der Liquidationspreis
    // bei hohem Hebel näher am Einstieg liegen kann als der technische SL -
    // in der Realität würde die Position dann bereits vorher zwangsgeschlossen.
    const liquidationHit = trade.liquidationPrice != null && trade.direction === 'long'
      ? lastPrice <= trade.liquidationPrice
      : trade.liquidationPrice != null && lastPrice >= trade.liquidationPrice;

    if (trade.liquidatesFirst && liquidationHit) {
      closeReason = 'LIQUIDATION';
      exitPrice = trade.liquidationPrice;
      pnlEur = -trade.marginEur; // Totalverlust der Margin
    } else if (trade.direction === 'long') {
      if (lastPrice >= trade.takeProfit) closeReason = 'TP';
      else if (lastPrice <= trade.stopLoss) closeReason = 'SL';
    } else {
      if (lastPrice <= trade.takeProfit) closeReason = 'TP';
      else if (lastPrice >= trade.stopLoss) closeReason = 'SL';
    }
    if (!closeReason) continue;

    if (pnlEur === null) {
      pnlEur = trade.direction === 'long'
        ? (exitPrice - trade.entryPrice) / trade.entryPrice * trade.positionSizeEur
        : (trade.entryPrice - exitPrice) / trade.entryPrice * trade.positionSizeEur;
    }

    await pgPool.query(
      `UPDATE paper_trades SET status = 'closed', exit_price = $1, close_reason = $2, pnl_eur = $3, closed_at = now() WHERE id = $4`,
      [exitPrice, closeReason, pnlEur, trade.id]
    );
    const { rows: balRows } = await pgPool.query(
      'UPDATE paper_settings SET balance_eur = balance_eur + $1 WHERE id = 1 RETURNING balance_eur',
      [pnlEur]
    );
    await pgPool.query('INSERT INTO paper_balance_history (balance) VALUES ($1)', [Number(balRows[0].balance_eur)]);
  }

  const { rows: stillOpenForSymbol } = await pgPool.query(
    "SELECT COUNT(*)::int AS c FROM paper_trades WHERE symbol = $1 AND status = 'open'",
    [symbol]
  );
  if (stillOpenForSymbol[0].c > 0) return;

  const { rows: totalOpenRows } = await pgPool.query("SELECT COUNT(*)::int AS c FROM paper_trades WHERE status = 'open'");
  if (totalOpenRows[0].c >= settings.maxOpenPositions) return;

  const setup = detectPaperSetup(candles);
  if (!setup) return;

  const entryPrice = lastPrice;
  const plan = computePaperTradePlan(setup.direction, entryPrice, setup.sweepExtreme, settings);
  await pgPool.query(
    `INSERT INTO paper_trades (id, symbol, direction, entry_price, stop_loss, take_profit, position_size_eur, risk_eur, leverage, margin_eur, liquidation_price, liquidates_first, reason, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'open', now())`,
    [crypto.randomUUID(), symbol, setup.direction, entryPrice, plan.stopLoss, plan.takeProfit, plan.positionSizeEur, settings.riskPerTradeEur, plan.leverage, plan.marginEur, plan.liquidationPrice, plan.liquidatesFirst, setup.reason]
  );
}

async function runPaperTradingCycle() {
  if (!pgPool) return;
  const settings = await getPaperSettings();
  if (!settings.enabled) return;
  for (const symbol of settings.watchedSymbols) {
    try {
      await checkPaperSymbol(symbol, settings);
    } catch (err) {
      console.error(`Paper-Trading-Fehler bei ${symbol}:`, err.message || err);
    }
  }
  await pgPool.query('UPDATE paper_settings SET last_check = now() WHERE id = 1');
}

const PAPER_CHECK_INTERVAL_MS = 7 * 60 * 1000; // alle 7 Minuten (Vorgabe: 5-10 Min)
setInterval(runPaperTradingCycle, PAPER_CHECK_INTERVAL_MS);

app.get('/api/paper-trading/state', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Auto Trader nicht verfügbar.' });
  try {
    const settings = await getPaperSettings();
    const { rows: openRows } = await pgPool.query("SELECT * FROM paper_trades WHERE status = 'open' ORDER BY opened_at DESC");
    const { rows: closedRows } = await pgPool.query("SELECT * FROM paper_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 200");
    const { rows: historyRows } = await pgPool.query('SELECT time, balance FROM paper_balance_history ORDER BY time ASC');

    const openTrades = openRows.map(rowToTrade).map(t => {
      const currentPrice = paperLastPrices[t.symbol] ?? null;
      let unrealizedPnlEur = null;
      if (currentPrice != null) {
        unrealizedPnlEur = t.direction === 'long'
          ? (currentPrice - t.entryPrice) / t.entryPrice * t.positionSizeEur
          : (t.entryPrice - currentPrice) / t.entryPrice * t.positionSizeEur;
      }
      return { ...t, currentPrice, unrealizedPnlEur };
    });
    const closedTrades = closedRows.map(rowToTrade);
    const balanceHistory = historyRows.map(r => ({ time: new Date(r.time).getTime(), balance: Number(r.balance) }));

    res.json({ settings, balanceEur: settings.balanceEur, balanceHistory, openTrades, closedTrades, lastCheck: settings.lastCheck });
  } catch (err) {
    console.error('Paper-Trading: state-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/paper-trading/settings', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Auto Trader nicht verfügbar.' });
  try {
    const incoming = req.body || {};
    const current = await getPaperSettings();
    const wasEnabled = current.enabled;
    const next = {
      enabled: !!incoming.enabled,
      riskPerTradeEur: Number(incoming.riskPerTradeEur) > 0 ? Number(incoming.riskPerTradeEur) : current.riskPerTradeEur,
      riskRewardRatio: Number(incoming.riskRewardRatio) > 0 ? Number(incoming.riskRewardRatio) : current.riskRewardRatio,
      watchedSymbols: Array.isArray(incoming.watchedSymbols) && incoming.watchedSymbols.length ? incoming.watchedSymbols : current.watchedSymbols,
      startCapitalEur: Number(incoming.startCapitalEur) > 0 ? Number(incoming.startCapitalEur) : current.startCapitalEur,
      maxOpenPositions: Number(incoming.maxOpenPositions) > 0 ? Number(incoming.maxOpenPositions) : current.maxOpenPositions,
      leverage: Number(incoming.leverage) >= 1 && Number(incoming.leverage) <= 10 ? Math.round(Number(incoming.leverage)) : current.leverage
    };
    await pgPool.query(
      `UPDATE paper_settings SET enabled = $1, risk_per_trade_eur = $2, risk_reward_ratio = $3, watched_symbols = $4, start_capital_eur = $5, max_open_positions = $6, leverage = $7 WHERE id = 1`,
      [next.enabled, next.riskPerTradeEur, next.riskRewardRatio, next.watchedSymbols, next.startCapitalEur, next.maxOpenPositions, next.leverage]
    );

    if (next.enabled && !wasEnabled) runPaperTradingCycle();
    res.json({ ok: true, settings: next });
  } catch (err) {
    console.error('Paper-Trading: settings-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

app.post('/api/paper-trading/reset', async (req, res) => {
  if (!pgPool) return res.status(400).json({ error: 'DATABASE_URL ist serverseitig nicht konfiguriert - Auto Trader nicht verfügbar.' });
  try {
    const settings = await getPaperSettings();
    await pgPool.query('DELETE FROM paper_trades');
    await pgPool.query('DELETE FROM paper_balance_history');
    await pgPool.query('UPDATE paper_settings SET balance_eur = $1, last_check = NULL WHERE id = 1', [settings.startCapitalEur]);
    await pgPool.query('INSERT INTO paper_balance_history (balance) VALUES ($1)', [settings.startCapitalEur]);
    Object.keys(paperLastPrices).forEach(k => delete paperLastPrices[k]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Paper-Trading: reset-Fehler:', err);
    res.status(500).json({ error: err.message || 'Datenbankfehler.' });
  }
});

const PORT = process.env.PORT || 5055;

initPaperTradingSchema()
  .then(() => {
    if (pgPool) console.log('Paper-Trading: Datenbank-Schema bereit.');
  })
  .catch(err => console.error('Paper-Trading: Schema-Initialisierung fehlgeschlagen:', err));

app.listen(PORT, () => {
  console.log(`Jarvis-Server läuft auf http://localhost:${PORT}`);
  console.log(`Gemini konfiguriert: ${!!GEMINI_API_KEY} (Modell: ${GEMINI_MODEL})`);
  console.log(`MEXC konfiguriert: ${!!(MEXC_API_KEY && MEXC_API_SECRET)}`);
  console.log(`Datenbank (Auto Trader) konfiguriert: ${!!DATABASE_URL}`);
});
