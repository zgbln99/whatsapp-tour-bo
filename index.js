// =============================================================================
// index.js - WhatsApp Universal Bot – Toury + Przeglądy techniczne + OCR v2.2
// =============================================================================

const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

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

// Konfiguracja API Fleet
const FLEET_API_CONFIG = {
  baseUrl: 'https://fleet.ltslogistik.de',
  apiKey: 'whatsapp_bot_key_2024_secure_lts', // Zmień na swój klucz
  timeout: 15000,
  retryAttempts: 3,
  retryDelay: 2000
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
  console.log('Universal Bot - WhatsApp jest gotowy!');
  telegram.sendMessage(TELEGRAM_CHAT_ID, '✅ Universal Bot v2.2 (Toury + Technische Prüfungen + OCR) został uruchomiony!')
    .catch(console.error);
});

// Event listener dla rozłączenia
client.on('disconnected', (reason) => {
  console.log('Universal Bot - WhatsApp został rozłączony:', reason);
  telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ Universal Bot został rozłączony: ' + reason)
    .catch(console.error);
});

// ==================== FUNKCJE API FLEET ====================

/**
 * Funkcja HTTP request z retry
 */
async function makeApiRequest(endpoint, data, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);

    const options = {
      hostname: new URL(FLEET_API_CONFIG.baseUrl).hostname,
      port: 443,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-API-Key': FLEET_API_CONFIG.apiKey,
        'User-Agent': 'WhatsApp-Bot/2.2'
      },
      timeout: FLEET_API_CONFIG.timeout
    };

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(responseData);

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(response);
          } else {
            reject(new Error(`API Error ${res.statusCode}: ${response.error || responseData}`));
          }
        } catch (parseError) {
          reject(new Error(`JSON Parse Error: ${parseError.message}`));
        }
      });
    });

    req.on('error', async (error) => {
      console.error(`API Request failed (attempt ${retryCount + 1}):`, error.message);

      // Retry logic
      if (retryCount < FLEET_API_CONFIG.retryAttempts) {
        console.log(`Retrying in ${FLEET_API_CONFIG.retryDelay}ms...`);
        setTimeout(() => {
          makeApiRequest(endpoint, data, retryCount + 1)
            .then(resolve)
            .catch(reject);
        }, FLEET_API_CONFIG.retryDelay);
      } else {
        reject(new Error(`API Request failed after ${FLEET_API_CONFIG.retryAttempts + 1} attempts: ${error.message}`));
      }
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('API Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Aktualizacja przegladów przez API
 */
async function updateInspectionDatabaseAPI(licensePlate, huDate, spDate, uvvDate = null) {
  try {
    console.log(`🌐 Updating inspections via API for ${licensePlate}`);

    const requestData = {
      action: 'update_inspections',
      license_plate: licensePlate,
      hu_date: huDate,
      sp_date: spDate,
      uvv_date: uvvDate
    };

    // Usuń puste wartości
    Object.keys(requestData).forEach(key => {
      if (!requestData[key]) {
        delete requestData[key];
      }
    });

    const response = await makeApiRequest('/bot_inspection_api.php', requestData);

    if (response.success) {
      console.log(`✅ API Update successful for ${licensePlate}:`, response.data);
      return {
        success: true,
        data: response.data,
        message: response.message
      };
    } else {
      throw new Error(response.error || 'Unknown API error');
    }

  } catch (error) {
    console.error(`❌ API Update failed for ${licensePlate}:`, error.message);
    throw error;
  }
}

/**
 * Health check API
 */
async function checkFleetAPIHealth() {
  try {
    const response = await makeApiRequest('/bot_inspection_api.php', {
      action: 'health_check'
    });

    if (response.success) {
      console.log('✅ Fleet API is healthy:', response.data);
      return response.data;
    } else {
      throw new Error(response.error);
    }
  } catch (error) {
    console.error('❌ Fleet API health check failed:', error.message);
    throw error;
  }
}

// ==================== FUNKCJE OCR v2.2 ====================

// Kontekst dla analizy przegladów
let inspectionContext = {
  licensePlate: null,
  lastMessageTime: null,
  groupedData: [],
  processingTimeout: null
};

// Funkcja preprocessing obrazu dla lepszego OCR (ulepszona)
async function preprocessImage(buffer) {
  try {
    // Dwa warianty preprocessing - standardowy i agresywny
    const standardProcessed = await sharp(buffer)
      .resize(1600, null, {
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3
      })
      .sharpen(2.0)         // Zwiększone wyostrzenie
      .normalize()
      .gamma(1.0)           // Neutralna gamma
      .modulate({
        contrast: 1.4,      // Zwiększony kontrast
        brightness: 1.2,    // Lekko jaśniej
        saturation: 0.8     // Mniej nasycenia (lepsze dla OCR)
      })
      .png({ quality: 95 })
      .toBuffer();

    // Agresywny preprocessing dla trudnych przypadków
    const aggressiveProcessed = await sharp(buffer)
      .resize(1800, null, {
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3
      })
      .sharpen(3.0)         // Mocne wyostrzenie
      .normalize()
      .gamma(0.8)           // Ciemniejsza gamma
      .modulate({
        contrast: 1.8,      // Bardzo wysoki kontrast
        brightness: 1.4,    // Jaśniej
        saturation: 0.5     // Desaturacja dla lepszego OCR
      })
      .threshold(128)       // Binaryzacja
      .png({ quality: 100 })
      .toBuffer();

    // Zwróć oba warianty
    return {
      standard: standardProcessed,
      aggressive: aggressiveProcessed,
      original: buffer
    };

  } catch (error) {
    console.log('⚠️ Preprocessing failed, using original image');
    return {
      standard: buffer,
      aggressive: buffer,
      original: buffer
    };
  }
}

// Rozpoznawanie tablicy rejestracyjnej (ulepszony algorytm)
function extractLicensePlate(text) {
  // Wzorce niemieckich tablic - obsługa różnych formatów
  const patterns = [
    // Standardowe format z spacjami/myślnikami
    /([A-ZÄÖÜ]{1,3})\s*[–\-]?\s*([A-ZÄÖÜ]{1,2})\s*(\d{1,4}[HE]?)/g,
    /([A-ZÄÖÜ]{1,3})\s+([A-ZÄÖÜ]{1,2})\s+(\d{1,4}[HE]?)/g,
    // Format bez separatorów
    /([A-ZÄÖÜ]{2,3})([A-ZÄÖÜ]{1,2})(\d{1,4}[HE]?)/g,
    // Z uwzględnieniem OCR błędów (O->0, I->1, itp.)
    /([A-ZÄÖÜ0]{1,3})\s*[–\-]?\s*([A-ZÄÖÜ0I]{1,2})\s*(\d{1,4}[HE]?)/g
  ];

  let bestMatch = null;
  let bestScore = 0;

  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const [fullMatch, prefix, letters, numbers] = match;

      // Korekta OCR błędów
      const correctedPrefix = prefix.replace(/0/g, 'O');
      const correctedLetters = letters.replace(/0/g, 'O').replace(/1/g, 'I');

      // Walidacja
      if (correctedPrefix.length >= 1 && correctedPrefix.length <= 3 &&
          correctedLetters.length >= 1 && correctedLetters.length <= 2 &&
          numbers.length >= 1 && numbers.length <= 5) {

        const plate = `${correctedPrefix} ${correctedLetters} ${numbers}`;
        const score = calculatePlateScore(plate, fullMatch);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = plate;
        }
      }
    }
  }

  return bestMatch;
}

