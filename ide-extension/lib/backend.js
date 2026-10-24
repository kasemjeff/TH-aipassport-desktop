'use strict';
// The transport to the local harness backend: one JSON-RPC call, one event
// stream.
//
// It lives in its own file, and not in extension.js, for two reasons: the
// extension host is the only thing that may hold the credential, and a file
// that does not need VS Code can be driven by a plain Node script — which is
// what the self-test does.
//
// The rule this file exists to keep: the loopback token rides a request to
// 127.0.0.1 and to nothing else. The host is a constant, not a parameter, so
// there is no code path that could send it somewhere.
const http = require('node:http');
const protocol = require('./protocol.js');

/**
 * A refusal the panel can say something useful about.
 *
 * The kinds are the ones the reader can act on: the backend is not there, the
 * token was refused, the call was refused by the backend itself.
 */
class BackendError extends Error {
  /**
   * @param {string} kind 'offline' | 'unauthorized' | 'refused' | 'unknown'
   * @param {string} message
   * @param {string|null} [stage]
   */
  constructor(kind, message, stage = null) {
    super(message);
    this.name = 'BackendError';
    this.kind = kind;
    this.stage = stage;
  }
}

/**
 * One HTTP call to the backend, over the loopback.
 *
 * `node:http` rather than `fetch`: the same client has to read an SSE stream
 * frame by frame, and one transport for both keeps the loopback and the
 * bearer header in one place.
 *
 * @param {{port: number, method: string, path: string, headers?: object, body?: string, timeoutMs?: number}} input
 * @returns {Promise<{status: number, text: string}>}
 */
function requestOnce({ port, method, path: reqPath, headers = {}, body = null, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      // The literal loopback. The token rides this request, so the host is
      // not a parameter: there is no code path that sends it anywhere else.
      host: protocol.LOOPBACK_HOST,
      port,
      path: reqPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    // A run can take minutes, so the timeout is the caller's decision: a
    // `run` call waits for the whole thing, and a `status` call does not.
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('หมดเวลาที่รอ backend')); });
    }
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * The client for the local harness backend.
 *
 * Two transports, and both carry the token — the desktop law applies to every
 * client, not only to the window (desktop/AGENTS.md, "Transport"): `/rpc` in
 * the `authorization` header, `/events` in the same header (the backend
 * accepts a header bearer on the stream as well as `?token=`).
 *
 * @param {object} input
 * @param {number} input.port
 * @param {string|null} input.token
 * @param {string} input.project
 * @param {(frame: {event: string, id: string|null, data: string}) => void} input.onEvent
 * @param {(state: {online: boolean, reason?: string}) => void} input.onState
 */
function createBackend({ port, token, project, onEvent, onState }) {
  let streamReq = null;
  let closed = false;
  let lastSeq = 0;
  let backoff = 500;
  let retryTimer = null;

  /**
   * One RPC call.
   *
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  async function rpc(method, params = {}) {
    let res;
    try {
      res = await requestOnce({
        port,
        method: 'POST',
        path: '/rpc',
        headers: protocol.buildRpcHeaders({ token, project }),
        body: protocol.buildRpcBody(method, params),
        // A run answers when the run is over; the timeout is the caller's.
        timeoutMs: method === 'run' ? 0 : 20000,
      });
    } catch (err) {
      throw new BackendError('offline', `ไม่ติดต่อ backend ที่ ${protocol.buildRpcUrl(port)} ได้ — ${err?.code ?? err?.message ?? err}`);
    }
    let parsed = null;
    try { parsed = JSON.parse(res.text); } catch { /* something else answered */ }
    if (res.status === 401) {
      throw new BackendError('unauthorized', 'backend ปฏิเสธ token — ทั้ง backend และ extension ต้องอ่าน token ไฟล์เดียวกัน');
    }
    if (!parsed) {
      throw new BackendError('unknown', `ที่ ${protocol.buildRpcUrl(port)} ไม่ใช่ aipass backend`);
    }
    if (!parsed.ok) {
      throw new BackendError('refused', String(parsed.error ?? 'backend ปฏิเสธคำสั่ง'), parsed.stage ?? null);
    }
    return parsed.result;
  }

  /**
   * Open the event stream and keep it open.
   *
   * A reconnect carries the last sequence number, and the backend replays
   * exactly what this listener missed (rpc.mjs, the `/events` route) — so a
   * dropped stream costs a pause, not the middle of a run.
   */
  function open() {
    if (closed) return;
    const headers = { accept: 'text/event-stream' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (lastSeq) headers['last-event-id'] = String(lastSeq);
    const req = http.request({
      host: protocol.LOOPBACK_HOST,
      port,
      path: '/events',
      method: 'GET',
      headers,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        retry(res.statusCode === 401 ? 'unauthorized' : 'refused');
        return;
      }
      backoff = 500;
      onState({ online: true });
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += String(chunk).replace(/\r\n/g, '\n');
        let at = buffer.indexOf('\n\n');
        while (at !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const frame = protocol.parseSseBlock(block);
          if (frame) {
            if (frame.id && Number.isFinite(Number(frame.id))) lastSeq = Number(frame.id);
            onEvent(frame);
          }
          // The place of the next frame is looked up again: the buffer just
          // lost the frame that was read, and a stale offset here would cut
          // the same bytes over and over — an endless loop that freezes the
          // extension host.
          at = buffer.indexOf('\n\n');
        }
      });
      res.on('end', () => retry('closed'));
      res.on('error', () => retry('error'));
    });
    req.on('error', () => retry('error'));
    req.end();
    streamReq = req;
  }

  /**
   * Wait, then open the stream again.
   *
   * The wait grows, and the reset happens on a stream that opened — so a
   * backend that is down for a minute is not asked a hundred times a second.
   *
   * @param {string} reason
   */
  function retry(reason) {
    if (closed) return;
    onState({ online: false, reason });
    const wait = Math.min(backoff, 15000);
    backoff = Math.min(backoff * 2, 15000);
    retryTimer = setTimeout(open, wait);
    // The timer must not keep the extension host alive on its own.
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  return {
    port,
    rpc,
    start: open,
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { streamReq?.destroy(); } catch { /* already gone */ }
      streamReq = null;
    },
  };
}

module.exports = { BackendError, requestOnce, createBackend };
