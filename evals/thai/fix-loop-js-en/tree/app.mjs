// Return the last three elements of an array.
// Arrays shorter than three come back whole.
export function lastThree(arr) {
  const out = [];
  for (let i = arr.length - 3; i < arr.length - 1; i++) out.push(arr[i]);
  return out;
}
