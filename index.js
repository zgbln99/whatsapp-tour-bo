// index.js - WhatsApp Universal Bot – Toury + Przeglądy techniczne + Statystyki
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
let locations;
try {
  locations = require('./locations.js');
} catch (err) {
  console.error('❌ Nie udało się załadować locations.js, używam domyślnych lokalizacji');
  locations = {
    Stavenhagen: { slug: 'stavenhagen', phone: '491737008662' },
    Hof: { slug: 'hof', phone: '4915120200738' },
    Radeburg: { slug: 'radeburg', phone: '48668056220' }
  };
}

// Konfiguracja przegladów
const FLEET_INSPECTION_URL = 'https://fleet.ltslogistik.de/inspection.php';
const TOUR_GROUP_ID = '120363419266988965@g.us'; // Grupa dla tour
const FLEET_GROUP_ID = '120363418541056299@g.us'; // Grupa dla przegladów

// Tracking pierwszych przypomnień (resetowany codziennie)
let dailyFirstReminders = new Set();

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
  telegram.sendMessage(TELEGRAM_CHAT_ID, '✅ Universal Bot (Toury + Technische Prüfungen + Statistiken) został uruchomiony!')
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
            '_Erste Erinnerung um 7:30 Uhr_\n\n' +
            '_Falls alles korrekt ist und der Grund bereits der Geschäftsleitung mitgeteilt wurde, bitte ignorieren._';

          await client.sendMessage(info.phone + '@c.us', msgText);
          console.log(`📤 Pierwsze przypomnienie wysłane do kierownika: ${nazwa} (${rows[0].count} nieprzypisanych)`);

          // Zapisz że wysłano pierwsze przypomnienie
          dailyFirstReminders.add(nazwa);

          // Powiadom na Telegram o wysłanej wiadomości
          await telegram.sendMessage(TELEGRAM_CHAT_ID, `📤 1. Erinnerung gesendet: ${nazwa} - ${rows[0].count} nicht zugewiesene Touren`);
        }
      } catch (locError) {
        console.error(`❌ Fehler für Standort ${nazwa}:`, locError);
        await telegram.sendMessage(TELEGRAM_CHAT_ID, `❌ Fehler beim Prüfen von Standort ${nazwa}: ${locError.message}`);
      }
    }

    // Podsumowanie na Telegram
    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    await telegram.sendMessage(TELEGRAM_CHAT_ID, `✅ 1. Prüfung nicht zugewiesener Touren abgeschlossen um ${time}`);

  } catch (error) {
    console.error('❌ Fehler bei automatischer Tour-Prüfung:', error);
    await telegram.sendMessage(TELEGRAM_CHAT_ID, `❌ Fehler bei automatischer Tour-Prüfung: ${error.message}`);
  }
}

