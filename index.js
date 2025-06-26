// index.js - WhatsApp Tour Bot – Produkcyjna wersja z Telegramem i zarządzaniem
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const db = mysql.createPool({
  host: '92.113.22.6',
  user: 'u918515209_tour',
  password: 'Marek2211.!',
  database: 'u918515209_tour'
});

let locations = {
  Stavenhagen: { slug: 'stavenhagen', phone: '491737008662' },
  Hof:         { slug: 'hof',         phone: '4915120200738' },
  Radeburg:    { slug: 'radeburg',    phone: '48668056220' }
};

function saveLocationsToFile() {
  const content = `let locations = ${JSON.stringify(locations, null, 2)};\nmodule.exports = locations;`;
  fs.writeFileSync('./locations.js', content, 'utf8');
}

const TELEGRAM_BOT_TOKEN = '7688074026:AAFz9aK-WAUYeFnB-yISbSIFZe1_DlVr1dI';
const TELEGRAM_CHAT_ID = '7531268785';
const telegram = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

telegram.onText(/\/status/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🤖 Der Bot ist aktiv und mit WhatsApp und der Datenbank verbunden.');
});

telegram.onText(/\/czas/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  telegram.sendMessage(msg.chat.id, `🕒 Serverzeit (Europe/Berlin): ${time}`);
});

telegram.onText(/\/restart/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '♻️ Der Bot wird über PM2 neu gestartet...');
  require('child_process').exec('pm2 restart tourbot');
});

telegram.onText(/\/logi/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '📁 Logs: /root/.pm2/logs/tourbot-out.log');
});

telegram.onText(/\/dodaj (.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const [nazwa, slug, phone] = match[1].split(',').map(v => v.trim());
  if (!nazwa || !slug || !phone) {
    return telegram.sendMessage(msg.chat.id, '❌ Nutzung: /dodaj Name,slug,Nummer');
  }
  locations[nazwa] = { slug, phone };
  saveLocationsToFile();
  telegram.sendMessage(msg.chat.id, `✅ Standort hinzugefügt: ${nazwa} (${slug}) mit Nummer ${phone}`);
});

telegram.onText(/\/zmien (.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const [nazwa, newPhone] = match[1].split(',').map(v => v.trim());
  if (!locations[nazwa]) {
    return telegram.sendMessage(msg.chat.id, `❌ Standort ${nazwa} existiert nicht.`);
  }
  locations[nazwa].phone = newPhone;
  saveLocationsToFile();
  telegram.sendMessage(msg.chat.id, `🔁 Nummer für Standort ${nazwa} geändert zu ${newPhone}`);
});

telegram.onText(/\/usun (.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const nazwa = match[1].trim();
  if (!locations[nazwa]) {
    return telegram.sendMessage(msg.chat.id, `❌ Standort ${nazwa} existiert nicht.`);
  }
  delete locations[nazwa];
  saveLocationsToFile();
  telegram.sendMessage(msg.chat.id, `🗑️ Standort ${nazwa} wurde gelöscht.`);
});

telegram.onText(/\/lista/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  let out = '📍 Aktuelle Standorte:\n';
  for (const [nazwa, info] of Object.entries(locations)) {
    out += `• ${nazwa} (Slug: ${info.slug}, Nummer: ${info.phone})\n`;
  }
  telegram.sendMessage(msg.chat.id, out);
});

telegram.onText(/\/test_kierownik (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const nazwa = match[1].trim();
  const info = locations[nazwa];
  if (!info) return telegram.sendMessage(msg.chat.id, `❌ Standort ${nazwa} existiert nicht.`);

  const today = new Date().toISOString().split('T')[0];
  const [rows] = await db.query(`
    SELECT t.tour_number FROM tours t
    LEFT JOIN assignments a ON t.tour_number = a.tour_number
      AND t.location_id = a.location_id AND a.assignment_date = ?
    JOIN locations l ON t.location_id = l.id
    WHERE a.id IS NULL AND l.unique_slug = ?
  `, [today, info.slug]);

  const msg = `
[Standort: ${nazwa}]
Hinweis: Für heute, den ${today}, gibt es Touren, die nicht gestartet sind (${rows.length}).
Bitte trage die Daten dringend auf der folgenden Seite ein – https://tour.ltslogistik.de/?location=${info.slug}.

Automatische Nachricht. Falls alles korrekt ist und der Grund für die nicht gestarteten Touren bereits der Geschäftsleitung mitgeteilt wurde, bitte diese Nachricht ignorieren.`;

  await client.sendMessage(`${info.phone}@c.us`, msg).catch(console.error);
  telegram.sendMessage(msg.chat.id, `📤 Nachricht an ${nazwa} wurde gesendet.`);
});

