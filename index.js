// index.js - WhatsApp Tour Bot – Produkcyjna wersja z Telegramem i zarządzaniem
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

// Konfiguracja bazy danych
const db = mysql.createPool({
  host: '92.113.22.6',
  user: 'u918515209_tour',
  password: 'Marek2211.!',
  database: 'u918515209_tour'
});

// Lokalizacje
let locations = {
  Stavenhagen: { slug: 'stavenhagen', phone: '491737008662' },
  Hof: { slug: 'hof', phone: '4915120200738' },
  Radeburg: { slug: 'radeburg', phone: '48668056220' }
};

// Funkcja zapisywania lokalizacji do pliku
function saveLocationsToFile() {
  const content = 'let locations = ' + JSON.stringify(locations, null, 2) + ';\nmodule.exports = locations;';
  fs.writeFileSync('./locations.js', content, 'utf8');
}

// Konfiguracja Telegram
const TELEGRAM_BOT_TOKEN = '7688074026:AAFz9aK-WAUYeFnB-yISbSIFZe1_DlVr1dI';
const TELEGRAM_CHAT_ID = '7531268785';
const telegram = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Inicjalizacja klienta WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Event listener dla QR code
client.on('qr', (qr) => {
  console.log('QR Code otrzymany, skanuj go w aplikacji WhatsApp!');
  qrcode.generate(qr, { small: true });
});

// Event listener dla gotowości klienta
client.on('ready', () => {
  console.log('Klient WhatsApp jest gotowy!');
  telegram.sendMessage(TELEGRAM_CHAT_ID, '✅ WhatsApp Bot został uruchomiony i jest gotowy do pracy!')
    .catch(console.error);
});

// Event listener dla rozłączenia
client.on('disconnected', (reason) => {
  console.log('Klient WhatsApp został rozłączony:', reason);
  telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ WhatsApp Bot został rozłączony: ' + reason)
    .catch(console.error);
});

// Uruchomienie klienta WhatsApp
client.initialize();

// Telegram - Status bota
telegram.onText(/\/status/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🤖 Der Bot ist aktiv und mit WhatsApp und der Datenbank verbunden.');
});

// Telegram - Czas serwera
telegram.onText(/\/czas/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  telegram.sendMessage(msg.chat.id, '🕒 Serverzeit (Europe/Berlin): ' + time);
});

// Telegram - Restart bota
telegram.onText(/\/restart/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '♻️ Der Bot wird über PM2 neu gestartet...');
  require('child_process').exec('pm2 restart tourbot');
});

// Telegram - Logi
telegram.onText(/\/logi/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '📁 Logs: /root/.pm2/logs/tourbot-out.log');
});

// Telegram - Dodaj lokalizację
telegram.onText(/\/dodaj (.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const params = match[1].split(',').map(v => v.trim());
  const nazwa = params[0];
  const slug = params[1];
  const phone = params[2];

  if (!nazwa || !slug || !phone) {
    return telegram.sendMessage(msg.chat.id, '❌ Nutzung: /dodaj Name,slug,Nummer');
  }

  locations[nazwa] = { slug: slug, phone: phone };
  saveLocationsToFile();
  telegram.sendMessage(msg.chat.id, '✅ Standort hinzugefügt: ' + nazwa + ' (' + slug + ') mit Nummer ' + phone);
});

// Telegram - Zmień numer telefonu
telegram.onText(/\/zmien (.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const params = match[1].split(',').map(v => v.trim());
  const nazwa = params[0];
  const newPhone = params[1];

  if (!locations[nazwa]) {
    return telegram.sendMessage(msg.chat.id, '❌ Standort ' + nazwa + ' existiert nicht.');
  }

  locations[nazwa].phone = newPhone;
  saveLocationsToFile();
  telegram.sendMessage(msg.chat.id, '🔁 Nummer für Standort ' + nazwa + ' geändert zu ' + newPhone);
});

// Telegram - Usuń lokalizację
telegram.onText(/\/usun (.+)/, (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const nazwa = match[1].trim();

  if (!locations[nazwa]) {
    return telegram.sendMessage(msg.chat.id, '❌ Standort ' + nazwa + ' existiert nicht.');
  }

  delete locations[nazwa];
  saveLocationsToFile();
  telegram.sendMessage(msg.chat.id, '🗑️ Standort ' + nazwa + ' wurde gelöscht.');
});

// Telegram - Lista lokalizacji
telegram.onText(/\/lista/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  let out = '📍 Aktuelle Standorte:\n';

  for (const nazwa in locations) {
    const info = locations[nazwa];
    out += '• ' + nazwa + ' (Slug: ' + info.slug + ', Nummer: ' + info.phone + ')\n';
  }

  telegram.sendMessage(msg.chat.id, out);
});

