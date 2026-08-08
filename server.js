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

// Schlanker, direkter Gemini-Aufruf für Server-interne Zwecke (Auto-Trader-
// Gegencheck und Selbstauswertung). Gibt bei fehlendem Key null zurück,
// statt zu werfen - Aufrufer müssen den Fallback selbst handhaben.
async function callGeminiText(prompt) {
  if (!GEMINI_API_KEY) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
    });
    if (!upstream.ok) {
      console.error('Auto Trader: Gemini-Aufruf fehlgeschlagen, HTTP', upstream.status);
      return null;
    }
    const data = await upstream.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    return text || null;
  } catch (err) {
    console.error('Auto Trader: Gemini-Aufruf-Fehler:', err.message || err);
    return null;
  }
}

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
  leverage: 5,
  criteriaTrendEnabled: true,
  criteriaVolumeEnabled: false,
  criteriaMtfEnabled: false
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
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_skipped_setups (
      id UUID PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      reason TEXT,
      criteria_trend BOOLEAN NOT NULL DEFAULT false,
      criteria_volume BOOLEAN NOT NULL DEFAULT false,
      criteria_mtf BOOLEAN NOT NULL DEFAULT false,
      gemini_reasoning TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_insights (
      id INTEGER PRIMARY KEY DEFAULT 1,
      trade_count INTEGER NOT NULL DEFAULT 0,
      insight_text TEXT,
      generated_at TIMESTAMPTZ
    );
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS paper_check_log (
      symbol TEXT PRIMARY KEY,
      sweep_bos_found BOOLEAN NOT NULL DEFAULT false,
      direction TEXT,
      failed_criteria TEXT,
      note TEXT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Migration für Spalten, die nachträglich (nach dem ersten Deploy) hinzukamen -
  // "CREATE TABLE IF NOT EXISTS" ergänzt bei bereits existierenden Tabellen
  // KEINE neuen Spalten, daher hier explizit per ALTER nachziehen. Idempotent,
  // läuft bei jedem Start.
  await pgPool.query('ALTER TABLE paper_settings ADD COLUMN IF NOT EXISTS max_open_positions INTEGER NOT NULL DEFAULT 3');
  await pgPool.query('ALTER TABLE paper_settings ADD COLUMN IF NOT EXISTS leverage INTEGER NOT NULL DEFAULT 5');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS leverage INTEGER NOT NULL DEFAULT 1');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS margin_eur NUMERIC NOT NULL DEFAULT 0');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS liquidation_price NUMERIC');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS liquidates_first BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS criteria_trend BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS criteria_volume BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS criteria_mtf BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS gemini_reasoning TEXT');
  await pgPool.query('ALTER TABLE paper_settings ADD COLUMN IF NOT EXISTS criteria_trend_enabled BOOLEAN NOT NULL DEFAULT true');
  await pgPool.query('ALTER TABLE paper_settings ADD COLUMN IF NOT EXISTS criteria_volume_enabled BOOLEAN NOT NULL DEFAULT false');
  await pgPool.query('ALTER TABLE paper_settings ADD COLUMN IF NOT EXISTS criteria_mtf_enabled BOOLEAN NOT NULL DEFAULT false');

  const { rows } = await pgPool.query('SELECT id FROM paper_settings WHERE id = 1');
  if (!rows.length) {
    await pgPool.query(
      `INSERT INTO paper_settings (id, enabled, risk_per_trade_eur, risk_reward_ratio, watched_symbols, start_capital_eur, balance_eur, leverage, criteria_trend_enabled, criteria_volume_enabled, criteria_mtf_enabled)
       VALUES (1, false, $1, $2, $3, $4, $4, $5, $6, $7, $8)`,
      [PAPER_DEFAULT_SETTINGS.riskPerTradeEur, PAPER_DEFAULT_SETTINGS.riskRewardRatio, PAPER_DEFAULT_SETTINGS.watchedSymbols, PAPER_DEFAULT_SETTINGS.startCapitalEur, PAPER_DEFAULT_SETTINGS.leverage, PAPER_DEFAULT_SETTINGS.criteriaTrendEnabled, PAPER_DEFAULT_SETTINGS.criteriaVolumeEnabled, PAPER_DEFAULT_SETTINGS.criteriaMtfEnabled]
    );
    await pgPool.query('INSERT INTO paper_balance_history (balance) VALUES ($1)', [PAPER_DEFAULT_SETTINGS.startCapitalEur]);
  }
  const { rows: insightRows } = await pgPool.query('SELECT id FROM paper_insights WHERE id = 1');
  if (!insightRows.length) {
    await pgPool.query('INSERT INTO paper_insights (id, trade_count, insight_text, generated_at) VALUES (1, 0, NULL, NULL)');
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
    criteriaTrendEnabled: row.criteria_trend_enabled,
    criteriaVolumeEnabled: row.criteria_volume_enabled,
    criteriaMtfEnabled: row.criteria_mtf_enabled,
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
    criteriaTrend: row.criteria_trend,
    criteriaVolume: row.criteria_volume,
    criteriaMtf: row.criteria_mtf,
    geminiReasoning: row.gemini_reasoning,
    reason: row.reason,
    openedAt: new Date(row.opened_at).getTime(),
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    closeReason: row.close_reason,
    pnlEur: row.pnl_eur != null ? Number(row.pnl_eur) : null,
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null
  };
}

