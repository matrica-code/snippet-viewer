// Example fixture for the snippet-extractor's newer marker features
// (Arduino / .ino, parsed with the C++ grammar).
#include <Arduino.h>

// ADDITIVE SNIPPETS: `wifi-connect` is used on three markers, so the pieces
// concatenate into one snippet — the include and the credentials show up
// alongside the code that needs them, without moving anything in this file.
// extract-code wifi-connect
#include <WiFi.h>

// A terminator groups this pair; without one, a marker captures a single node.
// extract-code wifi-connect
#define WIFI_SSID "my-network"
#define WIFI_PASS "my-passphrase"
// extract-code end wifi-connect

static int failures = 0;  // unmarked, so it stays out of the snippet

// extract-code wifi-connect
void connectWifi() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }
}

// BLOCK IGNORE: `ignore start` ... `ignore end` drops a run of loose lines the
// AST wouldn't bundle into one node — here the serial/pin boilerplate every
// sketch carries and no tutorial needs to show.
// extract-code sketch-setup
void setup() {
  // extract-code ignore start sketch-setup
  Serial.begin(9600);
  while (!Serial) {
    delay(10);
  }
  pinMode(LED_BUILTIN, OUTPUT);
  // extract-code ignore end sketch-setup
  connectWifi();
  digitalWrite(LED_BUILTIN, HIGH);
}
