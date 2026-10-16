import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toArabicDigits,
  hasThaiDigits,
  findInvisibles,
  stripInvisibles,
  beYearsIn,
  thaiRatio,
  withoutTechnical,
} from '../harness/lang.mjs';

test('thai digits convert to arabic', () => {
  assert.equal(toArabicDigits('บทที่ ๑๒ หน้า ๒๕๖๙'), 'บทที่ 12 หน้า 2569');
  assert.equal(toArabicDigits('๑๒๓๔๕๖๗๘๙๐'), '1234567890');
  assert.equal(toArabicDigits('plain 42'), 'plain 42');
  assert.equal(hasThaiDigits('๑'), true);
  assert.equal(hasThaiDigits('1'), false);
});

test('invisibles are found, named, and stripped — but ZWNJ/ZWJ stay', () => {
  const found = findInvisibles('ก\u2002ข'.replace('\u2002', '\u200B'));
  assert.equal(found.length, 1);
  assert.equal(found[0].code, 'U+200B');
  assert.equal(found[0].name, 'zero-width space');

  const nbsp = findInvisibles('ก\u00A0ข');
  assert.equal(nbsp.length, 1);
  assert.equal(nbsp[0].space, true);

  // ZWNJ (U+200C) and ZWJ (U+200D) are legitimate Thai/emoji characters.
  assert.deepEqual(findInvisibles('ก\u200Cข'), []);
  assert.deepEqual(findInvisibles('ก\u200Dข'), []);

  assert.equal(stripInvisibles('สวัส\u200Bดี'), 'สวัสดี');
  assert.equal(stripInvisibles('a\u00A0b'), 'a b');
  assert.equal(stripInvisibles('\uFEFFx\u2060y'), 'xy');
});

test('buddhist-era years are spotted with their CE equivalents', () => {
  const years = beYearsIn('ปี พ.ศ. 2569 และ ค.ศ. 2026 และ 2499');
  assert.deepEqual(years, [
    { year: 2569, ce: 2026 },
    { year: 2499, ce: 1956 },
  ]);
  assert.deepEqual(beYearsIn('1234 9999 2026'), []);
  assert.deepEqual(beYearsIn('2569 2569'), [{ year: 2569, ce: 2026 }]);
});

test('thai ratio counts letters and ignores code, inline code, and URLs', () => {
  assert.equal(thaiRatio('สวัสดีครับ').ratio, 1);
  assert.equal(thaiRatio('hello world').ratio, 0);

  const mixed = thaiRatio('โค้ด ```const x = 1;``` ทำงาน ok ดู https://example.com บ้าง');
  assert.ok(mixed.ratio > 0.5, `expected mostly Thai, got ${mixed.ratio}`);
  assert.ok(mixed.latin <= 6, `code and URL should not count as Latin, got ${mixed.latin}`);

  const empty = thaiRatio('```only code```');
  assert.equal(empty.letters, 0);
  assert.equal(empty.ratio, 0);
});

test('withoutTechnical drops fenced code, inline code, urls, emails', () => {
  assert.equal(withoutTechnical('a `b` c').includes('b'), false);
  assert.equal(withoutTechnical('see https://x.dev/y now').includes('x.dev'), false);
  assert.equal(withoutTechnical('mail me a@b.co please').includes('a@b.co'), false);
});