// Telegram - Diagnostyka WhatsApp
telegram.onText(/\/whatsapp_status/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const state = await client.getState();
    const info = await client.getWWebVersion();
    telegram.sendMessage(msg.chat.id, '📱 WhatsApp Status:\n' +
      '• Stan: ' + state + '\n' +
      '• Wersja: ' + info + '\n' +
      '• Czas: ' + new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }));
  } catch (error) {
    telegram.sendMessage(msg.chat.id, '❌ Nie można pobrać statusu WhatsApp: ' + error.message);
  }
});

// Telegram - Lista grup WhatsApp
telegram.onText(/\/grupy/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup);

    let groupList = '👥 Dostępne grupy WhatsApp:\n';
    groups.forEach((group, index) => {
      if (index < 10) { // Pokaż tylko pierwszych 10
        groupList += '• ' + group.name + ' (ID: ' + group.id._serialized + ')\n';
      }
    });

    if (groups.length === 0) {
      groupList += 'Brak dostępnych grup.';
    } else if (groups.length > 10) {
      groupList += '\n... i ' + (groups.length - 10) + ' więcej grup.';
    }

    telegram.sendMessage(msg.chat.id, groupList);
  } catch (error) {
    telegram.sendMessage(msg.chat.id, '❌ Nie można pobrać listy grup: ' + error.message);
  }
});

// Telegram - Test połączenia bazy danych
telegram.onText(/\/test_db/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    // Sprawdź strukturę tabeli tours
    const [columns] = await db.query('DESCRIBE tours');
    let columnsInfo = '🗄️ Kolumny tabeli tours:\n';
    columns.forEach(col => {
      columnsInfo += '• ' + col.Field + ' (' + col.Type + ')\n';
    });

    const [locations_count] = await db.query('SELECT COUNT(*) as count FROM locations');
    const [tours_count] = await db.query('SELECT COUNT(*) as count FROM tours');

    telegram.sendMessage(msg.chat.id, '🗄️ Status bazy danych:\n' +
      '• Połączenie: ✅ OK\n' +
      '• Wszystkie toury: ' + tours_count[0].count + '\n' +
      '• Lokalizacje: ' + locations_count[0].count + '\n\n' + columnsInfo);
  } catch (error) {
    telegram.sendMessage(msg.chat.id, '❌ Błąd bazy danych: ' + error.message);
  }
});

// Telegram - Sprawdź strukturę assignments
telegram.onText(/\/struktura/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const [tours_cols] = await db.query('DESCRIBE tours');
    const [assignments_cols] = await db.query('DESCRIBE assignments');
    const [locations_cols] = await db.query('DESCRIBE locations');

    let response = '📋 Struktura tabel:\n\n';

    response += '🚛 TOURS:\n';
    tours_cols.forEach(col => response += '• ' + col.Field + '\n');

    response += '\n📋 ASSIGNMENTS:\n';
    assignments_cols.forEach(col => response += '• ' + col.Field + '\n');

    response += '\n📍 LOCATIONS:\n';
    locations_cols.forEach(col => response += '• ' + col.Field + '\n');

    telegram.sendMessage(msg.chat.id, response);
  } catch (error) {
    telegram.sendMessage(msg.chat.id, '❌ Błąd: ' + error.message);
  }
});
telegram.onText(/\/podglad/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const today = new Date().toISOString().split('T')[0];
    let summary = '';

    for (const name in locations) {
      const info = locations[name];
      const query = 'SELECT t.tour_number FROM tours t LEFT JOIN assignments a ON t.tour_number = a.tour_number AND t.location_id = a.location_id AND a.assignment_date = ? JOIN locations l ON t.location_id = l.id WHERE a.id IS NULL AND l.unique_slug = ?';
      const [rows] = await db.query(query, [today, info.slug]);

      if (rows.length > 0) {
        summary += '\n• ' + name + ': ' + rows.length + ' Touren nicht zugewiesen.';
      }
    }

    if (summary.length > 0) {
      telegram.sendMessage(msg.chat.id, '📋 Übersicht nicht zugewiesener Touren:\n' + summary);
    } else {
      telegram.sendMessage(msg.chat.id, '✅ Alle Touren sind zugewiesen.');
    }
  } catch (error) {
    console.error('Błąd w /podglad:', error);
    telegram.sendMessage(msg.chat.id, '❌ Wystąpił błąd podczas pobierania danych.');
  }
});

