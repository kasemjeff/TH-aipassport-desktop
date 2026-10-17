fileIn ใน app.mjs ต่อสตริงตรง ๆ ทำให้ได้ path เพี้ยน เช่น dir ที่ลงท้ายด้วย / จะได้ // ซ้อน

แก้ให้ใช้ path.join จากโมดูล node:path แล้วตรวจด้วย node check.mjs ให้ผ่าน (ห้ามแก้ check.mjs)
