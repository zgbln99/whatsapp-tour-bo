// index.js - WhatsApp Universal Bot – Toury + Przeglądy techniczne
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const fs = require('fs');

// Konfiguracja bazy danych
const db = mysql.createPool({
  host: '92.113.22.6',
  user: 'u918515209_tour',
  password: 'Marek2211.!',
  database: 'u918515209_tour'
});

// Lokalizacje dla tour
let locations = {
  Stavenhagen: { slug: 'stavenhagen', phone: '491737008662' },
  Hof: { slug: 'hof', phone: '4915120200738' },
  Radeburg: { slug: 'radeburg', phone: '48668056220' }
};

// Konfiguracja przegladów
const FLEET_INSPECTION_URL = 'https://fleet.ltslogistik.de/inspection.php';
const TOUR_GROUP_ID = '120363419266988965@g.us'; // Grupa dla tour
const FLEET_GROUP_ID = '120363418541056299@g.us'; // Grupa dla przegladów

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
  console.log('Universal Bot - WhatsApp jest gotowy!');
  telegram.sendMessage(TELEGRAM_CHAT_ID, '✅ Universal Bot (Toury + Technische Prüfungen) został uruchomiony!')
    .catch(console.error);
});

// Event listener dla rozłączenia
client.on('disconnected', (reason) => {
  console.log('Universal Bot - WhatsApp został rozłączony:', reason);
  telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ Universal Bot został rozłączony: ' + reason)
    .catch(console.error);
});

// Uruchomienie klienta WhatsApp
client.initialize();

// ==================== FUNKCJE PRZEGLADÓW ====================

// Funkcja pobierania danych o przegladach z inspection.php
async function fetchInspectionData() {
  return new Promise((resolve, reject) => {
    console.log('Pobieranie danych przegladów z:', FLEET_INSPECTION_URL);

    const options = {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    https.get(FLEET_INSPECTION_URL, options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          console.log('Otrzymano dane przegladów:', jsonData);

          if (jsonData.status !== 'ok') {
            reject(new Error('Błędny status odpowiedzi: ' + (jsonData.error || 'nieznany')));
            return;
          }

          resolve(jsonData.entries || []);
        } catch (error) {
          reject(new Error('Błąd parsowania JSON: ' + error.message));
        }
      });
    }).on('error', (error) => {
      reject(new Error('Błąd HTTP: ' + error.message));
    });
  });
}

// Funkcja pobierania WSZYSTKICH danych przegladów (w tym przeterminowanych)
async function fetchAllInspectionData() {
  try {
    // Używamy inspection.php, który teraz zwraca też przeterminowane
    const inspectionData = await fetchInspectionData();

    return inspectionData.map(inspection => ({
      license_plate: inspection.license_plate,
      typ: inspection.typ,
      faellig_am: inspection.faellig_am,
      daysDiff: inspection.days_diff || 0,
      isExpired: inspection.status === 'expired',
      isExpiringSoon: inspection.status === 'expiring'
    }));

  } catch (error) {
    console.error('Błąd pobierania wszystkich danych przegladów:', error.message);
    throw error;
  }
}