// NOWA FUNKCJA: Drugie przypomnienie o 10:00
async function checkUnassignedToursSecondReminder() {
  const today = new Date().toISOString().split('T')[0];

  try {
    for (const nazwa in locations) {
      const info = locations[nazwa];

      try {
        // Sprawdź nieprzypisane toury dla tej lokalizacji
        const query = 'SELECT COUNT(*) as count FROM tours t JOIN locations l ON t.location_id = l.id LEFT JOIN assignments a ON t.tour_number = a.tour_number AND t.location_id = a.location_id AND a.assignment_date = ? WHERE a.id IS NULL AND l.unique_slug = ?';
        const [rows] = await db.query(query, [today, info.slug]);

        if (rows[0].count > 0) {
          // Sprawdź czy było pierwsze przypomnienie
          const wasFirstReminder = dailyFirstReminders.has(nazwa);

          const msgText = '🚨 *DRINGENDE TOUR ERINNERUNG*\n\n' +
            `📍 *Standort:* ${nazwa}\n` +
            `📅 *Datum:* ${today}\n\n` +
            `🔥 *WICHTIG:*\n` +
            `Es gibt immer noch *${rows[0].count} Touren*,\n` +
            `die nicht zugewiesen sind!\n\n` +
            (wasFirstReminder ? '⏰ *Dies ist die ZWEITE Erinnerung!*\n\n' : '⏰ *Dringende Erinnerung!*\n\n') +
            '📋 *Bitte sofort Daten eintragen:*\n' +
            `🔗 https://tour.ltsog.de/?location=${info.slug}\n\n` +
            '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n' +
            (wasFirstReminder ? '_Zweite Erinnerung um 10:00 Uhr_\n' : '_Dringende Erinnerung um 10:00 Uhr_\n') +
            '_Gruppenbericht folgt um 10:30 Uhr_\n\n' +
            '_Bitte umgehend handeln!_';

          await client.sendMessage(info.phone + '@c.us', msgText);
          console.log(`📤 Drugie przypomnienie wysłane do kierownika: ${nazwa} (${rows[0].count} nieprzypisanych)`);

          // Powiadom na Telegram o wysłanej wiadomości
          const reminderType = wasFirstReminder ? '2. Erinnerung' : 'Dringende Erinnerung';
          await telegram.sendMessage(TELEGRAM_CHAT_ID, `🚨 ${reminderType} gesendet: ${nazwa} - ${rows[0].count} nicht zugewiesene Touren`);
        }
      } catch (locError) {
        console.error(`❌ Fehler für Standort ${nazwa}:`, locError);
        await telegram.sendMessage(TELEGRAM_CHAT_ID, `❌ Fehler beim zweiten Prüfen von Standort ${nazwa}: ${locError.message}`);
      }
    }

    // Podsumowanie na Telegram
    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    await telegram.sendMessage(TELEGRAM_CHAT_ID, `✅ 2. Prüfung (dringende Erinnerung) abgeschlossen um ${time}`);

  } catch (error) {
    console.error('❌ Fehler bei zweiter Tour-Prüfung:', error);
    await telegram.sendMessage(TELEGRAM_CHAT_ID, `❌ Fehler bei zweiter Tour-Prüfung: ${error.message}`);
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
    let secondRemindersCount = 0;

    for (const name in locations) {
      const info = locations[name];

      try {
        const queryAllTours = 'SELECT COUNT(*) AS count FROM tours t JOIN locations l ON t.location_id = l.id WHERE l.unique_slug = ?';
        const [allTours] = await db.query(queryAllTours, [info.slug]);

        const queryAssigned = 'SELECT COUNT(*) AS count FROM assignments a JOIN tours t ON a.tour_number = t.tour_number JOIN locations l ON t.location_id = l.id WHERE l.unique_slug = ? AND a.assignment_date = ?';
        const [assignedTours] = await db.query(queryAssigned, [info.slug, today]);

        // Pobierz numery nieprzypisanych tour
        const queryUnassignedTours = `
          SELECT t.tour_number
          FROM tours t
          JOIN locations l ON t.location_id = l.id
          LEFT JOIN assignments a ON t.tour_number = a.tour_number
            AND t.location_id = a.location_id
            AND a.assignment_date = ?
          WHERE a.id IS NULL AND l.unique_slug = ?
          ORDER BY t.tour_number
        `;
        const [unassignedTours] = await db.query(queryUnassignedTours, [today, info.slug]);

        const total = allTours[0].count;
        const assigned = assignedTours[0].count;
        const notAssigned = total - assigned;

        if (notAssigned > 0) {
          totalIssues += notAssigned;
          // Sprawdź czy było pierwsze przypomnienie (oznacza że potrzebne było drugie)
          if (dailyFirstReminders.has(name)) {
            secondRemindersCount++;
          }
        }

        const status = notAssigned > 0 ? '🔴' : '🟢';
        const reminderNote = notAssigned > 0 && dailyFirstReminders.has(name) ? ' ⚠️' : '';

        text += `${status} *${name}*${reminderNote}\n`;
        text += `   Zugewiesen: *${assigned}*\n`;
        text += `   Nicht zugewiesen: *${notAssigned}*\n`;

        // Dodaj numery nieprzypisanych tour
        if (notAssigned > 0) {
          const tourNumbers = unassignedTours.map(tour => tour.tour_number).join(', ');
          text += `   _Touren: ${tourNumbers}_\n`;
        }

        if (notAssigned > 0 && dailyFirstReminders.has(name)) {
          text += `   _Zwei Erinnerungen gesendet_\n`;
        }
        text += '\n';
      } catch (locError) {
        console.error('Błąd dla lokalizacji', name + ':', locError);
        text += `🔴 *${name}*\n`;
        text += '   _Fehler beim Abrufen_\n\n';
      }
    }

    text += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n';
    if (secondRemindersCount > 0) {
      text += `🚨 *${secondRemindersCount} Standorte* benötigten 2 Erinnerungen!\n\n`;
    }
    text += '_Automatische Nachricht um 10:30 Uhr_\n';
    text += '_Manager wurden entsprechend informiert_';

    // Wyślij do grupy WhatsApp
    await client.sendMessage(TOUR_GROUP_ID, text);

    // Reset trackerów o północy następnego dnia
    setTimeout(() => {
      dailyFirstReminders.clear();
    }, 24 * 60 * 60 * 1000 - (Date.now() % (24 * 60 * 60 * 1000)));

    // Powiadom na Telegram o wysłaniu
    const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    const summary = totalIssues > 0 ?
      `📤 Tour-Zusammenfassung gesendet um ${time}. Problem: ${totalIssues} nicht zugewiesen. ${secondRemindersCount} Standorte benötigten 2 Erinnerungen.` :
      `📤 Tour-Zusammenfassung gesendet um ${time}. Alles OK! ✅`;

    await telegram.sendMessage(TELEGRAM_CHAT_ID, summary);
    console.log('📤 Tägliche Tour-Zusammenfassung an WhatsApp-Gruppe gesendet');

  } catch (error) {
    console.error('❌ Fehler beim Senden der täglichen Zusammenfassung:', error);
    await telegram.sendMessage(TELEGRAM_CHAT_ID, `❌ Fehler bei täglicher Tour-Zusammenfassung: ${error.message}`);
  }
}