// Telegram - Test wiadomości do kierownika
telegram.onText(/\/test_kierownik (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const nazwa = match[1].trim();
    const info = locations[nazwa];

    if (!info) {
      return telegram.sendMessage(msg.chat.id, '❌ Standort ' + nazwa + ' existiert nicht.');
    }

    const today = new Date().toISOString().split('T')[0];
    const query = 'SELECT t.tour_number FROM tours t LEFT JOIN assignments a ON t.tour_number = a.tour_number AND t.location_id = a.location_id AND a.assignment_date = ? JOIN locations l ON t.location_id = l.id WHERE a.id IS NULL AND l.unique_slug = ?';
    const [rows] = await db.query(query, [today, info.slug]);

    const msgText = '[Standort: ' + nazwa + ']\n' +
      'Hinweis: Für heute, den ' + today + ', gibt es Touren, die nicht gestartet sind (' + rows.length + ').\n' +
      'Bitte trage die Daten dringend auf der folgenden Seite ein – https://tour.ltslogistik.de/?location=' + info.slug + '.\n\n' +
      'Automatische Nachricht. Falls alles korrekt ist und der Grund für die nicht gestarteten Touren bereits der Geschäftsleitung mitgeteilt wurde, bitte diese Nachricht ignorieren.';

    await client.sendMessage(info.phone + '@c.us', msgText);
    telegram.sendMessage(msg.chat.id, '📤 Nachricht an ' + nazwa + ' wurde gesendet.');
  } catch (error) {
    console.error('Błąd w /test_kierownik:', error);
    telegram.sendMessage(msg.chat.id, '❌ Wystąpił błąd podczas wysyłania wiadomości.');
  }
});

// Telegram - Test wiadomości grupowej
telegram.onText(/\/test_grupa/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    // Sprawdź status połączenia WhatsApp
    const clientState = await client.getState();
    console.log('WhatsApp Client State:', clientState);

    if (clientState !== 'CONNECTED') {
      return telegram.sendMessage(msg.chat.id, '❌ WhatsApp nie jest połączony. Status: ' + clientState);
    }

    const today = new Date().toISOString().split('T')[0];
    let text = '📋 Statusübersicht für ' + today + ':\n';

    console.log('Pobieranie danych dla daty:', today);

    for (const name in locations) {
      const info = locations[name];
      console.log('Przetwarzanie lokalizacji:', name, info);

      // Uproszczone zapytania - sprawdzają tylko assignments na dziś
      try {
        // Sprawdź wszystkie toury dla lokalizacji
        const queryAllTours = 'SELECT COUNT(*) AS count FROM tours t JOIN locations l ON t.location_id = l.id WHERE l.unique_slug = ?';
        const [allTours] = await db.query(queryAllTours, [info.slug]);

        // Sprawdź przypisane toury na dziś
        const queryAssigned = 'SELECT COUNT(*) AS count FROM assignments a JOIN tours t ON a.tour_number = t.tour_number JOIN locations l ON t.location_id = l.id WHERE l.unique_slug = ? AND a.assignment_date = ?';
        const [assignedTours] = await db.query(queryAssigned, [info.slug, today]);

        const total = allTours[0].count;
        const assigned = assignedTours[0].count;
        const notAssigned = total - assigned;

        console.log('Dane dla', name + ':', 'Wszystkie:', total, 'Przypisane:', assigned, 'Nieprzypisane:', notAssigned);
        text += '\n[Standort: ' + name + ']\nZugewiesen: ' + assigned + ', Nicht zugewiesen: ' + notAssigned;
      } catch (locError) {
        console.error('Błąd dla lokalizacji', name + ':', locError);
        text += '\n[Standort: ' + name + ']\nBłąd pobierania danych';
      }
    }

    text += '\n\nAutomatische Nachricht. Der Vorarbeiter wurde über das Fehlen der Tour-Zuordnung informiert.';

    console.log('Wysyłanie wiadomości do grupy:', '120363419266988965@g.us');
    console.log('Treść wiadomości:', text);

    // Sprawdź czy grupa istnieje
    const groupId = '120363419266988965@g.us';
    const chat = await client.getChatById(groupId);
    console.log('Informacje o grupie:', chat.name, chat.participants?.length, 'uczestników');

    await client.sendMessage(groupId, text);
    console.log('Wiadomość grupowa wysłana pomyślnie');
    telegram.sendMessage(msg.chat.id, '📤 Gruppenmeldung wurde gesendet.');

  } catch (error) {
    console.error('Szczegółowy błąd w /test_grupa:', error);
    console.error('Stack trace:', error.stack);

    let errorMsg = '❌ Błąd: ';
    if (error.message.includes('group not found') || error.message.includes('chat not found')) {
      errorMsg += 'Grupa WhatsApp nie została znaleziona. Sprawdź ID grupy.';
    } else if (error.message.includes('not connected')) {
      errorMsg += 'WhatsApp nie jest połączony.';
    } else if (error.code && error.code.includes('ENOTFOUND')) {
      errorMsg += 'Problem z połączeniem internetowym.';
    } else {
      errorMsg += error.message;
    }

    telegram.sendMessage(msg.chat.id, errorMsg);
  }
});

// Obsługa błędów dla procesu
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ Nieobsłużony błąd: ' + reason)
    .catch(console.error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ Krytyczny błąd: ' + error.message)
    .catch(console.error);
  process.exit(1);
});

console.log('🚀 WhatsApp Tour Bot uruchamiany...');
