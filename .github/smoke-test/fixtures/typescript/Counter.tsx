// Smoke-test fixture for the snippet-extractor (React / TSX).
// Validates markers on a props type, a custom hook, and a function component.
import { useCallback, useState } from "react";

// extract-code react-props
export interface CounterProps {
  initial?: number;
  label?: string;
}

// extract-code react-hook
function useCounter(initial = 0) {
  const [count, setCount] = useState(initial);
  const increment = useCallback(() => setCount((c) => c + 1), []);
  return { count, increment };
}

// extract-code react-component
export function Counter({ initial = 0, label = "Count" }: CounterProps) {
  const { count, increment } = useCounter(initial);
  return (
    <button type="button" onClick={increment}>
      {label}: {count}
    </button>
  );
}