// ==================== FUNKCJE STATYSTYK ====================

// Funkcja generowania statystyk tour
async function generateTourStatistics(period = 'week') {
  const today = new Date();
  let startDate, endDate;

  if (period === 'week') {
    // Ostatni tydzień
    startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    endDate = today;
  } else if (period === 'month') {
    // Ostatni miesiąc
    startDate = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
    endDate = today;
  }

  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  try {
    let stats = `📊 *TOUR STATISTIKEN*\n\n`;
    stats += `📅 *Zeitraum:* ${period === 'week' ? 'Letzte 7 Tage' : 'Letzter Monat'}\n`;
    stats += `📊 *Von:* ${startDate.toLocaleDateString('de-DE')}\n`;
    stats += `📊 *Bis:* ${endDate.toLocaleDateString('de-DE')}\n\n`;
    stats += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n\n';

    for (const name in locations) {
      const info = locations[name];

      try {
        // Pobierz wszystkie toury dla lokalizacji
        const queryTotalTours = `
          SELECT COUNT(*) as total_days
          FROM (
            SELECT DISTINCT DATE(a.assignment_date) as tour_date
            FROM assignments a
            JOIN tours t ON a.tour_number = t.tour_number
            JOIN locations l ON t.location_id = l.id
            WHERE l.unique_slug = ? AND a.assignment_date BETWEEN ? AND ?
          ) as distinct_days
        `;

        // Pobierz dni z przypisanymi wszystkimi turami
        const queryCompleteDays = `
          SELECT COUNT(*) as complete_days
          FROM (
            SELECT a.assignment_date,
                   COUNT(DISTINCT a.tour_number) as assigned_tours,
                   (SELECT COUNT(*) FROM tours t2 JOIN locations l2 ON t2.location_id = l2.id WHERE l2.unique_slug = ?) as total_tours
            FROM assignments a
            JOIN tours t ON a.tour_number = t.tour_number
            JOIN locations l ON t.location_id = l.id
            WHERE l.unique_slug = ? AND a.assignment_date BETWEEN ? AND ?
            GROUP BY a.assignment_date
            HAVING assigned_tours = total_tours
          ) as complete_day_stats
        `;

        // Pobierz dni z problemami (nie wszystkie toury przypisane)
        const queryProblemDays = `
          SELECT COUNT(*) as problem_days
          FROM (
            SELECT a.assignment_date,
                   COUNT(DISTINCT a.tour_number) as assigned_tours,
                   (SELECT COUNT(*) FROM tours t2 JOIN locations l2 ON t2.location_id = l2.id WHERE l2.unique_slug = ?) as total_tours
            FROM assignments a
            JOIN tours t ON a.tour_number = t.tour_number
            JOIN locations l ON t.location_id = l.id
            WHERE l.unique_slug = ? AND a.assignment_date BETWEEN ? AND ?
            GROUP BY a.assignment_date
            HAVING assigned_tours < total_tours
          ) as problem_day_stats
        `;

        const [totalResult] = await db.query(queryTotalTours, [info.slug, startDateStr, endDateStr]);
        const [completeResult] = await db.query(queryCompleteDays, [info.slug, info.slug, startDateStr, endDateStr]);
        const [problemResult] = await db.query(queryProblemDays, [info.slug, info.slug, startDateStr, endDateStr]);

        const totalDays = totalResult[0].total_days || 0;
        const completeDays = completeResult[0].complete_days || 0;
        const problemDays = problemResult[0].problem_days || 0;
        const successRate = totalDays > 0 ? Math.round((completeDays / totalDays) * 100) : 0;

        const statusIcon = successRate >= 90 ? '🟢' : successRate >= 70 ? '🟡' : '🔴';

        stats += `${statusIcon} *${name}*\n`;
        stats += `   Arbeitstage: *${totalDays}*\n`;
        stats += `   Vollständig: *${completeDays}*\n`;
        stats += `   Mit Problemen: *${problemDays}*\n`;
        stats += `   Erfolgsrate: *${successRate}%*\n\n`;

      } catch (locError) {
        console.error(`Błąd statystyk dla ${name}:`, locError);
        stats += `🔴 *${name}*\n`;
        stats += `   _Fehler beim Berechnen_\n\n`;
      }
    }

    stats += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n';
    stats += '📈 *Legende:*\n';
    stats += '🟢 Erfolgsrate ≥ 90%\n';
    stats += '🟡 Erfolgsrate 70-89%\n';
    stats += '🔴 Erfolgsrate < 70%\n';

    return stats;

  } catch (error) {
    console.error('Błąd generowania statystyk tour:', error);
    throw error;
  }
}

