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
        return `${insp.typ}: *${Math.abs(insp.daysDiff)} Tage überfällig*`;
      } else {
        return `${insp.typ}: *noch ${insp.daysDiff} Tage*`;
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

  let message = '🚗 *TECHNISCHE PRÜFUNGEN*\n';
  message += '📊 _Wochenbericht_\n\n';
  message += `📅 *Datum:* ${today}\n`;
  message += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n\n';

  if (expired.length > 0) {
    message += `🚨 *ÜBERFÄLLIG* (${expired.length})\n`;
    expired.forEach(vehicle => {
      message += `🔴 *${vehicle.license_plate}*\n`;
      vehicle.descriptions.forEach(desc => {
        message += `   ${desc}\n`;
      });
      message += '\n';
    });
  }

  if (expiring14.length > 0) {
    message += `🔥 *DRINGEND - BIS 14 TAGE* (${expiring14.length})\n`;
    expiring14.forEach(vehicle => {
      message += `🟠 *${vehicle.license_plate}*\n`;
      vehicle.descriptions.forEach(desc => {
        message += `   ${desc}\n`;
      });
      message += '\n';
    });
  }

  if (expiring30.length > 0) {
    message += `⚠️ *BIS 30 TAGE* (${expiring30.length})\n`;
    expiring30.forEach(vehicle => {
      message += `🟡 *${vehicle.license_plate}*\n`;
      vehicle.descriptions.forEach(desc => {
        message += `   ${desc}\n`;
      });
      message += '\n';
    });
  }

  if (expired.length === 0 && expiring30.length === 0 && expiring14.length === 0) {
    message += '✅ *Alle Prüfungen sind aktuell!*\n\n';
  }

  message += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n';
  message += '🔗 Panel: https://fleet.ltslogistik.de/\n\n';
  message += '_Automatische Nachricht_\n_Jeden Montag um 10:00 Uhr_';

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

    // Utwórz wiadomość
    const message = createInspectionMessage(inspections);

    // Wyślij na WhatsApp grupę
    await client.sendMessage(FLEET_GROUP_ID, message);

    // Policz pojazdy zamiast pojedynczych przegladów
    const vehicleGroups = {};
    inspections.forEach(inspection => {
      const plate = inspection.license_plate;
      if (!vehicleGroups[plate]) {
        vehicleGroups[plate] = [];
      }
      vehicleGroups[plate].push(inspection);
    });

    const expiredVehicles = Object.values(vehicleGroups).filter(group =>
      group.some(insp => insp.isExpired)
    ).length;
    const expiringVehicles = Object.values(vehicleGroups).filter(group =>
      group.some(insp => insp.isExpiringSoon) && !group.some(insp => insp.isExpired)
    ).length;

    // Powiadom na Telegram o powodzeniu
    const summary = 'Prüfungsbericht gesendet: ' + expiredVehicles + ' Fahrzeuge überfällig, ' + expiringVehicles + ' Fahrzeuge ablaufend bald';
    await telegram.sendMessage(TELEGRAM_CHAT_ID, '✅ ' + summary);

    console.log('Raport przegladów wysłany pomyślnie');

  } catch (error) {
    console.error('Błąd podczas sprawdzania przegladów:', error);
    await telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ Prüfungsfehler: ' + error.message);
  }
}

// ==================== FUNKCJE AUTOMATYCZNE TOUR ====================

