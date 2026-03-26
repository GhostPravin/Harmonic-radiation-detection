# EV Charger IoT Dashboard ⚡🔋

A complete end-to-end IoT solution for monitoring and controlling an Electric Vehicle (EV) charging station. The system consists of an ESP32-based hardware controller and a real-time WebSocket-driven cyber-themed web dashboard.

## 🌟 Features

### 🔌 Hardware (ESP32 Firmware)
- **Voltage Monitoring:** Reads input voltage (`Vin`) and battery voltage (`Vbat`).
- **Current Monitoring:** Measures current using an ACS712 sensor.
- **Overcurrent Protection:** Automatically trips the charging relay if current exceeds `0.9A`.
- **Battery-Full Cutoff:** Automatically stops charging when the battery reaches `12.4V` (configurable for 12V LiFePO4 or Lead-Acid).
- **LCD Display:** Real-time 16x2 I2C LCD showing `Vin`, `Vbat`, Current, and Relay Status (`OK`, `TRIP`, `FULL`).
- **IoT Connectivity:** Sends sensor data via HTTP POST to the local Node.js server every second.

### 🌐 Dashboard (Node.js + Websockets)
- **Real-Time Data Streaming:** Uses WebSockets for instantly rendering live incoming data.
- **Dynamic KPI Cards:** Displays voltage, battery percentage (0% at 5V, 100% at 12.4V), current, and power output.
- **Live Interactive Chart:** Chart.js integration showing history over time.
- **Relay Status:** Visual indicator for `CHARGING` (Green), `BATTERY FULL` (Gold), and `TRIPPED` (Red overcurrent fault).
- **Connection Health:** Displays "ESP32 ONLINE" when active data is flowing, and falls back to "OFFLINE" via a 5-second timeout if the ESP32 loses connection.
- **Event Log:** Automatically logs records when significant value shifts occur or when the relay state changes.

## 🛠️ Tech Stack

- **Firmware:** C++ (Arduino Core for ESP32), `<ArduinoJson.h>`, `<LiquidCrystal_I2C.h>`, `<HTTPClient.h>`, `<WiFi.h>`
- **Backend/Server:** Node.js, Express, `ws` (WebSockets)
- **Frontend:** HTML5, Vanilla CSS3 (Custom Dark Cyber Theme), Vanilla JS, Chart.js

## 🚀 Getting Started

### 1. Hardware Setup (ESP32)
1. Open `firmware/ev_charger.ino` in the Arduino IDE.
2. Provide your WiFi credentials (`WIFI_SSID` and `WIFI_PASSWORD`).
3. Update `SERVER_HOST` with the IP address of the computer running the Node.js server.
4. Flash the code to your ESP32.

> **Hardware Pins mapping:**
> - `VIN_PIN`: 34
> - `VBAT_PIN`: 33
> - `CURRENT_PIN`: 35
> - `RELAY_PIN`: 26

### 2. Server Setup (Node.js)
1. Navigate to the `server/` directory.
2. Run `npm install` to grab the required packages (`express`, `cors`, `ws`).
3. Run `node server.js` (or use the provided `START_SERVER.bat` in the root folder).
4. The server will start on port `3000`.

### 3. Dashboard
- You can access the dashboard by visiting `http://localhost:3000` in your web browser.
- Once the ESP32 successfully connects to the network, it will begin streaming HTTP payloads to the server, and the dashboard will instantly update!

---
*Created as part of the Harmonic Radiation EV IoT Project.*
