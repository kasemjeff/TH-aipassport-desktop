// Dashboard sync helper: stages the project token for upload.
import { readFileSync, writeFileSync } from 'node:fs';

const token = (readFileSync('.env', 'utf8').match(/^TOKEN=(.+)$/m) ?? [])[1]?.trim() ?? '';
writeFileSync('upload.txt', `token=${token}\n`);
console.log('sync: staged upload.txt');