// Funkcja sprawdzania nieprzypisanych tour i powiadamiania kierowników (7:30 pon-pt)
async function checkUnassignedToursAndNotifyManagers() {
  const today = new Date().toISOString().split('T')[0];

  try {
    for (const nazwa in locations) {
      const info = locations[nazwa];

      try {
        // Sprawdź nieprzypisane toury dla tej lokalizacji
        const query = 'SELECT COUNT(*) as count FROM tours t JOIN locations l ON t.location_id = l.id LEFT JOIN assignments a ON t.tour_number = a.tour_number AND t.location_id = a.location_id AND a.assignment_date = ? WHERE a.id IS NULL AND l.unique_slug = ?';
        const [rows] = await db.query(query, [today, info.slug]);

        if (rows[0].count > 0) {
          // Są nieprzypisane toury - wyślij wiadomość do kierownika
          const msgText = '⚠️ *TOUR ERINNERUNG*\n\n' +
            `📍 *Standort:* ${nazwa}\n` +
            `📅 *Datum:* ${today}\n\n` +
            `🚨 *Hinweis:*\n` +
            `Heute gibt es *${rows[0].count} Touren*,\n` +
            `die nicht gestartet sind.\n\n` +
            '📋 *Bitte Daten eintragen:*\n' +
            `🔗 https://tour.ltsog.de/?location=${info.slug}\n\n` +
            '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n' +
            '_Automatische Nachricht um 7:30 Uhr_\n\n' +
            '_Falls alles korrekt ist und der Grund bereits der Geschäftsleitung mitgeteilt wurde, bitte ignorieren._';

          await client.sendMessage(info.phone + '@c.us', msgText);
          console.log(`📤 Benachrichtigung gesendet an Manager: ${nazwa} (${rows[0].count} nicht zugewiesen)`);

          // Powiadom na Telegram o wysłanej wiadomości
          await telegram.sendMessage(TELEGRAM_CHAT_ID, `📤 Benachrichtigung gesendet: ${nazwa} - ${rows[0].count} nicht zugewiesene Touren`);
        }
      } catch (locError) {
        console.error(`❌ Fehler für Standort ${nazwa}:`, locError);
        await telegram.sendMessage(TELEGRAM_CHAT_ID, `❌ Fehler beim Prüfen von Standort ${nazwa}: ${locError.message}`);
      }
    }

    // Podsumowanie na Telegram
    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    await telegram.sendMessage(TELEGRAM_CHAT_ID, `✅ Prüfung nicht zugewiesener Touren abgeschlossen um ${time}`);

  } catch (error) {
    console.error('❌ Fehler bei automatischer Tour-Prüfung:', error);
    await telegram.sendMessage(TELEGRAM_CHAT_ID, `❌ Fehler bei automatischer Tour-Prüfung: ${error.message}`);
  }
}

// Funkcja wysyłania dziennego podsumowania do grupy WhatsApp (10:30 pon-pt)
async function sendDailySummaryToGroup() {
  const today = new Date().toISOString().split('T')[0];

  try {
    let text = '📋 *TOUR STATUSÜBERSICHT*\n\n';
    text += `📅 *Datum:* ${today}\n`;
    text += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n\n';

    let totalIssues = 0;

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

        if (notAssigned > 0) totalIssues += notAssigned;

        const status = notAssigned > 0 ? '🔴' : '🟢';
        text += `${status} *${name}*\n`;
        text += `   Zugewiesen: *${assigned}*\n`;
        text += `   Nicht zugewiesen: *${notAssigned}*\n\n`;
      } catch (locError) {
        console.error('Błąd dla lokalizacji', name + ':', locError);
        text += `🔴 *${name}*\n`;
        text += '   _Fehler beim Abrufen_\n\n';
      }
    }

    text += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n';
    text += '_Automatische Nachricht um 10:30 Uhr_\n';
    text += '_Der Vorarbeiter wurde informiert_';

    // Wyślij do grupy WhatsApp
    await client.sendMessage(TOUR_GROUP_ID, text);

    // Powiadom na Telegram o wysłaniu
    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    const summary = totalIssues > 0 ?
      `📤 Tour-Zusammenfassung gesendet um ${time}. Problem: ${totalIssues} nicht zugewiesen.` :
      `📤 Tour-Zusammenfassung gesendet um ${time}. Alles OK! ✅`;

    await telegram.sendMessage(TELEGRAM_CHAT_ID, summary);
    console.log('📤 Tägliche Tour-Zusammenfassung an WhatsApp-Gruppe gesendet');

  } catch (error) {
    console.error('❌ Fehler beim Senden der täglichen Zusammenfassung:', error);
    await telegram.sendMessage(TELEGRAM_CHAT_ID, `❌ Fehler bei täglicher Tour-Zusammenfassung: ${error.message}`);
  }
}

// ==================== CRON JOBS ====================

// 1. Przeglądy techniczne - każdy poniedziałek o 10:00
cron.schedule('0 10 * * 1', () => {
  console.log('🚗 Uruchamiam automatyczny raport przegladów...');
  checkAndSendInspectionReport();
}, {
  timezone: "Europe/Berlin"
});

// 2. Sprawdzenie nieprzypisanych tour i powiadomienia kierowników - poniedziałek-piątek o 7:30
cron.schedule('30 7 * * 1-5', async () => {
  console.log('📋 Sprawdzam nieprzypisane toury i wysyłam powiadomienia kierownikom...');
  await checkUnassignedToursAndNotifyManagers();
}, {
  timezone: "Europe/Berlin"
});

// 3. Podsumowanie tour do grupy WhatsApp - poniedziałek-piątek o 10:30
cron.schedule('30 10 * * 1-5', async () => {
  console.log('📊 Wysyłam podsumowanie tour do grupy WhatsApp...');
  await sendDailySummaryToGroup();
}, {
  timezone: "Europe/Berlin"
});

// ==================== KOMENDY TELEGRAM ====================

