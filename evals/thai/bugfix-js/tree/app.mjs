// app.mjs — ตรวจคำตอบของผู้ใช้
export function checkAnswer(input) {
  if (input === 'ถูกต้อง') return 'ok';
  return 'wrong';
}
