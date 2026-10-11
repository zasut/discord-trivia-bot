// All randomness goes through here so tests can make boards and choice order
// deterministic with setRng(). Production code never touches Math.random() directly.

let source = Math.random;

export function setRng(fn) {
  source = fn;
}

export function resetRng() {
  source = Math.random;
}

// Float in [0, 1).
export function random() {
  return source();
}

// Integer in [0, n).
export function randomInt(n) {
  return Math.floor(random() * n);
}

// One random element, or undefined for an empty array.
export function pick(items) {
  return items[randomInt(items.length)];
}

// Fisher-Yates. Returns a new array and leaves the input alone.
export function shuffle(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