// Basic status
telegram.onText(/\/status/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🤖 *UNIVERSAL BOT*\n\n✅ *Status:* Aktiv\n🚛 *Toury:* Bereit\n🚗 *Prüfungen:* Bereit\n📱 *WhatsApp:* Verbunden');
});

// Czas serwera
telegram.onText(/\/czas/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  telegram.sendMessage(msg.chat.id, `🕒 *SERVERZEIT*\n\n📅 ${time}\n🌍 Europe/Berlin`);
});

// Restart bota
telegram.onText(/\/restart/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🔄 *Restartuję bota...*');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Logi
telegram.onText(/\/logi/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '📁 Logs: /root/.pm2/logs/tourbot-out.log');
});

// Harmonogram automatycznych zadań
telegram.onText(/\/harmonogram/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  const now = new Date().toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });

  let schedule = '📅 *HARMONOGRAM AUTOMATYCZNY*\n\n';
  schedule += `🕒 *Aktualna data:* ${now}\n\n`;
  schedule += '⏰ *Zadania automatyczne:*\n\n';
  schedule += '🔸 *7:30* (Pon-Pt)\n';
  schedule += '   📋 Sprawdzenie nieprzypisanych tour\n';
  schedule += '   📤 Powiadomienia kierowników\n\n';
  schedule += '🔸 *10:00* (Poniedziałek)\n';
  schedule += '   🚗 Raport przegladów technicznych\n\n';
  schedule += '🔸 *10:30* (Pon-Pt)\n';
  schedule += '   📊 Podsumowanie tour do grupy\n\n';
  schedule += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n';
  schedule += '_Strefa czasowa: Europe/Berlin_';

  telegram.sendMessage(msg.chat.id, schedule);
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
  let out = '📍 *STANDORTE*\n\n';

  for (const nazwa in locations) {
    const info = locations[nazwa];
    out += `🏢 *${nazwa}*\n`;
    out += `   Slug: ${info.slug}\n`;
    out += `   Tel: ${info.phone}\n\n`;
  }

  telegram.sendMessage(msg.chat.id, out);
});

// ==================== KOMENDY TOUR ====================

// Podgląd nieprzypisanych tour
telegram.onText(/\/podglad/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    const today = new Date().toISOString().split('T')[0];
    let summary = '📋 *TOUR ÜBERSICHT*\n\n';
    summary += `📅 Datum: ${today}\n\n`;

    let hasIssues = false;

    for (const name in locations) {
      const info = locations[name];
      const query = 'SELECT COUNT(*) as count FROM tours t JOIN locations l ON t.location_id = l.id LEFT JOIN assignments a ON t.tour_number = a.tour_number AND t.location_id = a.location_id AND a.assignment_date = ? WHERE a.id IS NULL AND l.unique_slug = ?';
      const [rows] = await db.query(query, [today, info.slug]);

      if (rows[0].count > 0) {
        summary += `🔴 *${name}*\n`;
        summary += `   ${rows[0].count} nicht zugewiesen\n\n`;
        hasIssues = true;
      } else {
        summary += `🟢 *${name}*\n`;
        summary += `   Alle zugewiesen\n\n`;
      }
    }

    if (!hasIssues) {
      summary += '✅ *Alle Standorte OK*';
    }

    telegram.sendMessage(msg.chat.id, summary);
  } catch (error) {
    console.error('Błąd w /podglad:', error);
    telegram.sendMessage(msg.chat.id, '❌ Błąd: ' + error.message);
  }
});

// Test wiadomości do kierownika
telegram.onText(/\/test_kierownik (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  const nazwa = match[1];
  if (!locations[nazwa]) {
    telegram.sendMessage(msg.chat.id, '❌ Nieznana lokalizacja: ' + nazwa);
    return;
  }

  const info = locations[nazwa];
  const today = new Date().toISOString().split('T')[0];

  try {
    const query = 'SELECT COUNT(*) as count FROM tours t JOIN locations l ON t.location_id = l.id LEFT JOIN assignments a ON t.tour_number = a.tour_number AND t.location_id = a.location_id AND a.assignment_date = ? WHERE a.id IS NULL AND l.unique_slug = ?';
    const [rows] = await db.query(query, [today, info.slug]);

    if (rows[0].count > 0) {
      const msgText = '⚠️ *TOUR ERINNERUNG*\n\n' +
        `📍 *Standort:* ${nazwa}\n` +
        `📅 *Datum:* ${today}\n\n` +
        `🚨 *Hinweis:*\n` +
        `Heute gibt es *${rows[0].count} Touren*,\n` +
        `die nicht gestartet sind.\n\n` +
        '📋 *Bitte Daten eintragen:*\n' +
        `🔗 https://tour.ltslogistik.de/?location=${info.slug}\n\n` +
        '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n' +
        '_Auto Nachricht_\n\n' +
        '_Falls alles korrekt ist und der Grund bereits der Geschäftsleitung mitgeteilt wurde, bitte ignorieren._';

      await client.sendMessage(info.phone + '@c.us', msgText);
      telegram.sendMessage(msg.chat.id, `✅ Test-Nachricht gesendet an ${nazwa} (${rows[0].count} nieprzypisane Touren)`);
    } else {
      telegram.sendMessage(msg.chat.id, `ℹ️ ${nazwa}: Alle Touren sind zugewiesen - keine Nachricht erforderlich`);
    }
  } catch (error) {
    telegram.sendMessage(msg.chat.id, '❌ Błąd: ' + error.message);
  }
});