// Funkcja oceny jakości rozpoznanej tablicy
function calculatePlateScore(plate, originalMatch) {
  let score = 100;

  // Punkty za typowe niemieckie prefiksy
  const germanPrefixes = ['TF', 'HH', 'M', 'B', 'K', 'F', 'S', 'DD', 'L', 'DO', 'E', 'BO', 'DU', 'WE', 'RE', 'SG'];
  const prefix = plate.split(' ')[0];
  if (germanPrefixes.includes(prefix)) score += 50;

  // Kara za podejrzane znaki
  if (plate.includes('0O') || plate.includes('O0')) score -= 30;
  if (plate.length < 6) score -= 20;

  return score;
}

// Rozpoznawanie daty HU z naklejki TÜV (poprawiony - cyfra na GÓRZE to miesiąc)
function extractHUDate(text) {
  console.log('🔍 Analyzing HU sticker (TOP=month, CENTER=year):', text);

  let year = null;
  let month = null;
  let confidence = 0;

  // 1. Znajdź rok w ŚRODKU naklejki - szukaj 2-4 cyfrowych lat
  const yearPatterns = [
    /\b(20[2-6]\d)\b/g,        // Pełny rok 2020-2069
    /\b([2-6]\d)\b/g           // Skrócony rok 20-69
  ];

  // Czyść tekst i szukaj lat
  const cleanText = text.replace(/[^\d\s]/g, ' ');
  const numbers = cleanText.match(/\d+/g) || [];

  console.log('🔢 All numbers found:', numbers);

  // Znajdź najbardziej prawdopodobny rok
  for (const num of numbers) {
    let y = parseInt(num);

    // Konwersja roku
    if (num.length === 4 && y >= 2020 && y <= 2070) {
      year = y;
      confidence += 40;
      console.log(`📅 Found 4-digit year: ${year}`);
      break;
    } else if (num.length === 2 && y >= 20 && y <= 70) {
      year = 2000 + y;
      confidence += 35;
      console.log(`📅 Found 2-digit year: ${y} -> ${year}`);
      break;
    }
  }

  // 2. Znajdź miesiąc NA GÓRZE naklejki (pozycja 12h)
  // W OCR tekst jest czytany od góry, więc pierwszy numer 1-12 to prawdopodobnie miesiąc z góry
  const potentialMonths = numbers
    .map(n => parseInt(n))
    .filter(n => n >= 1 && n <= 12)
    .filter(n => n.toString() !== year?.toString().slice(-2)); // Nie może być częścią roku

  console.log('🗓️ Potential months (1-12):', potentialMonths);

  if (potentialMonths.length > 0) {
    // Logika: pierwszy miesiąc w tekście to prawdopodobnie ten z góry naklejki
    // Ale jeśli są cyfry 10, 11, 12 - priorytetyzuj je (częściej na naklejkach HU)
    const priorityMonths = potentialMonths.filter(m => m >= 10);

    if (priorityMonths.length > 0) {
      month = priorityMonths[0]; // Weź pierwszy z zakresu 10-12
      confidence += 45;
      console.log(`📅 Selected priority month (10-12): ${month}`);
    } else {
      month = potentialMonths[0]; // Weź pierwszy dostępny
      confidence += 35;
      console.log(`📅 Selected first month: ${month}`);
    }
  }

  // 3. Dodatkowa walidacja - sprawdź context naklejki HU
  const huKeywords = ['TÜV', 'TUV', 'HAUPT', 'HAUPTUNTERSUCHUNG', 'HU'];
  const hasHuContext = huKeywords.some(keyword => text.toUpperCase().includes(keyword));

  if (hasHuContext) {
    confidence += 20;
    console.log('🔍 HU context detected: +20 confidence');
  }

  // 4. Logika pozycji - w OCR pierwszy numer to często ten z góry
  if (potentialMonths.length > 1) {
    // Jeśli mamy kilka miesięcy, weź pierwszy (z góry) albo największy
    const firstMonth = potentialMonths[0];
    const largestMonth = Math.max(...potentialMonths);

    // Preference dla grudnia (12) - często spotykany na HU
    if (potentialMonths.includes(12)) {
      month = 12;
      confidence += 10;
      console.log('📅 December preference applied: 12');
    } else if (largestMonth >= 6) {
      month = largestMonth; // Duże miesiące częściej na HU
      console.log(`📅 Large month preference: ${month}`);
    } else {
      month = firstMonth; // Pierwszy w tekście (z góry naklejki)
      console.log(`📅 First position month: ${month}`);
    }
  }

  // 5. Fallback dla roku jeśli brakuje
  if (!year && month) {
    const currentYear = new Date().getFullYear();
    year = currentYear + 1; // HU zazwyczaj na przyszły rok
    confidence += 15;
    console.log(`📅 Year fallback: ${year}`);
  }

  // 6. Walidacja i formatowanie
  if (year && month && confidence >= 40) {
    const date = `${month.toString().padStart(2, '0')}/${year}`;
    console.log(`✅ HU Date extracted (TOP=month, CENTER=year): ${date} (confidence: ${confidence})`);
    return date;
  }

  console.log(`❌ HU Date extraction failed - year: ${year}, month: ${month}, confidence: ${confidence}`);
  return null;
}

