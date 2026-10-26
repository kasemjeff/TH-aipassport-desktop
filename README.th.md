# ✳ aipass

[English](./README.md) · **ไทย**

> **หน้าต่างเดสก์ท็อปและ agent harness สำหรับ [de.aipass.net](https://de.aipass.net/chat)** —
> agent ที่แก้ไฟล์ได้และดูได้ทุกขั้นตอน หยุด/อนุมัติ/ทำงานต่อได้ ผ่าน bridge ที่คุยกับเว็บ
> ด้วยแท็บเบราว์เซอร์ที่คุณล็อกอินอยู่แล้ว

> **โปรเจกต์ชุมชนอิสระ** ไม่ได้เกี่ยวข้อง ไม่ได้รับการรับรอง และไม่ได้สนับสนุนโดยผู้ให้บริการ
> de.aipass.net ดู [TRADEMARK.md](./TRADEMARK.md)

## สถานะ

- เวอร์ชัน **pre-1.0** และยังไม่มี installer/GitHub Release ที่เผยแพร่ — ติดตั้งจาก source
  ตามด้านล่าง
- CI รันชุดทดสอบบน Ubuntu, macOS และ Windows ด้วย Node 20, 22 และ 24
- Rust shell มี unit test บน Ubuntu และ Windows, coverage floor, docs link check,
  eval-set lint และ CodeQL ผ่าน
- Node 20 หมดอายุการสนับสนุน (EOL) แล้ว แต่ยังอยู่ใน CI เพื่อความเข้ากันได้กับ
  `engines: >=20`; แนะนำ Node 22 หรือ 24 สำหรับการพัฒนา
- สิ่งที่ยังไม่พร้อมอยู่ใน [ROADMAP.md](./ROADMAP.md) และข้อจำกัดที่รู้อยู่แล้วอยู่ใน
  [SECURITY.md](./SECURITY.md) กับ [docs/MATURITY.md](./docs/MATURITY.md)

## สิ่งที่ repo นี้มี

- **`desktop/`** — หน้าต่างแอป: โปรเจกต์, รายการแชท, transcript ที่ resume/fork ได้,
  diff ต่อไฟล์ให้อนุมัติ, plan card, โหมดสิทธิ์, file panel, playbook และ plugin
- **`aipass-bridge/harness/`** — แกน agent: loop, tools, protocol, session บนดิสก์,
  compaction, permission/path rules, WAF, provider, plugin และ MCP
- **`aipass-bridge/`** — bridge, Chrome extension และ CLI ที่สืบต่อจาก
  [niawjunior/aipass-bridge](https://github.com/niawjunior/aipass-bridge)

หน้าต่าง, CLI และ agent ใช้ `~/.aipass/settings.json` ไฟล์เดียวกัน ค่าที่เปลี่ยนจึงมีผล
ทุกที่ทันที

## ติดตั้งจาก source

ต้องมี:

| สิ่งที่ต้องมี | เหตุผล |
|---|---|
| **Node ≥ 20** (แนะนำ 22/24) | ใช้ `node:*` builtins เท่านั้น ไม่ต้องติดตั้ง dependency |
| **Chrome หรือ Chromium** | extension เป็นส่วนเดียวที่แตะ session ของคุณ |
| **บัญชี de.aipass.net** | แท็บที่ล็อกอินอยู่คือ credential |

```bash
git clone https://github.com/kasemjeff/TH-aipassport-desktop.git
cd TH-aipassport-desktop
npm run setup
```

`setup` จะตรวจ Node, สร้าง `~/.aipass/` และ token, ใส่ `aipass` ใน PATH, คัดลอก token,
เริ่ม bridge และเปิดหน้าเว็บ/หน้า extensions ให้

### สองขั้นตอนในเบราว์เซอร์ (ครั้งเดียว)

1. เปิด `chrome://extensions` → **Developer mode** → **Load unpacked** →
   เลือกโฟลเดอร์ `aipass-bridge/extension`
2. เปิด popup ของ extension → **Advanced** → **Loopback token** → วางเนื้อหา
   `~/.aipass/.token` → บันทึก แล้วเปิด <https://de.aipass.net/chat> ล็อกอินและเปิดแท็บนั้นไว้

ตรวจสถานะด้วย `aipass status` และแก้ปัญหาด้วย `aipass doctor`

### หน้าต่างเดสก์ท็อป

```bash
npm run desktop       # เปิดหน้าต่างในเบราว์เซอร์ที่ 127.0.0.1:8790
npm run tauri:build   # build installer: NSIS / .app/.dmg / deb/appimage
```

การ build native ต้องมี Rust toolchain และ Tauri CLI เพิ่ม ดู
[docs/INSTALL.md](./docs/INSTALL.md) และ [desktop/README.md](./desktop/README.md)

## คำสั่งที่ใช้บ่อย

```bash
npm test              # ชุดทดสอบทั้งหมด
npm run typecheck     # ไฟล์ที่เปิด // @ts-check
npm run docs:check    # ลิงก์ Markdown ที่เป็น relative
npm run coverage:gate # coverage floor ต่อไฟล์
npm run check         # ก่อน push: lint + test + qa + coverage + docs
npm run doctor        # ตรวจเครื่องและ service
```

## เอกสาร

เริ่มที่ [docs/README.md](./docs/README.md) โดยเฉพาะ:

- [ติดตั้ง](./docs/INSTALL.md)
- [แก้ปัญหา](./docs/TROUBLESHOOTING.md)
- [คำถามที่พบบ่อย](./docs/FAQ.md)
- [การย้ายจาก upstream](./docs/MIGRATION.md)
- [สถาปัตยกรรม harness](./docs/HARNESS_DESIGN.md)
- [การ release](./docs/RELEASE.md)
- [ความปลอดภัย](./SECURITY.md)

## ผู้ร่วมพัฒนา

**kasemjeff** เป็นผู้ร่วมพัฒนาเพียงคนเดียวของ repo นี้ ดู [AUTHORS.md](./AUTHORS.md)

โค้ด bridge, extension และ CLI สืบต่อจาก upstream ซึ่งมี **niawjunior**, **Pheem49**
และผู้เขียนคนอื่น ๆ เป็นเจ้าของลิขสิทธิ์เดิม ข้อความลิขสิทธิ์อยู่ใน
[LICENSE](./LICENSE) และ [NOTICE](./NOTICE) ไม่ได้ถูกลบ

## ร่วมพัฒนา

1. อ่าน [CONTRIBUTING.md](./CONTRIBUTING.md) และ [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
2. ทุก commit ต้องมี `Signed-off-by` — ใช้ `git commit -s`
3. รัน `npm test`, `npm run typecheck`, `npm run agents:lint` และ `npm run docs:check`
4. เพิ่ม test ทุกครั้งที่เปลี่ยนพฤติกรรม และรักษา core ให้ไม่มี runtime dependency

## ความปลอดภัย

อย่าเปิด issue สาธารณะสำหรับช่องโหว่ ให้ใช้
[private vulnerability reporting](https://github.com/kasemjeff/TH-aipassport-desktop/security/advisories/new)
และอ่าน [SECURITY.md](./SECURITY.md)

## สนับสนุนและติดต่อ

- [GitHub Discussions](https://github.com/kasemjeff/TH-aipassport-desktop/discussions)
- [SUPPORT.md](./SUPPORT.md)
- [PRIVACY.md](./PRIVACY.md) — ไม่มี telemetry
- [GOVERNANCE.md](./GOVERNANCE.md) และ [MAINTAINERS.md](./MAINTAINERS.md)

## สัญญาอนุญาต

[MIT License](./LICENSE) — ซอฟต์แวร์ bundled บุคคลที่สามดู
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