// Funkcja tworzenia wiadomości o przegladach
function createInspectionMessage(inspections) {
  const today = new Date().toLocaleDateString('de-DE');

  // Grupuj przeglądy według pojazdu
  const vehicleGroups = {};
  inspections.forEach(inspection => {
    const plate = inspection.license_plate;
    if (!vehicleGroups[plate]) {
      vehicleGroups[plate] = [];
    }
    vehicleGroups[plate].push(inspection);
  });

  // Przetwórz grupy na pojedyncze wpisy
  const groupedInspections = [];
  Object.keys(vehicleGroups).forEach(plate => {
    const vehicleInspections = vehicleGroups[plate];

    // Sortuj przeglądy pojazdu według pilności (przeterminowane najpierw, potem najbliższe)
    vehicleInspections.sort((a, b) => {
      if (a.isExpired && !b.isExpired) return -1;
      if (!a.isExpired && b.isExpired) return 1;
      return a.daysDiff - b.daysDiff;
    });

    // Znajdź najkrytyczniejszy przegląd (do sortowania całej listy)
    const mostCritical = vehicleInspections[0];

    // Przygotuj opisy dla każdego typu przeglądu
    const descriptions = vehicleInspections.map(insp => {
      if (insp.isExpired) {
        return insp.typ + ' überfällig seit ' + Math.abs(insp.daysDiff) + ' Tagen';
      } else {
        return insp.typ + ' noch ' + insp.daysDiff + ' Tage';
      }
    });

    // Przygotuj listę typów
    const types = vehicleInspections.map(insp => insp.typ).join(', ');

    groupedInspections.push({
      license_plate: plate,
      types: types,
      descriptions: descriptions,
      mostCritical: mostCritical,
      hasExpired: vehicleInspections.some(insp => insp.isExpired),
      hasExpiring14: vehicleInspections.some(insp => !insp.isExpired && insp.daysDiff < 15),
      hasExpiring30: vehicleInspections.some(insp => !insp.isExpired && insp.daysDiff >= 15 && insp.daysDiff <= 30)
    });
  });

  // Sortuj pojazdy według najkrytyczniejszego przeglądu
  groupedInspections.sort((a, b) => {
    if (a.mostCritical.isExpired && !b.mostCritical.isExpired) return -1;
    if (!a.mostCritical.isExpired && b.mostCritical.isExpired) return 1;
    return a.mostCritical.daysDiff - b.mostCritical.daysDiff;
  });

  // Podziel na kategorie
  const expired = groupedInspections.filter(v => v.hasExpired);
  const expiring14 = groupedInspections.filter(v => !v.hasExpired && v.hasExpiring14);
  const expiring30 = groupedInspections.filter(v => !v.hasExpired && !v.hasExpiring14 && v.hasExpiring30);

  let message = '🚗 TECHNISCHE PRÜFUNGEN - Wochenbericht\n';
  message += '📅 Datum: ' + today + '\n\n';

  if (expired.length > 0) {
    message += '🚨 ÜBERFÄLLIG (' + expired.length + '):\n';
    expired.forEach(vehicle => {
      message += '• ' + vehicle.license_plate + ' (' + vehicle.types + ') - ' + vehicle.descriptions.join(', ') + '\n';
    });
    message += '\n';
  }

  if (expiring14.length > 0) {
    message += '🔥 DRINGEND - BIS 14 TAGE (' + expiring14.length + '):\n';
    expiring14.forEach(vehicle => {
      message += '• ' + vehicle.license_plate + ' (' + vehicle.types + ') - ' + vehicle.descriptions.join(', ') + '\n';
    });
    message += '\n';
  }

  if (expiring30.length > 0) {
    message += '⚠️ BIS 30 TAGE (' + expiring30.length + '):\n';
    expiring30.forEach(vehicle => {
      message += '• ' + vehicle.license_plate + ' (' + vehicle.types + ') - ' + vehicle.descriptions.join(', ') + '\n';
    });
    message += '\n';
  }

  if (expired.length === 0 && expiring30.length === 0 && expiring14.length === 0) {
    message += '✅ Alle Prüfungen sind aktuell!\n\n';
  }

  message += '🔗 Panel: https://fleet.ltslogistik.de/\n\n';
  message += 'Automatische Nachricht - jeden Montag um 10:00 Uhr.';

  return message;
}

// Główna funkcja sprawdzania i wysyłania raportów przegladów
async function checkAndSendInspectionReport() {
  try {
    console.log('Rozpoczynam sprawdzanie przegladów...');

    const clientState = await client.getState();
    if (clientState !== 'CONNECTED') {
      throw new Error('WhatsApp nie jest połączony: ' + clientState);
    }

    const inspections = await fetchAllInspectionData();

    if (inspections.length === 0) {
      throw new Error('Nie pobrano żadnych danych o przegladach');
    }

    const message = createInspectionMessage(inspections);

    await client.sendMessage(FLEET_GROUP_ID, message);

    const expired = inspections.filter(i => i.isExpired).length;
    const expiring = inspections.filter(i => i.isExpiringSoon).length;
    const summary = 'Wysłano raport przegladów: ' + expired + ' przeterminowanych, ' + expiring + ' kończących się wkrótce';
    await telegram.sendMessage(TELEGRAM_CHAT_ID, '✅ ' + summary);

    console.log('Raport przegladów wysłany pomyślnie');

  } catch (error) {
    console.error('Błąd podczas sprawdzania przegladów:', error);
    await telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ Prüfungsfehler: ' + error.message);
  }
}

// CRON JOB - Przeglądy co poniedziałek o 10:00
cron.schedule('0 10 * * 1', () => {
  console.log('Uruchamianie sprawdzenia przegladów - poniedziałek 10:00');
  checkAndSendInspectionReport();
}, {
  timezone: "Europe/Berlin"
});

// ==================== KOMENDY TELEGRAM ====================

// Basic status
telegram.onText(/\/status/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🤖 Universal Bot jest aktywny\n• Toury: ✅\n• Przeglądy: ✅\n• WhatsApp: połączony');
});