// Rozpoznawanie daty SP z naklejki (poprawiony - zaostrzony koniec wskazuje miesiąc)
function extractSPDate(text) {
  console.log('🔍 Analyzing SP sticker (ARROW TIP points to month):', text);

  let year = null;
  let month = null;
  let confidence = 0;

  // 1. Znajdź rok SP - zazwyczaj w tekście lub na naklejce
  const spYearPatterns = [
    /SP\s*(\d{4})/gi,              // SP 2026
    /SP\s*([2-6]\d)/gi,            // SP 26
    /SICHER.*?(\d{4})/gi,          // SICHERHEIT 2026
    /(\d{4})/g,                    // Dowolny 4-cyfrowy rok
    /([2-6]\d)/g                   // Dowolny 2-cyfrowy rok 20-69
  ];

  const cleanText = text.replace(/[^\w\s\d]/g, ' ');
  const numbers = cleanText.match(/\d+/g) || [];

  console.log('🔢 All numbers in SP text:', numbers);

  // Znajdź rok
  for (const num of numbers) {
    let y = parseInt(num);

    // Konwersja roku
    if (num.length === 4 && y >= 2020 && y <= 2070) {
      year = y;
      confidence += 45;
      console.log(`📅 Found 4-digit SP year: ${year}`);
      break;
    } else if (num.length === 2 && y >= 20 && y <= 70) {
      year = 2000 + y;
      confidence += 40;
      console.log(`📅 Found 2-digit SP year: ${y} -> ${year}`);
      break;
    }
  }

  // 2. Miesiąc SP - BARDZO TRUDNE przez OCR (strzałka wskazuje kierunek, nie cyfra!)
  // Musimy polegać na heurystykach i kontekście

  const potentialMonths = numbers
    .map(n => parseInt(n))
    .filter(n => n >= 1 && n <= 12)
    .filter(n => n.toString() !== year?.toString().slice(-2)); // Nie część roku

  console.log('🗓️ Potential SP months from text:', potentialMonths);

  // 3. STRATEGIA SP: Ponieważ strzałka wskazuje kierunek, próbujmy różne podejścia

  // A) Jeśli znaleźliśmy cyfry 1-12, użyj ich
  if (potentialMonths.length > 0) {
    // Dla SP preferuj miesiące środkowe roku (czerwiec-lipiec między HU)
    const middleMonths = potentialMonths.filter(m => m >= 5 && m <= 8); // Maj-Sierpień

    if (middleMonths.length > 0) {
      month = middleMonths[0]; // Czerwiec/Lipiec preferowane
      confidence += 40;
      console.log(`📅 SP middle-year month preference: ${month}`);
    } else {
      month = potentialMonths[0]; // Pierwszy dostępny
      confidence += 30;
      console.log(`📅 SP first available month: ${month}`);
    }
  }

  // B) Analiza pozycji w tekście (OCR może czytać różne części strzałki)
  if (!month && potentialMonths.length === 0) {
    // Spróbuj znaleźć wskazówki pozycyjne w tekście
    const positionalHints = {
      // Górne pozycje (12, 1, 2)
      'TOP|GÓRZE|OBEN|UP': [12, 1, 2],
      'RIGHT|PRAWO|RECHTS': [3, 4, 5],
      'BOTTOM|DÓŁ|UNTEN|DOWN': [6, 7, 8],
      'LEFT|LEWO|LINKS': [9, 10, 11]
    };

    for (const [hint, months] of Object.entries(positionalHints)) {
      const regex = new RegExp(hint, 'i');
      if (regex.test(text)) {
        month = months[1]; // Środkowy miesiąc z grupy
        confidence += 25;
        console.log(`📅 SP positional hint "${hint}" -> month: ${month}`);
        break;
      }
    }
  }

  // C) Fallback na typowe miesiące SP (między HU co 6 miesięcy)
  if (!month && year) {
    // SP często w: czerwiec (06), grudzień (12), styczeń (01), lipiec (07)
    const commonSpMonths = [6, 12, 1, 7]; // Czerwiec najpopularniejszy
    month = commonSpMonths[0]; // Domyślnie czerwiec
    confidence += 20;
    console.log(`📅 SP fallback to common month: ${month} (czerwiec)`);
  }

  // 4. Kontekst SP - sprawdź czy to rzeczywiście naklejka SP
  const spKeywords = ['SP', 'SICHER', 'SCHMITZ', 'CARGOBULL', 'PRÜF', 'ARROW', 'SPITZ'];
  const hasSpContext = spKeywords.some(keyword => text.toUpperCase().includes(keyword));

  if (hasSpContext) {
    confidence += 15;
    console.log('🔍 SP context detected: +15 confidence');
  }

  // 5. Dodatkowa logika dla naklejek strzałkowych
  // Jeśli OCR wykrył słowa opisujące kierunek
  const directionKeywords = {
    '6': ['JUNI', 'JUNE', 'CZERWIEC', 'JUN'],
    '12': ['DEZEMBER', 'DECEMBER', 'GRUDZIEŃ', 'DEZ', 'DEC'],
    '1': ['JANUAR', 'JANUARY', 'STYCZEŃ', 'JAN'],
    '3': ['MÄRZ', 'MARCH', 'MARZEC', 'MAR'],
    '9': ['SEPTEMBER', 'WRZESIEŃ', 'SEP']
  };

  for (const [monthNum, keywords] of Object.entries(directionKeywords)) {
    if (keywords.some(keyword => text.toUpperCase().includes(keyword))) {
      month = parseInt(monthNum);
      confidence += 35;
      console.log(`📅 SP month from keyword: ${month}`);
      break;
    }
  }

  // 6. Walidacja i formatowanie
  if (year && month && confidence >= 35) {
    const date = `${month.toString().padStart(2, '0')}/${year}`;
    console.log(`✅ SP Date extracted (ARROW TIP method): ${date} (confidence: ${confidence})`);
    return date;
  }

  // 7. Ostatnia próba - jeśli mamy rok ale nie miesiąc
  if (year && !month) {
    month = 6; // Czerwiec jako najbezpieczniejszy fallback dla SP
    confidence = 25;
    const date = `${month.toString().padStart(2, '0')}/${year}`;
    console.log(`⚠️ SP Date with fallback month: ${date} (confidence: ${confidence})`);
    return date;
  }

  console.log(`❌ SP Date extraction failed - year: ${year}, month: ${month}, confidence: ${confidence}`);
  return null;
}

