// Smoke-test fixture for the snippet-extractor (Arduino / .ino, C++ grammar).
// Demonstrates FUNCTION-level markers on the two canonical sketch entry points.
#include <Arduino.h>

const int LED_PIN = 13;

// extract-code ino-setup
void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(9600);
}

// extract-code ino-loop
void loop() {
  digitalWrite(LED_PIN, HIGH);
  delay(500);
  digitalWrite(LED_PIN, LOW);
  delay(500);
}