// Czas serwera
telegram.onText(/\/czas/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  telegram.sendMessage(msg.chat.id, '🕒 Serverzeit (Europe/Berlin): ' + time);
});

// Restart bota
telegram.onText(/\/restart/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '♻️ Der Bot wird über PM2 neu gestartet...');
  require('child_process').exec('pm2 restart tourbot');
});

// Logi
telegram.onText(/\/logi/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '📁 Logs: /root/.pm2/logs/tourbot-out.log');
});

// ==================== KOMENDY LOKALIZACJI ====================

// Dodaj lokalizację
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

// Zmień numer telefonu
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

// Usuń lokalizację
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

// Lista lokalizacji
telegram.onText(/\/lista/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  let out = '📍 Aktuelle Standorte:\n';

  for (const nazwa in locations) {
    const info = locations[nazwa];
    out += '• ' + nazwa + ' (Slug: ' + info.slug + ', Nummer: ' + info.phone + ')\n';
  }

  telegram.sendMessage(msg.chat.id, out);
});

// ==================== KOMENDY TOUR ====================

// Podgląd nieprzypisanych tour
telegram.onText(/\/podglad/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const today = new Date().toISOString().split('T')[0];
    let summary = '';

    for (const name in locations) {
      const info = locations[name];
      const query = 'SELECT COUNT(*) as count FROM tours t JOIN locations l ON t.location_id = l.id LEFT JOIN assignments a ON t.tour_number = a.tour_number AND t.location_id = a.location_id AND a.assignment_date = ? WHERE a.id IS NULL AND l.unique_slug = ?';
      const [rows] = await db.query(query, [today, info.slug]);

      if (rows[0].count > 0) {
        summary += '\n• ' + name + ': ' + rows[0].count + ' Touren nicht zugewiesen.';
      }
    }

    if (summary.length > 0) {
      telegram.sendMessage(msg.chat.id, '📋 Übersicht nicht zugewiesener Touren:\n' + summary);
    } else {
      telegram.sendMessage(msg.chat.id, '✅ Alle Touren sind zugewiesen.');
    }
  } catch (error) {
    console.error('Błąd w /podglad:', error);
    telegram.sendMessage(msg.chat.id, '❌ Błąd: ' + error.message);
  }
});

// Test wiadomości do kierownika
telegram.onText(/\/test_kierownik (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const nazwa = match[1].trim();
    const info = locations[nazwa];

    if (!info) {
      return telegram.sendMessage(msg.chat.id, '❌ Standort ' + nazwa + ' existiert nicht.');
    }

    const today = new Date().toISOString().split('T')[0];
    const query = 'SELECT COUNT(*) as count FROM tours t JOIN locations l ON t.location_id = l.id LEFT JOIN assignments a ON t.tour_number = a.tour_number AND t.location_id = a.location_id AND a.assignment_date = ? WHERE a.id IS NULL AND l.unique_slug = ?';
    const [rows] = await db.query(query, [today, info.slug]);

    const msgText = '[Standort: ' + nazwa + ']\n' +
      'Hinweis: Für heute, den ' + today + ', gibt es Touren, die nicht gestartet sind (' + rows[0].count + ').\n' +
      'Bitte trage die Daten dringend auf der folgenden Seite ein – https://tour.ltslogistik.de/?location=' + info.slug + '.\n\n' +
      'Automatische Nachricht. Falls alles korrekt ist und der Grund für die nicht gestarteten Touren bereits der Geschäftsleitung mitgeteilt wurde, bitte diese Nachricht ignorieren.';

    await client.sendMessage(info.phone + '@c.us', msgText);
    telegram.sendMessage(msg.chat.id, '📤 Nachricht an ' + nazwa + ' wurde gesendet.');
  } catch (error) {
    console.error('Błąd w /test_kierownik:', error);
    telegram.sendMessage(msg.chat.id, '❌ Błąd: ' + error.message);
  }
});

