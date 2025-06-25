// index.js - WhatsApp Tour Bot – Produkcyjna wersja z Telegramem i zarządzaniem
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');

const db = mysql.createPool({
  host: '92.113.22.6',
  user: 'u918515209_tour',
  password: 'TWOJE_HASLO_TUTAJ',
  database: 'u918515209_tour'
});

let locations = {
  Stavenhagen: { slug: 'stavenhagen', phone: '491737008662' },
  Hof:         { slug: 'hof',         phone: '4915120200738' },
  Radeburg:    { slug: 'radeburg',    phone: '48668056220' }
};

const TELEGRAM_BOT_TOKEN = '7688074026:AAFz9aK-WAUYeFnB-yISbSIFZe1_DlVr1dI';
const TELEGRAM_CHAT_ID = '7531268785'; // np. z @userinfobot
const telegram = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Obsługa komend Telegrama
telegram.onText(/\/status/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🤖 Bot działa i jest połączony z WhatsApp i bazą danych.');
});

telegram.onText(/\/restart/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '♻️ Restartuję bota przez PM2...');
  require('child_process').exec('pm2 restart tourbot');
});

telegram.onText(/\/logi/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '📁 Sprawdź logi komendą: pm2 logs tourbot');
});

telegram.onText(/\/dodaj (.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const [nazwa, slug, phone] = match[1].split(',').map(v => v.trim());
  if (!nazwa || !slug || !phone) {
    return telegram.sendMessage(msg.chat.id, '❌ Użycie: /dodaj Nazwa,slug,numer');
  }
  locations[nazwa] = { slug, phone };
  telegram.sendMessage(msg.chat.id, `✅ Dodano lokalizację: ${nazwa} (${slug}) z numerem ${phone}`);
});

telegram.onText(/\/zmien (.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const [nazwa, newPhone] = match[1].split(',').map(v => v.trim());
  if (!locations[nazwa]) {
    return telegram.sendMessage(msg.chat.id, `❌ Lokalizacja ${nazwa} nie istnieje.`);
  }
  locations[nazwa].phone = newPhone;
  telegram.sendMessage(msg.chat.id, `🔁 Zmieniono numer w lokalizacji ${nazwa} na ${newPhone}`);
});

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('✅ WhatsApp bot gotowy!');

  try {
    await client.sendMessage('48451558332@c.us', '🚀 Bot został uruchomiony i działa poprawnie.');
    console.log('📤 Wysłano wiadomość startową do właściciela.');
  } catch (err) {
    console.error('❌ Błąd przy wysyłaniu wiadomości startowej:', err.message);
  }

  try {
    await telegram.sendMessage(TELEGRAM_CHAT_ID, '🤖 Bot WhatsApp został uruchomiony i działa.');
    console.log('📩 Wysłano status do Telegrama.');
  } catch (err) {
    console.error('❌ Telegram start error:', err.message);
  }

  const today = new Date().toISOString().split('T')[0];
  let summary = '';

  for (const [name, info] of Object.entries(locations)) {
    try {
      const [rows] = await db.query(`
        SELECT t.tour_number FROM tours t
        LEFT JOIN assignments a ON t.tour_number = a.tour_number
          AND t.location_id = a.location_id AND a.assignment_date = ?
        JOIN locations l ON t.location_id = l.id
        WHERE a.id IS NULL AND l.unique_slug = ?
      `, [today, info.slug]);

      if (rows.length > 0) {
        summary += `\n• ${name}: ${rows.length} Touren nicht zugewiesen.`;
      }
    } catch (err) {
      console.error(`❌ Błąd przy sprawdzaniu nieprzypisanych tur w ${name}:`, err.message);
    }
  }

  if (summary.length > 0) {
    const msg = `📍 Automatische Übersicht zum Start des Systems:\n${summary}\n\n📌 Diese Nachricht wurde automatisch generiert.`;
    try {
      await client.sendMessage('48451558332@c.us', msg);
    } catch (err) {
      console.error('❌ Błąd przy wysyłaniu raportu startowego:', err.message);
    }
  } else {
    console.log('✅ Wszystkie tury przypisane – brak potrzeby wysyłania raportu.');
  }
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
      const msgManager = `
[Standort: ${name}]
Achtung: Für den heutigen Tag (${today}) wurden nicht alle Touren den Fahrzeugen zugewiesen.
Bitte dringend auf https://tour.ltslogistik.de/?location=${info.slug} ergänzen.`;

      const msgGroup = `
[Standort: ${name}]
Achtung: Für den heutigen Tag (${today}) wurden nicht alle Touren den Fahrzeugen zugewiesen.
📌 Der Vorarbeiter wurde bereits informiert.`;

      await client.sendMessage(`${info.phone}@c.us`, msgManager).catch(console.error);
      await client.sendMessage('120363419266988965@g.us', msgGroup).catch(console.error);
    }
  }
});

cron.schedule('0 14 * * 1-5', async () => {
  const today = new Date().toISOString().split('T')[0];
  for (const [name, info] of Object.entries(locations)) {
    const [rows] = await db.query(`
      SELECT t.tour_number FROM tours t
      JOIN locations l ON t.location_id = l.id
      WHERE l.unique_slug = ? AND t.date = ? AND t.departure_status IS NULL
    `, [info.slug, today]);

    if (rows.length > 0) {
      const msgGroup = `
[Standort: ${name}]
Bis 14:00 Uhr wurden ${rows.length} Touren noch nicht als abgefahren markiert.
Bitte überprüfen.`;

      await client.sendMessage('120363419266988965@g.us', msgGroup).catch(console.error);
    }
  }
});

client.initialize();
