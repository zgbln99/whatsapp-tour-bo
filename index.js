// index.js - WhatsApp Tour Bot – Wersja produkcyjna 24/7
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const cron = require('node-cron');

const db = mysql.createPool({
  host: '92.113.22.6',
  user: 'u918515209_tour',
  password: 'Marek2211.!',
  database: 'u918515209_tour'
});

const locations = {
  Stavenhagen: { slug: 'stavenhagen', phone: '491737008662' },
  Hof:         { slug: 'hof',         phone: '4915120200738' },
  Radeburg:    { slug: 'radeburg',    phone: '48668056220' }
};

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('✅ WhatsApp bot gotowy!');

  // Wiadomość startowa do właściciela
  try {
    await client.sendMessage('48451558332@c.us', '🚀 Bot został uruchomiony i działa poprawnie.');
    console.log('📤 Wysłano wiadomość startową do właściciela.');
  } catch (err) {
    console.error('❌ Błąd przy wysyłaniu wiadomości startowej do właściciela:', err.message);
  }

  // Wiadomość startowa do grupy
  try {
    await client.sendMessage('120363419266988965@g.us', '📢 System zur Tourüberwachung ist aktiv und bereit.');
    console.log('📤 Wysłano wiadomość startową do grupy.');
  } catch (err) {
    console.error('❌ Błąd przy wysyłaniu wiadomości startowej do grupy:', err.message);
  }

  // Dodatkowo: sprawdzenie nieprzypisanych tur po starcie
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
      await client.sendMessage('120363419266988965@g.us', msg);
      console.log('📤 Wysłano startowy raport nieprzypisanych tur do grupy.');
    } catch (err) {
      console.error('❌ Błąd przy wysyłaniu raportu do grupy:', err.message);
    }
  } else {
    console.log('✅ Wszystkie tury przypisane – brak potrzeby wysyłania raportu.');
  }
});

// CRON – 7:30 codziennie w dni robocze – przypomnienie o braku przypisań
cron.schedule('30 7 * * 1-5', async () => {
  const today = new Date().toISOString().split('T')[0];
  console.log(`🔔 CRON 7:30 – sprawdzam przypisania na ${today}`);

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

      try {
        await client.sendMessage(`${info.phone}@c.us`, msgManager);
        await client.sendMessage('120363419266988965@g.us', msgGroup);
        console.log(`📤 Wysłano przypomnienie dla ${name}`);
      } catch (err) {
        console.error(`❌ Błąd przy wysyłaniu wiadomości do ${name}:`, err.message);
      }
    } else {
      console.log(`✅ ${name}: wszystkie tury przypisane.`);
    }
  }
});

// CRON – 14:00 codziennie w dni robocze – raport o niewyjechanych turach
cron.schedule('0 14 * * 1-5', async () => {
  const today = new Date().toISOString().split('T')[0];
  console.log(`📊 CRON 14:00 – sprawdzam niewyjechane tury na ${today}`);

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
Bitte überprüfen.

📌 Diese Nachricht wurde automatisch generiert.`.trim();

      try {
        await client.sendMessage('120363419266988965@g.us', msgGroup);
        console.log(`📤 Wysłano raport 14:00 dla ${name}`);
      } catch (err) {
        console.error(`❌ Błąd przy wysyłaniu raportu 14:00 do ${name}:`, err.message);
      }
    } else {
      console.log(`✅ ${name}: wszystkie tury wyjechały.`);
    }
  }
});

client.initialize();
