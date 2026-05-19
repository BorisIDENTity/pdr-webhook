const express = require('express');
const https = require('https');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG = {
  PORT: process.env.PORT || 3000,
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || 'pdr_meta_token_2025',
  WIX_SECRET: process.env.WIX_SECRET || 'pdr_wix_secret_2025',
  SPREADSHEET_ID: '1kmjSOTRzfSncHBBKOmv0CB4ogVVpFIaC0gsd5qp-6qE',
  GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL || 'pdr-sheets@gen-lang-client-0176741221.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY || '',
};

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: CONFIG.GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const key = CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${header}.${payload}.${sig}`;
  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data).access_token); }
        catch { reject(new Error('token parse error')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function appendToSheet(sheetName, row) {
  try {
    const token = await getGoogleToken();
    const body = JSON.stringify({ values: [row] });
    const range = encodeURIComponent(`${sheetName}!A1`);
    const path = `/v4/spreadsheets/${CONFIG.SPREADSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED`;
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'sheets.googleapis.com',
        path,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { console.log(`[SHEETS:${sheetName}] נוסף: ${row[2]}`); resolve(); });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('[SHEETS] שגיאה:', err.message);
  }
}

async function initSheets() {
  try {
    const token = await getGoogleToken();
    const sheets = [
      {
        name: 'Clients',
        headers: ['תאריך', 'מקור', 'שם פרטי', 'שם משפחה', 'טלפון', 'אימייל', 'רכב', 'שנה', 'סוג שירות', 'כתובת', 'הודעה', 'סטטוס']
      },
      {
        name: 'Course',
        headers: ['תאריך', 'שם פרטי', 'שם משפחה', 'טלפון', 'אימייל', 'ניסיון בתעשייה', 'מטרה', 'איך שמע עלינו', 'גיל', 'רוצה ללמוד', 'הודעה', 'סטטוס']
      },
    ];
    for (const sheet of sheets) {
      const body = JSON.stringify({ values: [sheet.headers] });
      const range = encodeURIComponent(`${sheet.name}!A1`);
      const path = `/v4/spreadsheets/${CONFIG.SPREADSHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`;
      await new Promise((resolve) => {
        const req = https.request({
          hostname: 'sheets.googleapis.com',
          path,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { console.log(`[SHEETS] כותרות ${sheet.name} מוכנות`); resolve(); });
        });
        req.on('error', () => resolve());
        req.write(body);
        req.end();
      });
    }
  } catch (e) { console.error('[SHEETS] init error:', e.message); }
}

// META WEBHOOK
app.get('/webhook/meta', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === CONFIG.META_VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post('/webhook/meta', async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(200);
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      const fields = {};
      change.value.field_data?.forEach(f => { fields[f.name] = f.values?.[0] || ''; });
      const fullName = (fields['full_name'] || '').split(' ');
      await appendToSheet('Clients', [
        new Date().toLocaleString('he-IL'),
        'Meta/פייסבוק',
        fullName[0] || '',
        fullName.slice(1).join(' ') || '',
        fields['phone_number'] || '',
        fields['email'] || '',
        fields['car'] || fields['make_model'] || '',
        fields['year'] || '',
        '',
        '',
        fields['message'] || '',
        'חדש',
      ]);
    }
  }
  res.sendStatus(200);
});

// WIX - טופס PDR ראשי
app.post('/webhook/wix', async (req, res) => {
  const secret = req.headers['x-wix-secret'];
  if (CONFIG.WIX_SECRET && secret !== CONFIG.WIX_SECRET) return res.sendStatus(401);
  const b = req.body;
  const firstName = b.firstName || b.first_name || b.name || '';
  const lastName  = b.lastName  || b.last_name  || '';
  await appendToSheet('Clients', [
    new Date().toLocaleString('he-IL'),
    'Wix',
    firstName,
    lastName,
    b.phone || b.phoneNumber || '',
    b.email || '',
    b.car || b.makeModel || b.make_and_model || '',
    b.year || '',
    b.serviceType || b.service_type || b.type_of_service || '',
    b.address || '',
    b.message || '',
    'חדש',
  ]);
  res.status(200).json({ success: true });
});

// WIX - טופס קורס
app.post('/webhook/course', async (req, res) => {
  const secret = req.headers['x-wix-secret'];
  if (CONFIG.WIX_SECRET && secret !== CONFIG.WIX_SECRET) return res.sendStatus(401);
  const b = req.body;
  await appendToSheet('Course', [
    new Date().toLocaleString('he-IL'),
    b.firstName || b.first_name || '',
    b.lastName  || b.last_name  || '',
    b.phone     || b.phoneNumber || '',
    b.email     || '',
    b.experience || b.industry_experience || '',
    b.goal      || b.career_goal || '',
    b.source    || b.how_did_you_hear || '',
    b.age       || '',
    b.learn     || b.want_to_learn || '',
    b.message   || '',
    'חדש',
  ]);
  res.status(200).json({ success: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok', sheets: CONFIG.SPREADSHEET_ID }));

app.listen(CONFIG.PORT, async () => {
  console.log(`\n🚗 PDR Webhook Server on port ${CONFIG.PORT}`);
  await initSheets();
});
