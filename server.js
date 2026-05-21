const express = require('express');
const https = require('https');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG = {
  PORT: process.env.PORT || 3000,
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || 'pdr_meta_token_2025',
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
    exp: now + 3600, iat: now,
  }));
  const key = CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(key, 'base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const jwt = `${header}.${payload}.${sig}`;
  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({ hostname:'oauth2.googleapis.com', path:'/token', method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'} }, res => {
      let data=''; res.on('data',d=>data+=d); res.on('end',()=>{ try{resolve(JSON.parse(data).access_token);}catch{reject(new Error('token error'));} });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}

async function appendToSheet(sheetName, row) {
  try {
    const token = await getGoogleToken();
    const body = JSON.stringify({ values: [row] });
    const range = encodeURIComponent(`${sheetName}!A1`);
    const path = `/v4/spreadsheets/${CONFIG.SPREADSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED`;
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname:'sheets.googleapis.com', path, method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, res => {
        let data=''; res.on('data',d=>data+=d); res.on('end',()=>{ console.log(`[SHEETS:${sheetName}] Added: ${row[2]}`); resolve(); });
      });
      req.on('error',reject); req.write(body); req.end();
    });
  } catch(err) { console.error('[SHEETS] Error:', err.message); }
}

async function initSheets() {
  try {
    const token = await getGoogleToken();
    const sheets = [
      { name:'Clients', headers:['Date','Source','First Name','Last Name','Phone','Email','Car Make & Model','Year','Service Type','Address','Message','Image Left','Image Right','Image Front','Status'] },
      { name:'Course',  headers:['Date','First Name','Last Name','Phone','Email','Industry Experience','Goal','How Did You Hear','Age','Want to Learn','Message','Status'] },
    ];
    for (const sheet of sheets) {
      const body = JSON.stringify({ values:[sheet.headers] });
      const range = encodeURIComponent(`${sheet.name}!A1`);
      const path = `/v4/spreadsheets/${CONFIG.SPREADSHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`;
      await new Promise(resolve => {
        const req = https.request({ hostname:'sheets.googleapis.com', path, method:'PUT', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, res => {
          let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ console.log(`Headers set: ${sheet.name}`); resolve(); });
        });
        req.on('error',()=>resolve()); req.write(body); req.end();
      });
    }
  } catch(e) { console.error('Init error:', e.message); }
}

// פונקציה לחילוץ שדות מ-Wix submissions
function parseWixSubmissions(data) {
  const result = {};
  const submissions = data?.submissions || [];
  submissions.forEach(({ label, value }) => {
    const l = label.toLowerCase();
    if (l.includes('first name'))    result.firstName   = value;
    else if (l.includes('last name')) result.lastName    = value;
    else if (l.includes('phone')) result.phone = "'" + value;
    else if (l.includes('email'))     result.email       = value;
    else if (l.includes('make') || l.includes('model')) result.car = value;
    else if (l.includes('year'))      result.year        = value;
    else if (l.includes('service'))   result.serviceType = value;
    else if (l.includes('address'))   result.address     = value;
    else if (l.includes('message'))   result.message     = value;
    else if (l.includes('left'))      result.imageLeft   = value;
    else if (l.includes('right'))     result.imageRight  = value;
    else if (l.includes('front'))     result.imageFront  = value;
    // Course fields
    else if (l.includes('experience') || l.includes('industry')) result.experience = value;
    else if (l.includes('goal') || l.includes('career'))         result.goal       = value;
    else if (l.includes('hear'))      result.source      = value;
    else if (l.includes('age') || l.includes('old'))             result.age        = value;
    else if (l.includes('learn'))     result.learn       = value;
  });
  return result;
}

// META WEBHOOK
app.get('/webhook/meta', (req, res) => {
  const { 'hub.mode':mode, 'hub.verify_token':token, 'hub.challenge':challenge } = req.query;
  if (mode==='subscribe' && token===CONFIG.META_VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post('/webhook/meta', async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(200);
  for (const entry of body.entry||[]) {
    for (const change of entry.changes||[]) {
      if (change.field !== 'leadgen') continue;
      const fields = {};
      change.value.field_data?.forEach(f => { fields[f.name] = f.values?.[0]||''; });
      const fullName = (fields['full_name']||'').split(' ');
      await appendToSheet('Clients', [
       new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' }), 'Meta/Facebook',
        fullName[0]||'', fullName.slice(1).join(' ')||'',
        fields['phone_number']||'', fields['email']||'',
        fields['car']||'', fields['year']||'',
        '','', fields['message']||'','','','','New',
      ]);
    }
  }
  res.sendStatus(200);
});

// WIX - PDR form
app.post('/webhook/wix', async (req, res) => {
  console.log('[WIX] Received:', JSON.stringify(req.body));
  const source = req.query.source || 'Wix';
  const data = req.body?.data || req.body;
  const f = parseWixSubmissions(data);
  await appendToSheet('Clients', [
   new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' }), source,
    f.firstName||'', f.lastName||'',
    f.phone||'', f.email||'',
    f.car||'', f.year||'',
    f.serviceType||'', f.address||'',
    f.message||'',
    f.imageLeft||'', f.imageRight||'', f.imageFront||'',
    'New',
  ]);
  res.status(200).json({ success: true });
});

// WIX - Course form
app.post('/webhook/course', async (req, res) => {
  console.log('[COURSE] Received:', JSON.stringify(req.body));
  const data = req.body?.data || req.body;
  const f = parseWixSubmissions(data);
  await appendToSheet('Course', [
   new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' }),
    f.firstName||'', f.lastName||'',
    f.phone||'', f.email||'',
    f.experience||'', f.goal||'', f.source||'',
    f.age||'', f.learn||'', f.message||'',
    'New',
  ]);
  res.status(200).json({ success: true });
});

app.get('/health', (req, res) => res.json({ status:'ok', sheets:CONFIG.SPREADSHEET_ID }));

app.listen(CONFIG.PORT, async () => {
  console.log(`PDR Webhook Server on port ${CONFIG.PORT}`);
  await initSheets();
});
