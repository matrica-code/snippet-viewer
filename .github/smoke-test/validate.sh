#!/usr/bin/env bash
# Validates a snippets.json produced by the snippet-extractor smoke test.
#
# Usage: validate.sh <snippets.json> <mode>
#   mode = ts | java | cpp | all   (which language's snippets to require)
#
# Asserts the expected keys exist, each carries its decorator/annotation token,
# the `ignore` marker stripped the planted secret, and the total count matches.
set -euo pipefail

FILE="${1:?usage: validate.sh <snippets.json> <ts|java|cpp|all>}"
MODE="${2:?usage: validate.sh <snippets.json> <ts|java|cpp|all>}"

test -f "$FILE" || { echo "❌ $FILE was not produced"; exit 1; }
jq -e . "$FILE" >/dev/null || { echo "❌ $FILE is not valid JSON"; exit 1; }

fail=0
assert_key() { # <key> <substring that must appear in its value>
  local key="$1" needle="$2" val
  val=$(jq -r --arg k "$key" '.[$k] // ""' "$FILE")
  if [ -z "$val" ]; then
    echo "❌ missing snippet: $key"; fail=1; return
  fi
  if ! printf '%s' "$val" | grep -qF -- "$needle"; then
    echo "❌ snippet '$key' is missing expected token: $needle"; fail=1; return
  fi
  echo "✅ $key (contains '$needle')"
}

want=0
if [ "$MODE" = "ts" ] || [ "$MODE" = "all" ]; then
  echo "── TypeScript (standard, non-UI class) ──────"
  assert_key "ts-class@FuturesModel.ts"    "@kosModel"        # stacked class decorators
  assert_key "ts-class@FuturesModel.ts"    "@kosFutureAware"  # ...all of them kept
  assert_key "ts-method@FuturesModel.ts"   "@kosFuture"       # decorated method
  assert_key "ts-property@FuturesModel.ts" "get progress"     # getter property
  echo "── TypeScript (React / TSX) ─────────────────"
  assert_key "react-component@Counter.tsx" "function Counter"       # function component
  assert_key "react-hook@Counter.tsx"      "function useCounter"    # custom hook
  assert_key "react-props@Counter.tsx"     "interface CounterProps" # props type
  want=$((want + 6))
fi

if [ "$MODE" = "java" ] || [ "$MODE" = "all" ]; then
  echo "── Java ─────────────────────────────────────"
  assert_key "java-class@WidgetService.java"    "@Service"    # annotated class
  assert_key "java-property@WidgetMembers.java" "@Autowired"  # annotated field
  assert_key "java-method@WidgetMembers.java"   "@GetMapping" # annotated method
  want=$((want + 3))
fi

if [ "$MODE" = "cpp" ] || [ "$MODE" = "all" ]; then
  echo "── C / C++ / Arduino ────────────────────────"
  assert_key "c-struct@sensor.c"          "SensorReading"    # typedef'd struct
  assert_key "c-function@sensor.c"        "to_fahrenheit"    # free function
  assert_key "cpp-class@RingBuffer.cpp"   "class RingBuffer" # whole class body
  assert_key "cpp-method@RingBuffer.cpp"  "RingBuffer::push" # out-of-class method
  assert_key "ino-setup@Blink.ino"        "void setup"       # Arduino entry points
  assert_key "ino-loop@Blink.ino"         "void loop"
  want=$((want + 6))
fi

echo "── ignore marker ────────────────────────────"
if grep -qF "sk-do-not-leak" "$FILE"; then
  echo "❌ 'extract-code ignore' failed — secret leaked into a snippet"; fail=1
else
  echo "✅ ignored content was stripped (no secret in output)"
fi

echo "── marker directives stripped ───────────────"
if jq -r '.[]' "$FILE" | grep -qF "extract-code"; then
  echo "❌ a snippet leaked a raw 'extract-code' marker directive"; fail=1
else
  echo "✅ no marker directives leaked into any snippet"
fi

count=$(jq 'length' "$FILE")
echo "── total snippets: $count (expected $want) ──────────"
[ "$count" -eq "$want" ] || { echo "❌ expected $want snippets, got $count"; fail=1; }

[ "$fail" -eq 0 ] || { echo "Smoke test FAILED"; exit 1; }
echo "All assertions passed — the published action attached a correct snippets.json"
