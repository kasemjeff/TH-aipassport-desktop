// คืนสมาชิก 3 ตัวท้ายของ array
// ถ้า array สั้นกว่า 3 ให้คืนทั้งหมด
export function lastThree(arr) {
  const out = [];
  for (let i = arr.length - 3; i < arr.length - 1; i++) out.push(arr[i]);
  return out;
}