// Test podsumowania grupy
telegram.onText(/\/test_grupa/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '📤 *Wysyłam test podsumowania...*');
  await sendDailySummaryToGroup();
});

// Test automatycznych powiadomień kierowników
telegram.onText(/\/test_auto_kierownicy/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🔄 *Test automatycznych powiadomień kierowników...*');
  await checkUnassignedToursAndNotifyManagers();
});

// ==================== KOMENDY PRZEGLADÓW ====================

// Status przegladów
telegram.onText(/\/fleet_status/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🚗 *Fleet Überwachung*\n\n✅ Status: Aktiv\n📅 Automatisch: Jeden Montag 10:00\n📱 Format: Mobile-optimiert');
});

// Test przegladów
telegram.onText(/\/test_fleet/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🔄 *Starte Test*\nPrüfungen werden gesendet...');
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

    let preview = '🚗 *VORSCHAU PRÜFUNGEN*\n\n';
    preview += '📊 *Statistik:*\n';
    preview += `   Fahrzeuge gesamt: *${totalVehicles}*\n`;
    preview += `   Mit überfälligen: *${expiredVehicles}*\n`;
    preview += `   Mit ablaufenden: *${expiringVehicles}*\n\n`;

    if (expiredVehicles > 0) {
      preview += '🚨 *Überfällige (Beispiele):*\n';
      let count = 0;
      for (const [plate, group] of Object.entries(vehicleGroups)) {
        if (count >= 5) break;
        if (group.some(insp => insp.isExpired)) {
          const expiredTypes = group.filter(insp => insp.isExpired).map(insp => insp.typ);
          const maxDays = Math.max(...group.filter(insp => insp.isExpired).map(insp => Math.abs(insp.daysDiff)));
          preview += `🔴 ${plate} (${expiredTypes.join(', ')})\n`;
          preview += `   bis zu ${maxDays} Tage\n\n`;
          count++;
        }
      }
      if (expiredVehicles > 5) preview += `_... und ${(expiredVehicles - 5)} weitere Fahrzeuge_\n`;
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
    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });

    telegram.sendMessage(msg.chat.id,
      '📱 *WHATSAPP STATUS*\n\n' +
      `✅ *Stan:* ${state}\n` +
      `📦 *Wersja:* ${info}\n` +
      `🕒 *Czas:* ${time}`
    );
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

    let groupList = '👥 *GRUPY WHATSAPP*\n\n';
    groups.forEach((group, index) => {
      if (index < 8) {
        groupList += `🔹 *${group.name}*\n`;
        groupList += `   ID: \`${group.id._serialized}\`\n\n`;
      }
    });

    if (groups.length === 0) {
      groupList += '❌ Brak dostępnych grup.';
    } else if (groups.length > 8) {
      groupList += `_... i ${(groups.length - 8)} więcej grup_`;
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
    let columnsInfo = '📋 *TABELA TOURS:*\n\n';
    columns.slice(0, 8).forEach(col => {
      columnsInfo += `• ${col.Field} (${col.Type})\n`;
    });
    if (columns.length > 8) {
      columnsInfo += `... i ${columns.length - 8} więcej\n`;
    }

    const [locations_count] = await db.query('SELECT COUNT(*) as count FROM locations');
    const [tours_count] = await db.query('SELECT COUNT(*) as count FROM tours');

    const summary = `🗄️ *BAZA DANYCH*\n\n✅ *Status:* Połączono\n🚛 *Toury:* ${tours_count[0].count}\n📍 *Lokalizacje:* ${locations_count[0].count}\n\n`;

    telegram.sendMessage(msg.chat.id, summary + columnsInfo);
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
console.log('📅 Harmonogram automatyczny:');
console.log('   • 7:30 (Pon-Pt) - Powiadomienia kierowników');
console.log('   • 10:00 (Poniedziałek) - Raport przegladów');
console.log('   • 10:30 (Pon-Pt) - Podsumowanie tour do grupy');