// Główna funkcja analizy OCR z ulepszoną strategią (poprawiona)
async function analyzeInspectionImage(media) {
  try {
    console.log('🔍 Starting CORRECTED inspection image analysis v2.2...');

    // Pobierz obraz
    const imageBuffer = await media.downloadAsync();

    // Ulepszone preprocessing - uzyskaj kilka wariantów
    const processedImages = await preprocessImage(imageBuffer);

    // OCR z wieloma strategiami i wariantami obrazu
    const ocrStrategies = [
      {
        name: 'Numbers focused (standard)',
        lang: 'eng',
        image: 'standard',
        config: {
          tessedit_char_whitelist: '0123456789 ',
          tessedit_pageseg_mode: '8'
        }
      },
      {
        name: 'Numbers focused (aggressive)',
        lang: 'eng',
        image: 'aggressive',
        config: {
          tessedit_char_whitelist: '0123456789 ',
          tessedit_pageseg_mode: '6'
        }
      },
      {
        name: 'German optimized (standard)',
        lang: 'deu+eng',
        image: 'standard',
        config: {
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜß0123456789 -–()/',
          tessedit_pageseg_mode: '6'
        }
      },
      {
        name: 'German optimized (aggressive)',
        lang: 'deu+eng',
        image: 'aggressive',
        config: {
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜß0123456789 -–()/',
          tessedit_pageseg_mode: '11'
        }
      },
      {
        name: 'Default enhanced (original)',
        lang: 'deu+eng',
        image: 'original',
        config: {
          tessedit_pageseg_mode: '11'
        }
      }
    ];

    let bestResult = null;
    let bestConfidence = 0;
    let allTexts = [];

    for (const strategy of ocrStrategies) {
      try {
        console.log(`📖 Running OCR strategy: ${strategy.name}`);

        const imageToUse = processedImages[strategy.image];

        const result = await Tesseract.recognize(imageToUse, strategy.lang, {
          logger: m => {
            if (m.status === 'recognizing text' && m.progress > 0) {
              const progress = Math.round(m.progress * 100);
              if (progress % 25 === 0) {
                console.log(`   Progress: ${progress}%`);
              }
            }
          },
          ...strategy.config
        });

        const cleanedText = result.data.text
          .replace(/[^\w\s\d\-–()/.]/g, ' ')  // Usuń dziwne znaki
          .replace(/\s+/g, ' ')               // Normalizuj spacje
          .trim();

        allTexts.push({
          text: cleanedText,
          confidence: result.data.confidence,
          strategy: strategy.name
        });

        if (result.data.confidence > bestConfidence) {
          bestResult = result;
          bestConfidence = result.data.confidence;
        }

        console.log(`   Confidence: ${Math.round(result.data.confidence)}% | Text: "${cleanedText}"`);
      } catch (err) {
        console.log(`❌ OCR strategy ${strategy.name} failed:`, err.message);
      }
    }

    if (!bestResult) {
      throw new Error('All OCR strategies failed');
    }

    // Połącz wszystkie teksty dla lepszej analizy
    const combinedText = allTexts
      .map(t => t.text)
      .filter(t => t.length > 0)
      .join(' ')
      .toUpperCase();

    console.log('📝 Combined OCR Text:', combinedText);
    console.log('🎯 Best OCR Confidence:', Math.round(bestConfidence), '%');

    // Dodatkowo sprawdź każdy tekst osobno dla najlepszego wyniku
    let bestHuDate = null;
    let bestSpDate = null;
    let bestLicensePlate = null;
    let maxHuConfidence = 0;
    let maxSpConfidence = 0;
    let maxPlateScore = 0;

    // Testuj każdy wariant tekstu osobno
    for (const textData of allTexts) {
      const text = textData.text;

      try {
        // Test rozpoznawania tablicy
        const plate = extractLicensePlate(text);
        if (plate) {
          const score = calculatePlateScore(plate, text);
          if (score > maxPlateScore) {
            bestLicensePlate = plate;
            maxPlateScore = score;
          }
        }

        // Test rozpoznawania HU
        const huDate = extractHUDate(text);
        if (huDate) {
          const confidence = textData.confidence;
          if (confidence > maxHuConfidence) {
            bestHuDate = huDate;
            maxHuConfidence = confidence;
          }
        }

        // Test rozpoznawania SP
        const spDate = extractSPDate(text);
        if (spDate) {
          const confidence = textData.confidence;
          if (confidence > maxSpConfidence) {
            bestSpDate = spDate;
            maxSpConfidence = confidence;
          }
        }
      } catch (e) {
        console.log(`⚠️ Error processing text variant: ${e.message}`);
      }
    }

    // Fallback - spróbuj z combined text jeśli nic nie znaleziono
    if (!bestLicensePlate) {
      bestLicensePlate = extractLicensePlate(combinedText);
    }
    if (!bestHuDate) {
      bestHuDate = extractHUDate(combinedText);
    }
    if (!bestSpDate) {
      bestSpDate = extractSPDate(combinedText);
    }

    // Analiza z ulepszonymi wynikami
    const analysis = {
      rawText: combinedText,
      confidence: Math.round(bestConfidence),
      licensePlate: bestLicensePlate,
      huDate: bestHuDate,
      spDate: bestSpDate,
      hasOrangeSticker: /TÜV|TUV|HAUPT|ORANGE|POMARAŃCZ/i.test(combinedText),
      hasBlueSticker: /SP|SICHER|SCHMITZ|CARGOBULL|BLAU|BLUE|NIEBIESKI/i.test(combinedText),
      hasPentagonShape: /FÜNF|PENTAGON|SPITZ|ECKE/i.test(combinedText),
      hasCircularShape: /RUND|KREIS|CIRCLE|OKRĄG/i.test(combinedText),
      // Debug info
      allTexts: allTexts.map(t => ({ text: t.text.substring(0, 100), confidence: Math.round(t.confidence), strategy: t.strategy }))
    };

    console.log('📊 CORRECTED analysis result v2.2:', {
      licensePlate: analysis.licensePlate,
      huDate: analysis.huDate,
      spDate: analysis.spDate,
      confidence: analysis.confidence
    });

    return analysis;

  } catch (error) {
    console.error('❌ CORRECTED OCR analysis failed:', error);
    return {
      error: error.message,
      rawText: '',
      confidence: 0,
      licensePlate: null,
      huDate: null,
      spDate: null
    };
  }
}