function rowToSkipped(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    reason: row.reason,
    criteriaTrend: row.criteria_trend,
    criteriaVolume: row.criteria_volume,
    criteriaMtf: row.criteria_mtf,
    geminiReasoning: row.gemini_reasoning,
    createdAt: new Date(row.created_at).getTime()
  };
}

async function fetchPaperCandles(symbol, interval = '15m', limit = 200) {
  const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`Kline-Fehler für ${symbol}: HTTP ${res.status}`);
  const raw = await res.json();
  return raw.map(k => ({
    time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
    volume: Number(k[5])
  }));
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
// innerhalb eines Fensters von ~15 Kerzen, nahe (<=3%, gelockert von 2%) der Sweep-Zone.
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
      if (distancePct <= 3) {
        return {
          direction: 'long',
          sweepExtreme: sweep.sweepExtreme,
          sweepIndex: sweep.index,
          bosIndex: bos.index,
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
      if (distancePct <= 3) {
        return {
          direction: 'short',
          sweepExtreme: sweep.sweepExtreme,
          sweepIndex: sweep.index,
          bosIndex: bos.index,
          reason: `Liquidation Sweep über ${sweep.sweptLevel.toFixed(4)}, danach Break of Structure unter ${bos.brokenLevel.toFixed(4)} (${distancePct.toFixed(2)}% Abstand zur Zone).`
        };
      }
    }
  }

  return null;
}

// ---- Zusatz-Bestätigungskriterien (a: Trend, b: Volumen, c: Mehrere Zeitebenen) ----

// a) Trendfilter: SMA200 auf 1h-Kerzen, Fallback SMA50 falls nicht genug
// Historie vorhanden ist (Binance liefert je nach Symbol ggf. <200 1h-Kerzen
// bei sehr neuen Listings - für dieses simulierte Setting unkritisch).
function checkTrendFilter(candles1h, direction) {
  const closes = candles1h.map(c => c.close);
  const period = closes.length >= 200 ? 200 : Math.min(50, closes.length);
  if (period < 10) return { pass: false, period, sma: null }; // zu wenig Historie, sicherheitshalber ablehnen
  const sma = closes.slice(-period).reduce((a, b) => a + b, 0) / period;
  const currentPrice = closes[closes.length - 1];
  const pass = direction === 'long' ? currentPrice > sma : currentPrice < sma;
  return { pass, period, sma };
}

