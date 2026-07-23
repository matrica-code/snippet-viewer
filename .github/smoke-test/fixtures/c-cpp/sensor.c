// Smoke-test fixture for the snippet-extractor (C).
// Demonstrates a STRUCT marker (typedef, trailing semicolon kept) and a
// FUNCTION marker.
#include <stdio.h>

// extract-code c-struct
typedef struct {
  int id;
  double celsius;
} SensorReading;

// extract-code c-function
double to_fahrenheit(const SensorReading *reading) {
  return reading->celsius * 9.0 / 5.0 + 32.0;
}