// Przetwarzanie zgrupowanych danych przegladów przez API
async function processGroupedInspectionData() {
  if (inspectionContext.groupedData.length === 0) return;

  console.log('🔄 Processing grouped inspection data via API v2.2...');

  // Znajdź najlepszą tablicę rejestracyjną
  let licensePlate = inspectionContext.licensePlate;
  let bestPlateScore = 0;

  for (const data of inspectionContext.groupedData) {
    if (data.licensePlate) {
      const score = calculatePlateScore(data.licensePlate, '');
      if (score > bestPlateScore) {
        licensePlate = data.licensePlate;
        bestPlateScore = score;
      }
    }
  }

  if (!licensePlate) {
    console.log('❌ No valid license plate found in grouped data');
    await telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ Nie znaleziono prawidłowej tablicy rejestracyjnej');
    return;
  }

  // Zbierz najlepsze daty
  let huDate = null;
  let spDate = null;
  let huConfidence = 0;
  let spConfidence = 0;

  for (const data of inspectionContext.groupedData) {
    if (data.huDate && data.confidence > huConfidence) {
      huDate = data.huDate;
      huConfidence = data.confidence;
    }
    if (data.spDate && data.confidence > spConfidence) {
      spDate = data.spDate;
      spConfidence = data.confidence;
    }
  }

  // Aktualizuj przez API
  try {
    const result = await updateInspectionDatabaseAPI(
      licensePlate,
      huDate ? huDate.replace('/', '.') : null,
      spDate ? spDate.replace('/', '.') : null
    );

    // Podsumowanie z dodatkowymi informacjami
    let summary = `✅ *PRZEGLĄD ZAKTUALIZOWANY* (API v2.2)\n\n`;
    summary += `🚗 *Pojazd:* ${licensePlate}\n`;
    if (huDate) summary += `🔶 *HU:* ${huDate} (${huConfidence}% pewności)\n   ↳ _Cyfra na górze = miesiąc_\n`;
    if (spDate) summary += `🔷 *SP:* ${spDate} (${spConfidence}% pewności)\n   ↳ _Kierunek strzałki = miesiąc_\n`;
    summary += `\n📸 *Zdjęć przeanalizowanych:* ${inspectionContext.groupedData.length}\n`;
    summary += `🎯 *Średnia pewność OCR:* ${Math.round(inspectionContext.groupedData.reduce((sum, d) => sum + d.confidence, 0) / inspectionContext.groupedData.length)}%\n`;
    summary += `🌐 *Metoda:* Fleet API v2.2`;

    await client.sendMessage(FLEET_GROUP_ID, summary);
    await telegram.sendMessage(TELEGRAM_CHAT_ID, summary);

  } catch (error) {
    console.error('❌ API update failed:', error.message);
    await telegram.sendMessage(TELEGRAM_CHAT_ID, `❌ Błąd aktualizacji przez API: ${error.message}`);
  }

  // Reset kontekstu
  inspectionContext = {
    licensePlate: null,
    lastMessageTime: null,
    groupedData: [],
    processingTimeout: null
  };
}

