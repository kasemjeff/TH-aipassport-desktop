// true ถ้าสตริงเป็นเลขฐานสิบหก (0-9, a-f) ยาว 1 ตัวขึ้นไป
export const isHex = (s) => /[0-9a-f]+/i.test(s);
