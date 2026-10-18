// @ts-check
// What may ride along with a chat as an attachment, and the mime names local
// files map to. One table here so three surfaces cannot drift: the bridge's
// validation of incoming parts, the desktop's staged uploads, and the agent's
// ATTACH tool.
import path from 'node:path';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** @type {Record<string, string>} */
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

/** @param {string} name @returns {string} */
export const mimeOf = (name) =>
  MIME_BY_EXT[path.extname(String(name)).toLowerCase()] ?? 'application/octet-stream';

// What may be attached to a message. Images go to vision models; the document
// types are what the web UI's own file picker offers. Anything else is refused
// at the edge rather than uploaded and rejected upstream, where the error is
// vaguer.
export const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  // Video: the upstream may or may not look inside one, but refusing it here
  // hides the whole attachment path behind a vaguer upstream error. It is
  // trimmed to the byte cap like everything else, so nothing unbounded rides
  // along.
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

/** @param {string} type @param {string} kind @returns {boolean} */
export const isAllowedAttachment = (type, kind) =>
  kind === 'image' ? type.startsWith('image/') : type.startsWith('image/') || DOCUMENT_TYPES.has(type);
