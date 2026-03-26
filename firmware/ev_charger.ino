/*
  EV Charger – IoT Dashboard Firmware
  =====================================
  ESP32 reads Vin, Vbat, and current then:
    1. Displays values on I2C LCD
    2. Controls relay with overcurrent protection & battery-full cutoff
    3. POSTs JSON data to a Node.js server via WiFi (HTTP)
    4. Connects to server WebSocket for real-time push (optional)

  Required Libraries:
    - Wire.h            (built-in)
    - LiquidCrystal_I2C (Install via Library Manager: "LiquidCrystal I2C" by Frank de Brabander)
    - WiFi.h            (built-in for ESP32)
    - HTTPClient.h      (built-in for ESP32)
    - ArduinoJson       (Install via Library Manager: "ArduinoJson" by Benoit Blanchon)
*/

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiUdp.h>
#include <ArduinoJson.h>

// ─── WiFi Credentials ──────────────────────────────────────────────────────
const char* WIFI_SSID     = "EngiiGenius";      // <-- Change this
const char* WIFI_PASSWORD = "Engii@123";  // <-- Change this

// ─── Server Config (Dynamic) ───────────────────────────────────────────────
// No hardcoded IP! ESP32 will find the server automatically via UDP broadcast.
const int   UDP_PORT = 3001;
String      serverURL;
WiFiUDP     udp;

// ─── Hardware Pins ─────────────────────────────────────────────────────────
#define VIN_PIN     34
#define VBAT_PIN    33
#define CURRENT_PIN 35
#define RELAY_PIN   26

// ─── LCD ───────────────────────────────────────────────────────────────────
LiquidCrystal_I2C lcd(0x27, 16, 2);

// ─── Sensor Variables ──────────────────────────────────────────────────────
float vin, vbat, current, power;
float offset = 0;

const float CURRENT_LIMIT = 0.9;   // Amps – overcurrent trip threshold
const float SENSITIVITY   = 0.100; // V/A  – ACS712 sensitivity

// ─── Battery Full-Charge Cutoff ────────────────────────────────────────────
// For a 12 V lead-acid battery the float/absorption voltage is ~14.4 V.
// Adjust to ~14.6 V for sealed AGM, or ~14.0 V for LiFePO4.
const float VBAT_FULL = 12.4;     // Volts – stop charging at this Vbat level

// ─── Timing ────────────────────────────────────────────────────────────────
unsigned long lastSendTime = 0;
const unsigned long SEND_INTERVAL = 1000; // ms between HTTP POSTs

// ─── WiFi Connect ──────────────────────────────────────────────────────────
void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lcd.setCursor(0, 1);
  lcd.print("WiFi connect... ");
  Serial.print("Connecting to WiFi");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected! IP: " + WiFi.localIP().toString());
    lcd.setCursor(0, 1);
    lcd.print("IP:");
    lcd.print(WiFi.localIP());
    delay(1500);
  } else {
    Serial.println("\nWiFi failed – running offline");
    lcd.setCursor(0, 1);
    lcd.print("WiFi FAILED!    ");
    delay(1500);
  }
}

// ─── Server Auto-Discovery (UDP) ───────────────────────────────────────────
void discoverServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Locating Server.");
  Serial.println("Broadcasting UDP to find EV Server...");
  
  udp.begin(UDP_PORT);
  bool discovered = false;

  while (!discovered) {
    // 1. Broadcast "EV_DISCOVER"
    udp.beginPacket(IPAddress(255, 255, 255, 255), UDP_PORT);
    udp.print("EV_DISCOVER");
    udp.endPacket();

    // 2. Wait up to 2 seconds for a reply
    unsigned long waitStart = millis();
    while (millis() - waitStart < 2000) {
      int packetSize = udp.parsePacket();
      if (packetSize) {
        char packetBuffer[255];
        int len = udp.read(packetBuffer, 255);
        if (len > 0) packetBuffer[len] = 0;
        
        String reply = String(packetBuffer);
        if (reply.startsWith("EV_SERVER:")) {
          String ipStr = udp.remoteIP().toString();
          String portStr = reply.substring(10); // Extract port number after "EV_SERVER:"
          
          serverURL = "http://" + ipStr + ":" + portStr + "/api/data";
          
          Serial.println("Server found at: " + serverURL);
          discovered = true;
          
          lcd.setCursor(0, 1);
          lcd.print("Found! " + portStr + "  ");
          delay(2000);
          break;
        }
      }
      delay(10);
    }
    
    if (!discovered) {
      Serial.println("No reply, retrying broadcast...");
      lcd.setCursor(0, 1);
      lcd.print("Retrying...     ");
    }
  }
  udp.stop();
}