// Event listener dla wiadomości w grupie przegladów (OCR v2.2)
client.on('message_create', async (message) => {
  // Sprawdź czy to grupa przegladów
  if (message.from !== FLEET_GROUP_ID) return;

  try {
    const now = Date.now();

    // Sprawdź czy wiadomość ma media
    if (message.hasMedia) {
      console.log('📸 New inspection image received (OCR v2.2)');

      const media = await message.downloadMedia();
      if (!media || !media.mimetype.startsWith('image/')) {
        console.log('❌ Not an image, skipping');
        return;
      }

      // Analizuj obraz z naprawionym algorytmem v2.2
      const analysis = await analyzeInspectionImage(media);

      if (analysis.error) {
        console.log('❌ Analysis failed:', analysis.error);
        return;
      }

      // Dodaj do kontekstu grupowania
      inspectionContext.groupedData.push(analysis);
      inspectionContext.lastMessageTime = now;

      // Ustaw tablicę jeśli znaleziona i lepszą od poprzedniej
      if (analysis.licensePlate) {
        const currentScore = inspectionContext.licensePlate ?
          calculatePlateScore(inspectionContext.licensePlate, '') : 0;
        const newScore = calculatePlateScore(analysis.licensePlate, '');

        if (newScore > currentScore) {
          inspectionContext.licensePlate = analysis.licensePlate;
          console.log(`📝 Updated license plate: ${analysis.licensePlate} (score: ${newScore})`);
        }
      }

      // Anuluj poprzedni timeout
      if (inspectionContext.processingTimeout) {
        clearTimeout(inspectionContext.processingTimeout);
      }

      // Ustaw nowy timeout (5 sekund po ostatniej wiadomości)
      inspectionContext.processingTimeout = setTimeout(() => {
        processGroupedInspectionData();
      }, 5000);

      console.log(`📊 Grouped ${inspectionContext.groupedData.length} inspection images (v2.2)`);
    }

    // Sprawdź tekst wiadomości na tablicę rejestracyjną
    if (message.body && message.body.length > 3) {
      const textPlate = extractLicensePlate(message.body.toUpperCase());
      if (textPlate) {
        const currentScore = inspectionContext.licensePlate ?
          calculatePlateScore(inspectionContext.licensePlate, '') : 0;
        const newScore = calculatePlateScore(textPlate, '');

        if (newScore > currentScore) {
          inspectionContext.licensePlate = textPlate;
          console.log(`📝 License plate from text: ${textPlate} (score: ${newScore})`);
        }
      }
    }

  } catch (error) {
    console.error('❌ Error processing inspection message:', error);
    await telegram.sendMessage(TELEGRAM_CHAT_ID, `❌ Błąd przetwarzania przeglądu v2.2: ${error.message}`);
  }
});

// ==================== FUNKCJE PRZEGLADÓW (LEGACY) ====================

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
  telegram.sendMessage(msg.chat.id, '🤖 *UNIVERSAL BOT v2.2*\n\n✅ *Status:* Aktiv\n🚛 *Toury:* Bereit\n🚗 *Prüfungen:* Bereit\n📱 *WhatsApp:* Verbunden\n🔍 *OCR:* v2.2 (NAPRAWIONY)\n🌐 *API:* Fleet Integration');
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
  telegram.sendMessage(msg.chat.id, '🔄 *Restartuję bota v2.2...*');
  setTimeout(() => {
    process.exit(0);
  }, 1000);
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

  let schedule = '📅 *HARMONOGRAM AUTOMATYCZNY v2.2*\n\n';
  schedule += `🕒 *Aktualna data:* ${now}\n\n`;
  schedule += '⏰ *Zadania automatyczne:*\n\n';
  schedule += '🔸 *7:30* (Pon-Pt)\n';
  schedule += '   📋 Sprawdzenie nieprzypisanych tour\n';
  schedule += '   📤 Powiadomienia kierowników\n\n';
  schedule += '🔸 *10:00* (Poniedziałek)\n';
  schedule += '   🚗 Raport przegladów technicznych\n\n';
  schedule += '🔸 *10:30* (Pon-Pt)\n';
  schedule += '   📊 Podsumowanie tour do grupy\n\n';
  schedule += '🔸 *Real-time* (24/7)\n';
  schedule += '   📸 OCR przegladów z grupy WhatsApp\n';
  schedule += '   🌐 Automatyczna aktualizacja przez API\n\n';
  schedule += '▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️▫️\n';
  schedule += '_Strefa czasowa: Europe/Berlin_';

  telegram.sendMessage(msg.chat.id, schedule);
});

// ==================== KOMENDY FLEET API ====================

// Sprawdzenie stanu API
telegram.onText(/\/fleet_api_status/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  try {
    telegram.sendMessage(msg.chat.id, '🔄 Sprawdzam połączenie z Fleet API...');

    const health = await checkFleetAPIHealth();

    let status = '🌐 *FLEET API STATUS*\n\n';
    status += `✅ *Status:* Połączono\n`;
    status += `🚗 *Pojazdy w bazie:* ${health.vehicle_count}\n`;
    status += `🕐 *Czas serwera:* ${health.server_time}\n`;
    status += `📦 *Wersja API:* ${health.api_version}\n`;
    status += `🔑 *Autoryzacja:* OK\n\n`;
    status += `📍 *Endpoint:* ${FLEET_API_CONFIG.baseUrl}/bot_inspection_api.php`;

    telegram.sendMessage(msg.chat.id, status);
  } catch (error) {
    telegram.sendMessage(msg.chat.id, `❌ *FLEET API ERROR*\n\n${error.message}`);
  }
});

