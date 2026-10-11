// Which hostnames must a local agent refuse to fetch. One module so the
// bridge's attachment path and the harness's FETCH tool cannot drift — the
// guard is only as good as its weakest caller.
//
// True for loopback, link-local and RFC1918 addresses. The URL parser has
// already normalised integer, hex and octal spellings of an IPv4 address to
// dotted-quad by the time this sees the hostname, so those need no case of
// their own. A bare domain name is not classified here — that would need DNS
// resolution — so this blocks the literal-IP SSRF attempts, which is what a
// URL in a chat message looks like.
const privateV4 = (a, b) =>
  a === 0 || a === 127 || a === 10                     // this-host, loopback, private
  || (a === 169 && b === 254)                          // link-local incl. cloud metadata
  || (a === 192 && b === 168)
  || (a === 172 && b >= 16 && b <= 31);                // 172.16.0.0/12

export function isPrivateHost(host) {
  let h = String(host).toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::' || h === '::1') return true;                 // unspecified / loopback
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;               // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;               // fc00::/7 unique-local
  // An IPv4-mapped address. The URL parser rewrites ::ffff:127.0.0.1 into the
  // hex form ::ffff:7f00:1, so both spellings have to be unwrapped to the IPv4
  // address they carry — which a plain dotted-quad match never sees.
  const mapped = h.startsWith('::ffff:') ? h.slice(7) : '';
  if (mapped.includes('.')) return isPrivateHost(mapped);
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
  if (hex) {
    const bits = (hex[1].padStart(4, '0') + hex[2].padStart(4, '0'));
    return privateV4(parseInt(bits.slice(0, 2), 16), parseInt(bits.slice(2, 4), 16));
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  return privateV4(Number(m[1]), Number(m[2]));
}