// Funkcja generowania statystyk przegladów
async function generateInspectionStatistics() {
  try {
    const inspections = await fetchAllInspectionData();

    if (inspections.length === 0) {
      return '📊 *PRÜFUNGSSTATISTIKEN*\n\n❌ Keine Daten verfügbar';
    }

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
    const expiring30Vehicles = Object.values(vehicleGroups).filter(group =>
      group.some(insp => insp.isExpiringSoon) && !group.some(insp => insp.isExpired)
    ).length;
    const okVehicles = totalVehicles - expiredVehicles - expiring30Vehicles;

    // Znajdź najgorzej punktowane pojazdy
    const worstVehicles = Object.entries(vehicleGroups)
      .filter(([plate, group]) => group.some(insp => insp.isExpired))
      .map(([plate, group]) => {
        const maxOverdue = Math.max(...group.filter(insp => insp.isExpired).map(insp => Math.abs(insp.daysDiff)));
        const expiredTypes = group.filter(insp => insp.isExpired).map(insp => insp.typ);
        return { plate, maxOverdue, types: expiredTypes };
      })
      .sort((a, b) => b.maxOverdue - a.maxOverdue)
      .slice(0, 5);

    // Statystyki typów przegladów
    const typeStats = {};
    inspections.forEach(insp => {
      if (!typeStats[insp.typ]) {
        typeStats[insp.typ] = { total: 0, expired: 0, expiring: 0 };
      }
      typeStats[insp.typ].total++;
      if (insp.isExpired) typeStats[insp.typ].expired++;
      if (insp.isExpiringSoon) typeStats[insp.typ].expiring++;
    });

    let stats = '📊 *PRÜFUNGSSTATISTIKEN*\n\n';
    stats += `📅 *Stand:* ${new Date().toLocaleDateString('de-DE')}\n\n`;
    stats += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n\n';

    // Gesamtstatistik
    stats += '📈 *ÜBERSICHT*\n';
    stats += `🚗 Fahrzeuge gesamt: *${totalVehicles}*\n`;
    stats += `🔴 Mit überfälligen: *${expiredVehicles}* (${Math.round((expiredVehicles/totalVehicles)*100)}%)\n`;
    stats += `🟡 Mit ablaufenden: *${expiring30Vehicles}* (${Math.round((expiring30Vehicles/totalVehicles)*100)}%)\n`;
    stats += `🟢 Alles aktuell: *${okVehicles}* (${Math.round((okVehicles/totalVehicles)*100)}%)\n\n`;

    // Schlimmste Fälle
    if (worstVehicles.length > 0) {
      stats += '🚨 *KRITISCHSTE FAHRZEUGE*\n';
      worstVehicles.forEach((vehicle, index) => {
        stats += `${index + 1}. *${vehicle.plate}*\n`;
        stats += `   ${vehicle.maxOverdue} Tage überfällig\n`;
        stats += `   Typen: ${vehicle.types.join(', ')}\n\n`;
      });
    }

    // Statistik nach Prüfungstyp
    stats += '📋 *NACH PRÜFUNGSTYP*\n';
    Object.entries(typeStats).forEach(([type, data]) => {
      const expiredRate = Math.round((data.expired / data.total) * 100);
      const statusIcon = expiredRate === 0 ? '🟢' : expiredRate < 20 ? '🟡' : '🔴';
      stats += `${statusIcon} *${type}*\n`;
      stats += `   Gesamt: ${data.total}\n`;
      stats += `   Überfällig: ${data.expired} (${expiredRate}%)\n`;
      stats += `   Ablaufend: ${data.expiring}\n\n`;
    });

    stats += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n';
    stats += '🔗 https://fleet.ltslogistik.de/';

    return stats;

  } catch (error) {
    console.error('Błąd generowania statystyk przegladów:', error);
    throw error;
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
  console.log('📋 Sprawdzam nieprzypisane toury i wysyłam pierwsze powiadomienia kierownikom...');
  await checkUnassignedToursAndNotifyManagers();
}, {
  timezone: "Europe/Berlin"
});