telegram.onText(/\/test_grupa/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const today = new Date().toISOString().split('T')[0];
  let text = `📋 Statusübersicht für ${today}:\n`;
  for (const [name, info] of Object.entries(locations)) {
    const [notDeparted] = await db.query(`
      SELECT COUNT(*) AS count FROM tours t
      JOIN locations l ON t.location_id = l.id
      WHERE l.unique_slug = ? AND t.date = ? AND t.departure_status IS NULL
    `, [info.slug, today]);

    const [departed] = await db.query(`
      SELECT COUNT(*) AS count FROM tours t
      JOIN locations l ON t.location_id = l.id
      WHERE l.unique_slug = ? AND t.date = ? AND t.departure_status IS NOT NULL
    `, [info.slug, today]);

    text += `\n[Standort: ${name}]\nGestartet: ${departed[0].count}, Nicht gestartet: ${notDeparted[0].count}`;
  }
  text += '\n\nAutomatische Nachricht. Der Vorarbeiter wurde über das Fehlen der Tour-Zuordnung informiert.';

  await client.sendMessage('120363419266988965@g.us', text).catch(console.error);
  telegram.sendMessage(msg.chat.id, '📤 Gruppenmeldung wurde gesendet.');
});

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('✅ WhatsApp-Bot ist bereit!');
  await client.sendMessage('48451558332@c.us', '🚀 Der Bot wurde erfolgreich gestartet.');
  await telegram.sendMessage(TELEGRAM_CHAT_ID, '🤖 WhatsApp-Bot wurde gestartet und ist aktiv.');
});

cron.schedule('30 7 * * 1-5', async () => {
  const today = new Date().toISOString().split('T')[0];
  for (const [name, info] of Object.entries(locations)) {
    const [rows] = await db.query(`
      SELECT t.tour_number FROM tours t
      LEFT JOIN assignments a ON t.tour_number = a.tour_number
        AND t.location_id = a.location_id AND a.assignment_date = ?
      JOIN locations l ON t.location_id = l.id
      WHERE a.id IS NULL AND l.unique_slug = ?
    `, [today, info.slug]);

    if (rows.length > 0) {
      const msg = `
[Standort: ${name}]
Hinweis: Für heute, den ${today}, gibt es Touren, die nicht gestartet sind (${rows.length}).
Bitte trage die Daten dringend auf der folgenden Seite ein – https://tour.ltslogistik.de/?location=${info.slug}.

Automatische Nachricht. Falls alles korrekt ist und der Grund für die nicht gestarteten Touren bereits der Geschäftsleitung mitgeteilt wurde, bitte diese Nachricht ignorieren.`;
      await client.sendMessage(`${info.phone}@c.us`, msg).catch(console.error);
    }
  }
}, { timezone: 'Europe/Berlin' });

cron.schedule('30 10 * * 1-5', async () => {
  const today = new Date().toISOString().split('T')[0];
  for (const [name, info] of Object.entries(locations)) {
    const [notDeparted] = await db.query(`
      SELECT COUNT(*) AS count FROM tours t
      JOIN locations l ON t.location_id = l.id
      WHERE l.unique_slug = ? AND t.date = ? AND t.departure_status IS NULL
    `, [info.slug, today]);

    const [departed] = await db.query(`
      SELECT COUNT(*) AS count FROM tours t
      JOIN locations l ON t.location_id = l.id
      WHERE l.unique_slug = ? AND t.date = ? AND t.departure_status IS NOT NULL
    `, [info.slug, today]);

    const msg = `
Hinweis: Für heute, den ${today}, gibt es für den Standort ${name} Touren, die nicht gestartet sind.

Anzahl der gestarteten Touren: ${departed[0].count}
Anzahl der nicht gestarteten Touren: ${notDeparted[0].count}

Automatische Nachricht. Der Vorarbeiter wurde über das Fehlen der Tour-Zuordnung informiert.`;
    await client.sendMessage('120363419266988965@g.us', msg).catch(console.error);
  }
}, { timezone: 'Europe/Berlin' });

client.initialize();
