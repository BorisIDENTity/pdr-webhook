const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG = {
  PORT: process.env.PORT || 3000,
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || 'pdr_meta_token_2025',
  META_APP_SECRET:   process.env.META_APP_SECRET   || '',
  WIX_SECRET:        process.env.WIX_SECRET        || 'pdr_wix_secret_2025',
  DATA_FILE: path.join(__dirname, 'leads.json'),
  NOTIFY_WEBHOOK: process.env.NOTIFY_WEBHOOK || '',
};

function loadLeads() {
  if (!fs.existsSync(CONFIG.DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8')); }
  catch { return []; }
}

function saveLeads(leads) {
  fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(leads, null, 2), 'utf8');
}

function addLead(lead) {
  const leads = loadLeads();
  const newLead = { id: Date.now(), createdAt: new Date().toISOString(), status: 'new', ...lead };
  leads.unshift(newLead);
  saveLeads(leads);
  console.log(`[NEW LEAD] ${lead.source} | ${lead.name} | ${lead.phone}`);
  return newLead;
}

app.get('/webhook/meta', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === CONFIG.META_VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post('/webhook/meta', (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(200);
  body.entry?.forEach(entry => {
    entry.changes?.forEach(change => {
      if (change.field !== 'leadgen') return;
      const fields = {};
      change.value.field_data?.forEach(f => { fields[f.name] = f.values?.[0] || ''; });
      addLead({
        source: 'meta',
        name:   fields['full_name'] || '',
        phone:  fields['phone_number'] || '',
        email:  fields['email'] || '',
        car:    fields['car'] || '',
        damage: fields['damage'] || '',
      });
    });
  });
  res.sendStatus(200);
});

app.post('/webhook/wix', (req, res) => {
  const secret = req.headers['x-wix-secret'];
  if (CONFIG.WIX_SECRET && secret !== CONFIG.WIX_SECRET) return res.sendStatus(401);
  const b = req.body;
  addLead({
    source: 'wix',
    name:   b.name || b.fullName || '',
    phone:  b.phone || b.phoneNumber || '',
    email:  b.email || '',
    car:    b.car || '',
    damage: b.damage || b.message || '',
  });
  res.status(200).json({ success: true });
});

app.get('/api/leads', (req, res) => {
  const leads = loadLeads();
  res.json({ total: leads.length, leads });
});

app.get('/health', (req, res) => {
  const leads = loadLeads();
  res.json({ status: 'ok', total: leads.length });
});

app.listen(CONFIG.PORT, () => {
  console.log('PDR Webhook Server running on port ' + CONFIG.PORT);
});