// 3. NOWE: Drugie przypomnienie - poniedziałek-piątek o 10:00
cron.schedule('0 10 * * 1-5', async () => {
  console.log('🚨 Sprawdzam nieprzypisane toury i wysyłam drugie przypomnienia kierownikom...');
  await checkUnassignedToursSecondReminder();
}, {
  timezone: "Europe/Berlin"
});

// 4. Podsumowanie tour do grupy WhatsApp - poniedziałek-piątek o 10:30
cron.schedule('30 10 * * 1-5', async () => {
  console.log('📊 Wysyłam podsumowanie tour do grupy WhatsApp...');
  await sendDailySummaryToGroup();
}, {
  timezone: "Europe/Berlin"
});

// Reset trackerów o północy
cron.schedule('0 0 * * *', () => {
  console.log('🔄 Resetuję tracker pierwszych przypomnień...');
  dailyFirstReminders.clear();
}, {
  timezone: "Europe/Berlin"
});

// ==================== KOMENDY TELEGRAM ====================

// Basic status
telegram.onText(/\/status/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🤖 *UNIVERSAL BOT*\n\n✅ *Status:* Aktiv\n🚛 *Toury:* Bereit\n🚗 *Prüfungen:* Bereit\n📊 *Statistiken:* Bereit\n📱 *WhatsApp:* Verbunden');
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
  schedule += '   📋 1. Sprawdzenie nieprzypisanych tour\n';
  schedule += '   📤 Pierwsze powiadomienia kierowników\n\n';
  schedule += '🔸 *10:00* (Pon-Pt)\n';
  schedule += '   🚨 2. Sprawdzenie nieprzypisanych tour\n';
  schedule += '   📤 Drugie (dringende) powiadomienia\n\n';
  schedule += '🔸 *10:00* (Poniedziałek)\n';
  schedule += '   🚗 Raport przegladów technicznych\n\n';
  schedule += '🔸 *10:30* (Pon-Pt)\n';
  schedule += '   📊 Podsumowanie tour do grupy\n\n';
  schedule += '🔸 *0:00* (Codziennie)\n';
  schedule += '   🔄 Reset trackerów przypomnień\n\n';
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

      // Pobierz numery nieprzypisanych tour
      const queryUnassignedNumbers = `
        SELECT t.tour_number
        FROM tours t
        JOIN locations l ON t.location_id = l.id
        LEFT JOIN assignments a ON t.tour_number = a.tour_number
          AND t.location_id = a.location_id
          AND a.assignment_date = ?
        WHERE a.id IS NULL AND l.unique_slug = ?
        ORDER BY t.tour_number
      `;
      const [unassignedNumbers] = await db.query(queryUnassignedNumbers, [today, info.slug]);

      const wasFirstReminder = dailyFirstReminders.has(name);
      const reminderInfo = wasFirstReminder ? ' (2 Erinnerungen)' : '';

      if (rows[0].count > 0) {
        const tourNumbers = unassignedNumbers.map(tour => tour.tour_number).join(', ');
        summary += `🔴 *${name}*${reminderInfo}\n`;
        summary += `   ${rows[0].count} nicht zugewiesen\n`;
        summary += `   _Touren: ${tourNumbers}_\n\n`;
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
      const msgText = '⚠️ *TOUR ERINNERUNG - TEST*\n\n' +
        `📍 *Standort:* ${nazwa}\n` +
        `📅 *Datum:* ${today}\n\n` +
        `🚨 *Hinweis:*\n` +
        `Heute gibt es *${rows[0].count} Touren*,\n` +
        `die nicht gestartet sind.\n\n` +
        '📋 *Bitte Daten eintragen:*\n' +
        `🔗 https://tour.ltslogistik.de/?location=${info.slug}\n\n` +
        '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n' +
        '_TEST Nachricht_\n\n' +
        '_Falls alles korrekt ist, bitte ignorieren._';

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

// NOWE: Test drugiego przypomnienia
telegram.onText(/\/test_drugie_przypomnienie/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🚨 *Test drugiego przypomnienia...*');
  await checkUnassignedToursSecondReminder();
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

// ==================== NOWE KOMENDY STATYSTYK ====================

// Statystyki tour - tydzień
telegram.onText(/\/stats_tour/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  try {
    telegram.sendMessage(msg.chat.id, '📊 *Generuję statystyki tour...*');
    const stats = await generateTourStatistics('week');
    telegram.sendMessage(msg.chat.id, stats);
  } catch (error) {
    telegram.sendMessage(msg.chat.id, '❌ Błąd statystyk tour: ' + error.message);
  }
});

// Statystyki tour - miesiąc
telegram.onText(/\/stats_tour_miesiac/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  try {
    telegram.sendMessage(msg.chat.id, '📊 *Generuję miesięczne statystyki tour...*');
    const stats = await generateTourStatistics('month');
    telegram.sendMessage(msg.chat.id, stats);
  } catch (error) {
    telegram.sendMessage(msg.chat.id, '❌ Błąd miesięcznych statystyk tour: ' + error.message);
  }
});

// Statystyki przegladów
telegram.onText(/\/stats_fleet/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  try {
    telegram.sendMessage(msg.chat.id, '📊 *Generuję statystyki przegladów...*');
    const stats = await generateInspectionStatistics();
    telegram.sendMessage(msg.chat.id, stats);
  } catch (error) {
    telegram.sendMessage(msg.chat.id, '❌ Błąd statystyk przegladów: ' + error.message);
  }
});

