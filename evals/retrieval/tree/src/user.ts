export function saveUser(u) {
  // บันทึกข้อมูลผู้ใช้ลงฐานข้อมูล
  return db.save(u);
}