// b) Volumen-Bestätigung: Volumen der BOS-Kerze (Bestätigungskerze) muss
// mindestens das 1,2-fache des Durchschnittsvolumens der letzten 20 Kerzen
// davor betragen (gelockert von ursprünglich 1,5x).
function checkVolumeConfirmation(candles, confirmIndex) {
  const start = Math.max(0, confirmIndex - 20);
  const priorVolumes = candles.slice(start, confirmIndex).map(c => c.volume);
  if (!priorVolumes.length) return { pass: false, avgVolume: 0, confirmVolume: 0 };
  const avgVolume = priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length;
  const confirmVolume = candles[confirmIndex].volume;
  return { pass: avgVolume > 0 && confirmVolume >= avgVolume * 1.2, avgVolume, confirmVolume };
}

// c) Mehrere Zeitebenen: auf dem übergeordneten 1h-Chart darf keine
// unmittelbar gegenläufige starke Struktur (lokales Hoch/Tief) in der Nähe
// (<=1%) des aktuellen Kurses liegen - sonst würde der Trade direkt in
// eine große 1h-Resistance/Support hineinlaufen.
function checkMultiTimeframe(candles1h, direction, currentPrice) {
  const { highs, lows } = findLocalExtrema(candles1h, 3);
  if (direction === 'long') {
    const nearResistance = highs.find(h => h.price > currentPrice && (h.price - currentPrice) / currentPrice <= 0.01);
    return { pass: !nearResistance, blockingLevel: nearResistance ? nearResistance.price : null };
  } else {
    const nearSupport = lows.find(l => l.price < currentPrice && (currentPrice - l.price) / currentPrice <= 0.01);
    return { pass: !nearSupport, blockingLevel: nearSupport ? nearSupport.price : null };
  }
}