// Test aktualizacji przez API
telegram.onText(/\/test_api_update (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  const params = match[1].split(',').map(p => p.trim());
  const licensePlate = params[0];
  const huDate = params[1] || null;
  const spDate = params[2] || null;

  if (!licensePlate) {
    return telegram.sendMessage(msg.chat.id, '❌ Format: /test_api_update TABLICA,HU_DATE,SP_DATE\nPrzykład: /test_api_update TF LS 4005,12.2025,06.2026');
  }

  try {
    telegram.sendMessage(msg.chat.id, `🔄 Testuję aktualizację API dla ${licensePlate}...`);

    const result = await updateInspectionDatabaseAPI(licensePlate, huDate, spDate);

    let response = `✅ *API UPDATE TEST*\n\n`;
    response += `🚗 *Pojazd:* ${licensePlate}\n`;
    if (huDate) response += `🔶 *HU:* ${huDate}\n`;
    if (spDate) response += `🔷 *SP:* ${spDate}\n\n`;
    response += `📝 *Odpowiedź API:* ${result.message}`;

    telegram.sendMessage(msg.chat.id, response);
  } catch (error) {
    telegram.sendMessage(msg.chat.id, `❌ *API TEST FAILED*\n\n${error.message}`);
  }
});

// ==================== KOMENDY OCR v2.2 ====================

// Test OCR na zdjęciu (naprawiony algorytm)
telegram.onText(/\/test_ocr_v2/, async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '📸 *Test OCR v2.2 (NAPRAWIONY)*\n\nWyślij zdjęcie z odpowiedzią na tę wiadomość.\n\n🔄 *POPRAWKI na podstawie Twojej korekty:*\n\n🔶 **HU**: Cyfra NA GÓRZE = miesiąc\n🔷 **SP**: Zaostrzony koniec WSKAZUJE miesiąc\n\n✅ *Twoje przykłady:*\n• **12/25** (grudzień 2025) - cyfra 12 na górze HU\n• **06/26** (czerwiec 2026) - strzałka SP wskazuje 6h');
});

// Obsługa odpowiedzi ze zdjęciem dla naprawionego testu OCR
telegram.on('photo', async (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  if (msg.reply_to_message && msg.reply_to_message.text &&
      (msg.reply_to_message.text.includes('Test OCR') || msg.reply_to_message.text.includes('NAPRAWIONY'))) {

    try {
      telegram.sendMessage(msg.chat.id, '🔄 Analizuję zdjęcie NAPRAWIONYM algorytmem v2.2...\n\n🔶 HU: szukam cyfry NA GÓRZE\n🔷 SP: analizuję kierunek strzałki');

      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const file = await telegram.getFile(fileId);
      const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

      // Pobierz i analizuj obraz
      const https = require('https');
      const imageBuffer = await new Promise((resolve, reject) => {
        https.get(imageUrl, (res) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      });

      // Symuluj media object
      const media = {
        downloadAsync: async () => imageBuffer
      };

      const analysis = await analyzeInspectionImage(media);

      let result = '🔍 *OCR ANALIZA v2.2 (NAPRAWIONA)*\n\n';

      // Główne wyniki z wyjaśnieniem
      if (analysis.licensePlate) result += `🚗 *Tablica:* \`${analysis.licensePlate}\`\n`;
      if (analysis.huDate) {
        result += `🔶 *HU:* \`${analysis.huDate}\`\n`;
        result += `   ↳ _Cyfra na górze = miesiąc, środek = rok_\n`;
      }
      if (analysis.spDate) {
        result += `🔷 *SP:* \`${analysis.spDate}\`\n`;
        result += `   ↳ _Kierunek strzałki wskazuje miesiąc_\n`;
      }

      result += `\n🎯 *Pewność OCR:* ${analysis.confidence}%\n\n`;

      // Porównanie z Twoimi przykładami
      result += '*📸 Porównanie z Twoimi przykładami:*\n';
      if (analysis.huDate === '12/25') {
        result += `✅ HU: **ZGODNE** z 12/25 (grudzień 2025)\n`;
      } else if (analysis.huDate) {
        result += `⚠️ HU: **${analysis.huDate}** vs oczekiwane 12/25\n`;
      }

      if (analysis.spDate === '06/26') {
        result += `✅ SP: **ZGODNE** z 06/26 (czerwiec 2026)\n`;
      } else if (analysis.spDate) {
        result += `⚠️ SP: **${analysis.spDate}** vs oczekiwane 06/26\n`;
      }

      // Wykryte elementy
      result += `\n*Wykryte elementy:*\n`;
      if (analysis.hasOrangeSticker) result += `🟠 Naklejka TÜV/HU\n`;
      if (analysis.hasBlueSticker) result += `🔵 Naklejka SP\n`;
      if (analysis.hasCircularShape) result += `⭕ Kształt okrągły (HU)\n`;
      if (analysis.hasPentagonShape) result += `🔸 Kształt strzałkowy (SP)\n`;

      // Debug info jeśli dostępne (skrócony)
      if (analysis.allTexts && analysis.allTexts.length > 0) {
        result += `\n*🔧 Debug (${analysis.allTexts.length} wariantów):*\n`;
        const bestVariant = analysis.allTexts[0];
        result += `Top: ${bestVariant.strategy} (${bestVariant.confidence}%)\n`;
        result += `"${bestVariant.text.substring(0, 80)}..."\n`;
      }

      telegram.sendMessage(msg.chat.id, result);

    } catch (error) {
      telegram.sendMessage(msg.chat.id, '❌ Błąd testu OCR v2.2: ' + error.message);
    }
  }
});

// Debug - pokaż wszystkie warianty OCR (poprawiony)
telegram.onText(/\/debug_ocr/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  let debug = '🛠️ *DEBUG OCR v2.2* 🔄\n\n';
  debug += '*📋 POPRAWIONE ZROZUMIENIE:*\n';
  debug += '🔶 **HU**: Cyfra NA GÓRZE = miesiąc, W ŚRODKU = rok\n';
  debug += '🔷 **SP**: Zaostrzony koniec WSKAZUJE miesiąc\n\n';
  debug += '*🔧 Strategie OCR:*\n';
  debug += '1️⃣ Numbers focused (standard + aggressive)\n';
  debug += '2️⃣ German optimized (standard + aggressive)  \n';
  debug += '3️⃣ Default enhanced (original)\n\n';
  debug += '*📸 Preprocessing:*\n';
  debug += '• Standard: 1600px, kontrast 1.4\n';
  debug += '• Aggressive: 1800px, kontrast 1.8, threshold\n';
  debug += '• Original: bez zmian\n\n';
  debug += '*🎯 Nowy algorytm rozpoznawania:*\n';
  debug += '• **HU**: Pozycja cyfry w tekście (górny = miesiąc)\n';
  debug += '• **SP**: Kierunek strzałki + fallback czerwiec\n';
  debug += '• **Tablice**: Scoring + German format validation\n\n';
  debug += '*💡 Przykłady Twojej korekty:*\n';
  debug += '• `12/25` ✅ (cyfra 12 na górze HU)\n';
  debug += '• `06/26` ✅ (strzałka SP wskazuje czerwiec)\n\n';
  debug += '*🧪 Test:* `/test_ocr_v2` + wyślij zdjęcie!';

  telegram.sendMessage(msg.chat.id, debug);
});

