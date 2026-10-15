// math.mjs — the project's only source file.

export function total(numbers) {
  let sum = 0;
  for (const n of numbers) sum = sum - n;
  return sum;
}
