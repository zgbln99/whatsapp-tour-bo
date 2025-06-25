
# Tour WhatsApp Bot 🇩🇪

Bot do automatycznego informowania kierowników przez WhatsApp, gdy tury nie zostały przypisane do aut.

## 📦 Wymagania

- Node.js 18+
- MariaDB (zdalny dostęp)
- WhatsApp z zeskanowanym QR (whatsapp-web.js)
- Cron lub pm2 do uruchamiania w tle

## ⚙️ Instalacja

```bash
sudo apt update && sudo apt install nodejs npm -y
npm install whatsapp-web.js mysql2 qrcode-terminal node-cron
```

## 🧠 Konfiguracja

Uzupełnij dane dostępu do bazy w `index.js`:
```js
password: 'TWOJE_HASLO_TUTAJ'
```

## 🚀 Uruchomienie

```bash
node index.js
```

Przy pierwszym uruchomieniu zeskanuj QR kod telefonem.

## 🔁 Utrzymanie 24/7

```bash
npm install -g pm2
pm2 start index.js --name tourbot
pm2 save
pm2 startup
```

## 📩 Co wysyła bot

- Wiadomość do kierownika (z linkiem do przypisania tur)
- Wiadomość grupowa (bez linku, z informacją że vorarbeiter został poinformowany)

## 🛡️ Uwaga

Nie udostępniaj `session` nikomu – zawiera aktywną sesję WhatsApp.