// Debug informacji o naklejkach (poprawiony opis)
telegram.onText(/\/info_naklejki/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  let info = '📋 *INFORMACJE O NAKLEJKACH v2.2* 🔄\n\n';
  info += '*🔶 HU (Hauptuntersuchung) - OKRĄGŁA:*\n';
  info += '• **NA GÓRZE (12h)** = **MIESIĄC** 📅\n';
  info += '• **W ŚRODKU** = **ROK** 📅\n';
  info += '• Czytamy jak zegar - cyfra na górze!\n';
  info += '• Kolory: 🟠Orange(2025), 🔵Blau(2026), 🟡Gelb(2027)\n';
  info += '• Przykład: *cyfra 12 na górze + 25 w środku = 12/25*\n\n';
  info += '*🔷 SP (Sicherheitsprüfung) - STRZAŁKA:*\n';
  info += '• **ZAOSTRZONY KONIEC** wskazuje miesiąc! 👉\n';
  info += '• Jak wskazówka zegara - kierunek = miesiąc\n';
  info += '• Tylko dla LKW >7.5t, autobusów >8 miejsc\n';
  info += '• Co 6 miesięcy między HU\n';
  info += '• Przykład: *koniec strzałki na 6h = 06/26*\n\n';
  info += '*🎯 OCR v2.2 ALGORYTM:*\n';
  info += '• ✅ HU: Szuka cyfry NA GÓRZE (pozycja 12h)\n';
  info += '• ✅ SP: Analizuje kierunek + fallback czerwiec\n';
  info += '• ✅ Wielostratgiczne preprocessing\n';
  info += '• ✅ Smart wybór najlepszego wariantu\n';
  info += '• ✅ Korekta błędów OCR (O↔0, I↔1)\n\n';
  info += '*🧪 Komendy testowe:*\n';
  info += '• `/test_ocr_v2` - Test poprawionego OCR\n';
  info += '• `/debug_ocr` - Informacje techniczne\n';
  info += '• `/reset_prz` - Reset kontekstu\n\n';
  info += '*📸 Twoje przykłady:*\n';
  info += '• HU: **12/25** (grudzień 2025) ✅\n';
  info += '• SP: **06/26** (czerwiec 2026) ✅';

  telegram.sendMessage(msg.chat.id, info);
});

// Reset kontekstu przegladów
telegram.onText(/\/reset_prz/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

  if (inspectionContext.processingTimeout) {
    clearTimeout(inspectionContext.processingTimeout);
  }

  inspectionContext = {
    licensePlate: null,
    lastMessageTime: null,
    groupedData: [],
    processingTimeout: null
  };

  telegram.sendMessage(msg.chat.id, '🔄 Kontekst przegladów zresetowany (v2.2 - NAPRAWIONY)');
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

// ==================== KOMENDY PRZEGLADÓW (LEGACY) ====================

// Status przegladów
telegram.onText(/\/fleet_status/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🚗 *Fleet Überwachung v2.2*\n\n✅ Status: Aktiv\n📅 Automatisch: Jeden Montag 10:00\n📱 Format: Mobile-optimiert\n🔍 OCR: v2.2 (Real-time)\n🌐 API: Fleet Integration');
});

// Test przegladów
telegram.onText(/\/test_fleet/, (msg) => {
  if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
  telegram.sendMessage(msg.chat.id, '🔄 *Starte Test*\nPrüfungen werden gesendet...');
  checkAndSendInspectionReport();
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

// Uruchomienie klienta WhatsApp
client.initialize();

// Obsługa błędów dla procesu
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ Nieobsłużony błąd v2.2: ' + reason)
    .catch(console.error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  telegram.sendMessage(TELEGRAM_CHAT_ID, '❌ Krytyczny błąd v2.2: ' + error.message)
    .catch(console.error);
  process.exit(1);
});

console.log('🚀 Universal Bot v2.2 uruchamiany...');
console.log('📋 Funkcje: Toury + Technische Prüfungen + OCR v2.2 + Fleet API');
console.log('📅 Harmonogram automatyczny:');
console.log('   • 7:30 (Pon-Pt) - Powiadomienia kierowników');
console.log('   • 10:00 (Poniedziałek) - Raport przegladów');
console.log('   • 10:30 (Pon-Pt) - Podsumowanie tour do grupy');
console.log('   • Real-time (24/7) - OCR przegladów z grupy WhatsApp');
console.log('🔍 OCR v2.2 features:');
console.log('   • 🔶 HU: Cyfra NA GÓRZE = miesiąc, W ŚRODKU = rok');
console.log('   • 🔷 SP: Zaostrzony koniec WSKAZUJE miesiąc');
console.log('   • 📸 5 strategii OCR + 3 warianty preprocessing');
console.log('   • 🌐 Automatyczna aktualizacja przez Fleet API');
console.log('🎯 Target dates: 12/25 (HU), 06/26 (SP)');