// ─── Send Data to Server ───────────────────────────────────────────────────
// relay state: "ON" = charging, "TRIP" = overcurrent, "FULL" = battery full
void sendData(const String& relayState) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(serverURL);
  http.addHeader("Content-Type", "application/json");

  // Build JSON payload
  StaticJsonDocument<256> doc;
  doc["vin"]         = round(vin * 10) / 10.0;
  doc["vbat"]        = round(vbat * 10) / 10.0;
  doc["current"]     = round(current * 100) / 100.0;
  doc["power"]       = round(power * 10) / 10.0;
  doc["relay"]       = relayState;
  doc["timestamp"]   = millis();

  String payload;
  serializeJson(doc, payload);

  int httpCode = http.POST(payload);

  if (httpCode > 0) {
    Serial.printf("[HTTP] POST → %d  payload: %s\n", httpCode, payload.c_str());
  } else {
    Serial.printf("[HTTP] Error: %s\n", http.errorToString(httpCode).c_str());
  }

  http.end();
}


// ─── Setup ─────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  // Relay
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW); // Active LOW → relay ON

  // LCD init
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("EV Charger IoT  ");
  lcd.setCursor(0, 1);
  lcd.print("Calibrating...  ");
  delay(1000);

  // Current sensor zero calibration
  float sum = 0;
  for (int i = 0; i < 500; i++) {
    sum += analogRead(CURRENT_PIN);
    delay(2);
  }
  offset = (sum / 500.0) * (3.3 / 4095.0);
  Serial.printf("Calibration done. Offset = %.4f V\n", offset);

  lcd.clear();

  // WiFi
  connectWiFi();

  // Find Node.js Server dynamically
  discoverServer();

  lcd.clear();
}

// ─── Loop ──────────────────────────────────────────────────────────────────
void loop() {
  // ── Read Voltage Sensors ─────────────────────────────────────
  int vinRaw  = analogRead(VIN_PIN);
  int vbatRaw = analogRead(VBAT_PIN);

  vin  = (vinRaw  * 3.3 / 4095.0) * 5.0;
  vbat = (vbatRaw * 3.3 / 4095.0) * 5.0;

  // ── Read Current Sensor (averaged) ───────────────────────────
  float sensorAcc = 0;
  for (int i = 0; i < 200; i++) sensorAcc += analogRead(CURRENT_PIN);
  float sensorVoltage = (sensorAcc / 200.0) * (3.3 / 4095.0);
  current = (sensorVoltage - offset) / SENSITIVITY;
  if (current < 0) current = -current;

  power = vin * current;

  // ── Relay Control ────────────────────────────────────────────
  // Priority: battery-full cutoff overrides overcurrent trip label
  bool batteryFull  = (vbat >= VBAT_FULL);
  bool relayTripped = (current > CURRENT_LIMIT);
  bool relayOpen    = batteryFull || relayTripped;  // relay opens for either reason

  String relayState;
  if (batteryFull) {
    relayState = "FULL";  // Battery fully charged – charger OFF
  } else if (relayTripped) {
    relayState = "TRIP";  // Overcurrent fault
  } else {
    relayState = "ON";    // Normal charging
  }

  if (relayOpen) {
    digitalWrite(RELAY_PIN, HIGH); // Active-LOW relay → HIGH = relay open (OFF)
  } else {
    digitalWrite(RELAY_PIN, LOW);  // LOW = relay closed (charging)
  }

  // ── Serial Debug ─────────────────────────────────────────────
  Serial.printf("Vin: %.1fV | Vbat: %.1fV | I: %.2fA | P: %.1fW | Relay: %s\n",
                vin, vbat, current, power, relayState.c_str());

  // ── LCD Display ──────────────────────────────────────────────
  lcd.setCursor(0, 0);
  lcd.print("Vi:");
  lcd.print(vin, 1);
  lcd.print("V ");

  lcd.setCursor(9, 0);
  lcd.print("I:");
  lcd.print(current, 2);

  lcd.setCursor(0, 1);
  lcd.print("Vb:");
  lcd.print(vbat, 1);
  lcd.print("V ");

  lcd.setCursor(9, 1);
  if (batteryFull) {
    lcd.print("FULL ");
  } else if (relayTripped) {
    lcd.print("TRIP ");
  } else {
    lcd.print("OK   ");
  }

  // ── Send to IoT Server ───────────────────────────────────────
  unsigned long now = millis();
  if (now - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = now;
    sendData(relayState);
  }

  delay(200); // Short loop delay (actual rate controlled by SEND_INTERVAL)
}