// Test wiadomości grupowej tour
telegram.onText(/\/test_grupa/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const clientState = await client.getState();
    if (clientState !== 'CONNECTED') {
      return telegram.sendMessage(msg.chat.id, '❌ WhatsApp nie jest połączony. Status: ' + clientState);
    }

    const today = new Date().toISOString().split('T')[0];
    let text = '📋 Statusübersicht für ' + today + ':\n';

    for (const name in locations) {
      const info = locations[name];

      try {
        const queryAllTours = 'SELECT COUNT(*) AS count FROM tours t JOIN locations l ON t.location_id = l.id WHERE l.unique_slug = ?';
        const [allTours] = await db.query(queryAllTours, [info.slug]);

        const queryAssigned = 'SELECT COUNT(*) AS count FROM assignments a JOIN tours t ON a.tour_number = t.tour_number JOIN locations l ON t.location_id = l.id WHERE l.unique_slug = ? AND a.assignment_date = ?';
        const [assignedTours] = await db.query(queryAssigned, [info.slug, today]);

        const total = allTours[0].count;
        const assigned = assignedTours[0].count;
        const notAssigned = total - assigned;

        text += '\n[Standort: ' + name + ']\nZugewiesen: ' + assigned + ', Nicht zugewiesen: ' + notAssigned;
      } catch (locError) {
        console.error('Błąd dla lokalizacji', name + ':', locError);
        text += '\n[Standort: ' + name + ']\nBłąd pobierania danych';
      }
    }

    text += '\n\nAutomatische Nachricht. Der Vorarbeiter wurde über das Fehlen der Tour-Zuordnung informiert.';

    await client.sendMessage(TOUR_GROUP_ID, text);
    telegram.sendMessage(msg.chat.id, '📤 Gruppenmeldung wurde gesendet.');

  } catch (error) {
    console.error('Błąd w /test_grupa:', error);
    telegram.sendMessage(msg.chat.id, '❌ Błąd: ' + error.message);
  }
});

// ==================== KOMENDY PRZEGLADÓW ====================

// Status przegladów
telegram.onText(/\/fleet_status/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🚗 Fleet Überwachung ist aktiv\n📅 Automatische Berichte: jeden Montag 10:00 Uhr');
});

// Test przegladów
telegram.onText(/\/test_fleet/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🔄 Starte Test der Prüfungen...');
  checkAndSendInspectionReport();
});

// Podgląd przegladów
telegram.onText(/\/fleet_preview/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const inspections = await fetchAllInspectionData();

    // Grupuj według pojazdu
    const vehicleGroups = {};
    inspections.forEach(inspection => {
      const plate = inspection.license_plate;
      if (!vehicleGroups[plate]) {
        vehicleGroups[plate] = [];
      }
      vehicleGroups[plate].push(inspection);
    });

    const totalVehicles = Object.keys(vehicleGroups).length;
    const expiredVehicles = Object.values(vehicleGroups).filter(group =>
      group.some(insp => insp.isExpired)
    ).length;
    const expiringVehicles = Object.values(vehicleGroups).filter(group =>
      group.some(insp => insp.isExpiringSoon) && !group.some(insp => insp.isExpired)
    ).length;

    let preview = '🚗 Vorschau Prüfungen:\n';
    preview += '• Fahrzeuge gesamt: ' + totalVehicles + '\n';
    preview += '• Mit überfälligen Prüfungen: ' + expiredVehicles + '\n';
    preview += '• Mit ablaufenden Prüfungen: ' + expiringVehicles + '\n\n';

    if (expiredVehicles > 0) {
      preview += 'Überfällige (Beispiel):\n';
      let count = 0;
      for (const [plate, group] of Object.entries(vehicleGroups)) {
        if (count >= 5) break;
        if (group.some(insp => insp.isExpired)) {
          const expiredTypes = group.filter(insp => insp.isExpired).map(insp => insp.typ);
          const maxDays = Math.max(...group.filter(insp => insp.isExpired).map(insp => Math.abs(insp.daysDiff)));
          preview += '• ' + plate + ' (' + expiredTypes.join(', ') + ') - bis zu ' + maxDays + ' Tage\n';
          count++;
        }
      }
      if (expiredVehicles > 5) preview += '... und ' + (expiredVehicles - 5) + ' weitere Fahrzeuge\n';
    }

    telegram.sendMessage(msg.chat.id, preview);
  } catch (error) {
    telegram.sendMessage(msg.chat.id, '❌ Błąd: ' + error.message);
  }
});

// ==================== KOMENDY DIAGNOSTYCZNE ====================

// Diagnostyka WhatsApp
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

// Lista grup WhatsApp
telegram.onText(/\/grupy/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup);

    let groupList = '👥 Dostępne grupy WhatsApp:\n';
    groups.forEach((group, index) => {
      if (index < 10) {
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

// Test połączenia z bazą danych tour
telegram.onText(/\/test_db/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
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

console.log('🚀 Universal Bot uruchamiany...');
console.log('📋 Funkcje: Toury + Technische Prüfungen');
console.log('📅 Harmonogram Prüfungen: Jeden Montag um 10:00 Uhr (Europe/Berlin)');
