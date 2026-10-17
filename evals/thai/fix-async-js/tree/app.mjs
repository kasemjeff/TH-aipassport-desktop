// คืนค่า x คูณสอง (หลัง await)
export async function double(x) {
  const v = await Promise.resolve(x * 2);
}