// Pełny raport miesięczny
telegram.onText(/\/raport_miesiec/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  try {
    telegram.sendMessage(msg.chat.id, '📊 *Generuję pełny miesięczny raport...*');

    const tourStats = await generateTourStatistics('month');
    const fleetStats = await generateInspectionStatistics();
    const currentTime = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });

    const fullReport = `🗂️ *MIESIĘCZNY RAPORT KOMPLETNY*\n\n📅 *Wygenerowano:* ${currentTime}\n\n` +
                      `${tourStats}\n\n⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️\n\n` +
                      `${fleetStats}`;

    telegram.sendMessage(msg.chat.id, fullReport);
  } catch (error) {
    telegram.sendMessage(msg.chat.id, '❌ Błąd pełnego raportu: ' + error.message);
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

// Lista wszystkich komend
telegram.onText(/\/pomoc/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  const help = `🤖 *LISTA KOMEND*\n\n` +
    `*PODSTAWOWE:*\n` +
    `/status - Status bota\n` +
    `/czas - Czas serwera\n` +
    `/harmonogram - Harmonogram zadań\n` +
    `/pomoc - Lista komend\n\n` +
    `*TOUR:*\n` +
    `/podglad - Podgląd nieprzypisanych\n` +
    `/test_kierownik [nazwa] - Test wiadomości\n` +
    `/test_grupa - Test podsumowania\n` +
    `/test_auto_kierownicy - Test 1. przypomnienia\n` +
    `/test_drugie_przypomnienie - Test 2. przypomnienia\n\n` +
    `*FLEET/PRZEGLĄDY:*\n` +
    `/fleet_status - Status fleet\n` +
    `/fleet_preview - Podgląd przegladów\n` +
    `/test_fleet - Test raportu\n\n` +
    `*STATYSTYKI:*\n` +
    `/stats_tour - Statystyki tour (tydzień)\n` +
    `/stats_tour_miesiac - Statystyki tour (miesiąc)\n` +
    `/stats_fleet - Statystyki przegladów\n` +
    `/raport_miesiec - Pełny raport miesięczny\n\n` +
    `*LOKALIZACJE:*\n` +
    `/lista - Lista lokalizacji\n` +
    `/dodaj [nazwa,slug,telefon] - Dodaj\n` +
    `/zmien [nazwa,telefon] - Zmień telefon\n` +
    `/usun [nazwa] - Usuń lokalizację\n\n` +
    `*DIAGNOSTYKA:*\n` +
    `/whatsapp_status - Status WhatsApp\n` +
    `/grupy - Lista grup WhatsApp\n` +
    `/test_db - Test bazy danych\n` +
    `/logi - Ścieżka logów\n` +
    `/restart - Restart bota`;

  telegram.sendMessage(msg.chat.id, help);
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
console.log('📋 Funkcje: Toury + Technische Prüfungen + Statystyki');
console.log('📅 Harmonogram automatyczny:');
console.log('   • 7:30 (Pon-Pt) - Pierwsze powiadomienia kierowników');
console.log('   • 10:00 (Pon-Pt) - Drugie przypomnienia kierowników');
console.log('   • 10:00 (Poniedziałek) - Raport przegladów');
console.log('   • 10:30 (Pon-Pt) - Podsumowanie tour do grupy (z numerami tour)');
console.log('   • 0:00 (Codziennie) - Reset trackerów');
console.log('📊 Nowe funkcje statystyk dostępne przez Telegram!');
console.log('🔢 Numery nieprzypisanych tour w raportach grupowych!');
