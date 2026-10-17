// Return x times two (after the await).
export async function double(x) {
  const v = await Promise.resolve(x * 2);
}
