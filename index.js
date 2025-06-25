// index.js - WhatsApp Tour Bot
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const cron = require('node-cron');

// Konfiguracja połączenia z bazą danych
const db = mysql.createPool({
  host: '92.113.22.6',
  user: 'u918515209_tour',
  password: 'Marek2211.!', // wpisz hasło lokalnie
  database: 'u918515209_tour'
});

// Lista lokalizacji i numery kierowników
const locations = {
  Stavenhagen: {
    slug: 'stavenhagen',
    phone: '+48451558332'
  },
  Hof: {
    slug: 'hof',
    phone: '+48451558332'
  },
  Radeburg: {
    slug: 'radeburg',
    phone: '+48451558332'
  },
  Erfurt: {
    slug: 'erfurt',
    phone: '+49451558332'
  },
  Magdeburg: {
    slug: 'magdeburg',
    phone: '+49451558332'
  }
};

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('WhatsApp bot gotowy!');

  await testWysylaniaTur();

  // Debug: wypisz dostępne grupy i ich ID
  const chats = await client.getChats();
  console.log("\nLista grup WhatsApp:");
  chats.forEach(chat => {
    if (chat.isGroup) {
      console.log(`\n📣 GRUPA: ${chat.name}`);
      console.log(`➡️ ID: ${chat.id._serialized}`);
    }
  });
});

async function testWysylaniaTur() {
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

Bitte dringend auf https://tour.ltslogistik.de/?location=${info.slug} ergänzen.

📌 Diese Nachricht wurde automatisch generiert.`.trim();

      const msgGroup = `
[Standort: ${name}]
Achtung: Für den heutigen Tag (${today}) wurden nicht alle Touren den Fahrzeugen zugewiesen.

📌 Der Vorarbeiter wurde bereits informiert.
📌 Diese Nachricht wurde automatisch generiert.`.trim();

      await client.sendMessage(`${info.phone}@c.us`, msgManager);
      await client.sendMessage('120363419266988965@g.us', msgGroup);

      console.log(`🔔 Test: wiadomość wysłana do ${name}`);
    } else {
      console.log(`✔️ ${name} – wszystkie tury przypisane.`);
    }
  }
}

cron.schedule('30 7 * * 1-5', async () => {
  await testWysylaniaTur();
});

client.initialize();