// ---- Leichte technische Indikatoren für den Gemini-Kontext (Server-Variante,
// da die vorhandenen SMA/RSI/MACD-Funktionen im Frontend liegen und dort
// nicht ohne Weiteres server-seitig wiederverwendbar sind - hier bewusst
// kompakt neu implementiert statt dupliziert einzubinden). ----
function calcServerRsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcServerMacd(closes) {
  if (closes.length < 35) return null;
  const ema = (values, period) => {
    const k = 2 / (period + 1);
    let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const out = [prev];
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const offset = ema12.length - ema26.length;
  const macdLine = ema26.map((v, i) => ema12[i + offset] - v);
  const signalLine = ema(macdLine, 9);
  const macd = macdLine[macdLine.length - 1];
  const signal = signalLine[signalLine.length - 1];
  return { macd, signal, histogram: macd - signal };
}

// NUR SIMULATION - fragt Gemini als Gegencheck vor Eröffnung eines Paper-
// Trades. Löst zu keinem Zeitpunkt eine echte Order aus, ruft ausschließlich
// die eigene Gemini-Textgenerierung auf. Bei fehlendem GEMINI_API_KEY wird
// der Trade automatisch freigegeben (kein Gegencheck technisch möglich) -
// das wird in der Begründung transparent vermerkt.
async function askGeminiTradeCheck({ symbol, direction, setup, criteria, candles5m, rsi, macd }) {
  const currentPrice = candles5m[candles5m.length - 1].close;
  const recentPrices = candles5m.slice(-12).map(c => c.close.toFixed(4)).join(', ');
  const prompt = `Du bist ein erfahrener, nüchterner Krypto-Trader. Bewerte folgendes automatisch erkanntes Paper-Trading-Setup (reine Simulation, kein echtes Geld):

Coin: ${symbol}
Richtung: ${direction === 'long' ? 'LONG' : 'SHORT'}
Erkanntes Muster: ${setup.reason}
Aktueller Kurs: ${currentPrice}
Letzte Kurse (5-Min, älteste zuerst): ${recentPrices}
RSI(14, 5m): ${rsi != null ? rsi.toFixed(1) : 'nicht verfügbar'}
MACD-Histogramm(5m): ${macd ? macd.histogram.toFixed(6) : 'nicht verfügbar'}
Zusatzkriterien bereits erfüllt: Trend ${criteria.trend.pass ? 'JA' : 'NEIN'}, Volumen ${criteria.volume.pass ? 'JA' : 'NEIN'}, Mehrere-Zeitebenen ${criteria.mtf.pass ? 'JA' : 'NEIN'}

Gib eine kurze Einschätzung in 2-3 Sätzen ab, ob dieses Setup in diesem Kontext wirklich sinnvoll erscheint oder ob es Gegenargumente gibt. Schreibe zum Schluss als letztes Wort/letzte Zeile klar maschinenlesbar: "ENTSCHEIDUNG: JA" wenn der Trade eröffnet werden soll, oder "ENTSCHEIDUNG: NEIN" wenn nicht.`;

  const text = await callGeminiText(prompt);
  if (!text) {
    return { approved: true, reasoning: 'Gemini nicht konfiguriert oder nicht erreichbar - Trade automatisch freigegeben (kein Gegencheck möglich).' };
  }
  const match = text.toUpperCase().match(/ENTSCHEIDUNG:\s*(JA|NEIN)/);
  const approved = match ? match[1] === 'JA' : true; // unklare Antwort -> konservativ freigeben, aber vermerken
  const reasoning = match ? text.trim() : `${text.trim()} [Hinweis: keine eindeutige ENTSCHEIDUNG erkannt, Trade sicherheitshalber freigegeben]`;
  return { approved, reasoning };
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
  // Haupt-Zeitrahmen jetzt 5-Minuten-Kerzen (Punkt 1c der Erweiterung, vorher 15m).
  const candles = await fetchPaperCandles(symbol, '5m', 200);
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

    // Punkt 3: nach jeweils 20 geschlossenen Trades eine Gemini-Selbstauswertung
    // anstoßen (rein informativ, verändert die Regeln aus Punkt 1 nicht automatisch).
    const { rows: closedCountRows } = await pgPool.query("SELECT COUNT(*)::int AS c FROM paper_trades WHERE status = 'closed'");
    const closedCount = closedCountRows[0].c;
    if (closedCount > 0 && closedCount % 20 === 0) {
      generatePaperInsights(closedCount).catch(err => console.error('Auto Trader: Insight-Generierung fehlgeschlagen:', err.message || err));
    }
  }

  const { rows: stillOpenForSymbol } = await pgPool.query(
    "SELECT COUNT(*)::int AS c FROM paper_trades WHERE symbol = $1 AND status = 'open'",
    [symbol]
  );
  if (stillOpenForSymbol[0].c > 0) return;

  const { rows: totalOpenRows } = await pgPool.query("SELECT COUNT(*)::int AS c FROM paper_trades WHERE status = 'open'");
  if (totalOpenRows[0].c >= settings.maxOpenPositions) return;

  const setup = detectPaperSetup(candles);

  // Punkt 3 (Transparenz): pro Coin und Durchlauf einen Diagnose-Eintrag
  // schreiben, der zeigt, ob überhaupt ein Sweep+BOS gefunden wurde und
  // woran es ggf. gescheitert ist ("Letzte Prüfungen" auf der Auto-Trader-
  // Seite). Ein Eintrag pro Symbol (Upsert), nicht pro Historie.
  async function logCheck({ sweepBosFound, direction, failedCriteria, note }) {
    await pgPool.query(
      `INSERT INTO paper_check_log (symbol, sweep_bos_found, direction, failed_criteria, note, checked_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (symbol) DO UPDATE SET sweep_bos_found = $2, direction = $3, failed_criteria = $4, note = $5, checked_at = now()`,
      [symbol, sweepBosFound, direction || null, failedCriteria || null, note || null]
    );
  }

  if (!setup) {
    await logCheck({ sweepBosFound: false, direction: null, failedCriteria: null, note: 'Kein Sweep+BOS in diesem Zeitraum.' });
    return;
  }

  // Punkt 1: Zusatzkriterien sind pro Kriterium einzeln über die Einstellungen
  // an-/abschaltbar. Ein deaktiviertes Kriterium blockiert nie (gilt als
  // automatisch erfüllt), nur aktivierte Kriterien müssen tatsächlich passen.
  const candles1h = await fetchPaperCandles(symbol, '1h', 200);
  const trend = checkTrendFilter(candles1h, setup.direction);
  const volume = checkVolumeConfirmation(candles, setup.bosIndex);
  const mtf = checkMultiTimeframe(candles1h, setup.direction, lastPrice);
  const criteria = { trend, volume, mtf };

  const failed = [];
  if (settings.criteriaTrendEnabled && !trend.pass) failed.push('Trendfilter');
  if (settings.criteriaVolumeEnabled && !volume.pass) failed.push('Volumen-Bestätigung');
  if (settings.criteriaMtfEnabled && !mtf.pass) failed.push('Mehrzeitebenen-Check');

  if (failed.length) {
    await logCheck({ sweepBosFound: true, direction: setup.direction, failedCriteria: failed.join(', '), note: `Sweep+BOS gefunden, aber ${failed.join(', ')} nicht erfüllt.` });
    return;
  }

  await logCheck({ sweepBosFound: true, direction: setup.direction, failedCriteria: null, note: 'Sweep+BOS gefunden, alle aktivierten Zusatzkriterien erfüllt - an Gemini zur Prüfung geschickt.' });

  // Punkt 2: Gemini als Gegencheck, bevor der Trade wirklich eröffnet wird.
  const closes5m = candles.map(c => c.close);
  const rsi = calcServerRsi(closes5m, 14);
  const macd = calcServerMacd(closes5m);
  const geminiResult = await askGeminiTradeCheck({ symbol, direction: setup.direction, setup, criteria, candles5m: candles, rsi, macd });

  const entryPrice = lastPrice;

  if (!geminiResult.approved) {
    await pgPool.query(
      `INSERT INTO paper_skipped_setups (id, symbol, direction, reason, criteria_trend, criteria_volume, criteria_mtf, gemini_reasoning)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), symbol, setup.direction, setup.reason, trend.pass, volume.pass, mtf.pass, geminiResult.reasoning]
    );
    return;
  }

  const plan = computePaperTradePlan(setup.direction, entryPrice, setup.sweepExtreme, settings);
  const fullReason = `${setup.reason} Gemini-Gegencheck: ${geminiResult.reasoning}`;
  await pgPool.query(
    `INSERT INTO paper_trades (id, symbol, direction, entry_price, stop_loss, take_profit, position_size_eur, risk_eur, leverage, margin_eur, liquidation_price, liquidates_first, criteria_trend, criteria_volume, criteria_mtf, gemini_reasoning, reason, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'open', now())`,
    [crypto.randomUUID(), symbol, setup.direction, entryPrice, plan.stopLoss, plan.takeProfit, plan.positionSizeEur, settings.riskPerTradeEur, plan.leverage, plan.marginEur, plan.liquidationPrice, plan.liquidatesFirst, trend.pass, volume.pass, mtf.pass, geminiResult.reasoning, fullReason]
  );
}

// Punkt 3: NUR informative Selbstauswertung - verändert nie automatisch die
// Regeln aus Punkt 1, sondern liefert dem Nutzer Text zur manuellen Auswertung.
async function generatePaperInsights(closedCount) {
  const { rows } = await pgPool.query(
    "SELECT symbol, direction, pnl_eur, criteria_trend, criteria_volume, criteria_mtf, closed_at FROM paper_trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 100"
  );
  const summaryLines = rows.map(r => {
    const hour = new Date(r.closed_at).getUTCHours();
    const result = Number(r.pnl_eur) >= 0 ? 'GEWINN' : 'VERLUST';
    return `${r.symbol} ${r.direction} | Trend:${r.criteria_trend ? 'J' : 'N'} Volumen:${r.criteria_volume ? 'J' : 'N'} MTF:${r.criteria_mtf ? 'J' : 'N'} | Stunde:${hour} | ${result}`;
  }).join('\n');

  const prompt = `Du analysierst die Historie eines simulierten Krypto-Paper-Trading-Bots (kein echtes Geld). Hier die letzten ${rows.length} geschlossenen Trades (Coin, Richtung, ob die Zusatzkriterien Trend/Volumen/Mehrere-Zeitebenen erfüllt waren, Schlussstunde UTC, Ergebnis):

${summaryLines}

Erkenne Muster, z.B. ob bestimmte Kriterien-Kombinationen, Coins oder Tageszeiten auffällig besser oder schlechter abschneiden. Fasse deine Erkenntnisse in 3-5 kurzen, konkreten Sätzen zusammen (auf Deutsch). Keine Handlungsempfehlung, nur Beobachtungen.`;

  const text = await callGeminiText(prompt);
  const insightText = text || 'Gemini nicht konfiguriert oder nicht erreichbar - keine automatische Auswertung möglich.';
  await pgPool.query(
    'UPDATE paper_insights SET trade_count = $1, insight_text = $2, generated_at = now() WHERE id = 1',
    [closedCount, insightText]
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
    const { rows: skippedRows } = await pgPool.query('SELECT * FROM paper_skipped_setups ORDER BY created_at DESC LIMIT 50');
    const { rows: insightRows } = await pgPool.query('SELECT trade_count, insight_text, generated_at FROM paper_insights WHERE id = 1');
    const { rows: checkLogRows } = await pgPool.query('SELECT * FROM paper_check_log ORDER BY checked_at DESC');

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
    const skippedSetups = skippedRows.map(rowToSkipped);
    const insights = insightRows.length ? {
      tradeCount: insightRows[0].trade_count,
      text: insightRows[0].insight_text,
      generatedAt: insightRows[0].generated_at ? new Date(insightRows[0].generated_at).getTime() : null
    } : null;
    const checkLog = checkLogRows.map(r => ({
      symbol: r.symbol,
      sweepBosFound: r.sweep_bos_found,
      direction: r.direction,
      failedCriteria: r.failed_criteria,
      note: r.note,
      checkedAt: new Date(r.checked_at).getTime()
    }));

    res.json({ settings, balanceEur: settings.balanceEur, balanceHistory, openTrades, closedTrades, skippedSetups, insights, checkLog, lastCheck: settings.lastCheck });
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
      leverage: Number(incoming.leverage) >= 1 && Number(incoming.leverage) <= 10 ? Math.round(Number(incoming.leverage)) : current.leverage,
      criteriaTrendEnabled: incoming.criteriaTrendEnabled !== undefined ? !!incoming.criteriaTrendEnabled : current.criteriaTrendEnabled,
      criteriaVolumeEnabled: incoming.criteriaVolumeEnabled !== undefined ? !!incoming.criteriaVolumeEnabled : current.criteriaVolumeEnabled,
      criteriaMtfEnabled: incoming.criteriaMtfEnabled !== undefined ? !!incoming.criteriaMtfEnabled : current.criteriaMtfEnabled
    };
    await pgPool.query(
      `UPDATE paper_settings SET enabled = $1, risk_per_trade_eur = $2, risk_reward_ratio = $3, watched_symbols = $4, start_capital_eur = $5, max_open_positions = $6, leverage = $7, criteria_trend_enabled = $8, criteria_volume_enabled = $9, criteria_mtf_enabled = $10 WHERE id = 1`,
      [next.enabled, next.riskPerTradeEur, next.riskRewardRatio, next.watchedSymbols, next.startCapitalEur, next.maxOpenPositions, next.leverage, next.criteriaTrendEnabled, next.criteriaVolumeEnabled, next.criteriaMtfEnabled]
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
    await pgPool.query('DELETE FROM paper_skipped_setups');
    await pgPool.query('DELETE FROM paper_check_log');
    await pgPool.query('UPDATE paper_settings SET balance_eur = $1, last_check = NULL WHERE id = 1', [settings.startCapitalEur]);
    await pgPool.query('UPDATE paper_insights SET trade_count = 0, insight_text = NULL, generated_at = NULL WHERE id = 1');
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
