// Unit tests for the SSRF guard. The redirect behaviour cannot be driven
// through the HTTP surface — a test server on this machine is itself on a
// private address, which the very first check refuses — so the guard's own
// functions are exercised directly, with the request stubbed per hop.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.AIPASS_PORT = '0'; // import starts the server; a random port collides with nothing
const { isPrivateHost, hostResolvesPrivate, fetchRemoteAsDataUri, server } = await import('../bridge/server.mjs');
const { pinnedGet, resolveVetted } = await import('../bridge/private-hosts.mjs');

// The imported server holds the event loop open, which stalls the runner once
// this file shares a process pool with the others — release it when done.
after(() => { server.close(); server.closeAllConnections?.(); });

// A request that answers whatever the test wants, one hop at a time. The
// guard passes the vetted addresses in `opts`, so a test can also see what it
// decided to connect to.
const stub = (answers) => {
  const seen = [];
  const transport = async (url, opts) => {
    seen.push({ url: String(url), opts });
    return answers(seen.length, String(url));
  };
  transport.seen = seen;
  return transport;
};

test('isPrivateHost catches every spelling of a private address', () => {
  const refused = [
    'localhost', 'foo.localhost',
    '127.0.0.1', '0.0.0.0', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254',
    '::', '::1', '[::1]',
    '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '::ffff:7f00:1',      // mapped loopback, both spellings
    '::ffff:169.254.0.1', '::ffff:a9fe:1',                            // mapped link-local / metadata
    '::ffff:10.0.0.1', '::ffff:a00:1',                                // mapped RFC1918
    'fe80::1', 'fe90::1', 'febf::1',                                  // fe80::/10, not just the fe80 prefix
    'fc00::1', 'fd12:3456::1',                                        // fc00::/7
    // The ranges a name on the internet can point at, each with a service
    // behind it: CGNAT (and Tailscale's 100.x), the IETF protocol
    // assignments (192.0.0.192 is Oracle Cloud's metadata), the benchmark
    // range, and the reserved tail.
    '100.64.0.1', '100.100.100.200', '100.127.255.255',
    '192.0.0.192', '192.0.0.1',
    '198.18.0.1', '198.19.255.255',
    '240.0.0.1', '255.255.255.255',
    // An IPv4 address carried inside an IPv6 one: the compatible form
    // (::7f00:1) and the NAT64 form (64:ff9b::7f00:1) are 127.0.0.1, and
    // the bridge skips the DNS check for any host containing ':'.
    '::7f00:1', '[::7f00:1]', '64:ff9b::7f00:1', '[64:ff9b::7f00:1]',
  ];
  for (const host of refused) assert.ok(isPrivateHost(host), `${host} must be refused`);

  const allowed = [
    'example.com', 'de.aipass.net',
    '93.184.216.34', '172.32.0.1', '172.15.255.255', '169.253.0.1', '169.255.0.1',
    '100.63.255.255', '100.128.0.1', '192.1.0.1', '198.20.0.1', '239.255.255.255',
    '::ffff:93.184.216.34', '2001:db8::1', 'fe00::1', 'ff00::1',
  ];
  for (const host of allowed) assert.ok(!isPrivateHost(host), `${host} must be allowed`);
});

test('a redirect to a private address is refused at the hop, not followed', async () => {
  const transport = stub(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
  try {
    await fetchRemoteAsDataUri('http://93.184.216.34/x.png', 'image', { transport });
    assert.fail('the mapped redirect must be refused');
  } catch (err) {
    assert.match(err.message, /refusing private\/internal network fetch/);
    assert.equal(transport.seen.length, 1, 'only the public first hop is fetched');
  }
});

test('redirects to public targets are followed until the payload', async () => {
  const transport = stub((n) => (n === 1
    ? new Response(null, { status: 301, headers: { location: 'http://198.51.100.7/x.png' } })
    : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })));
  const uri = await fetchRemoteAsDataUri('http://93.184.216.34/x.png', 'image', { transport });
  assert.equal(uri, 'data:image/png;base64,AQID');
  assert.deepEqual(transport.seen.map((h) => h.url), ['http://93.184.216.34/x.png', 'http://198.51.100.7/x.png']);
});

test('a redirect chain that never settles is cut off', async () => {
  const transport = stub((n, url) => new Response(null, { status: 302, headers: { location: `${url}/more` } }));
  try {
    await fetchRemoteAsDataUri('http://93.184.216.34/x.png', 'image', { transport });
    assert.fail('an endless redirect must be cut off');
  } catch (err) {
    assert.match(err.message, /too many redirects/);
    assert.equal(transport.seen.length, 5, 'four hops followed, refused on the fifth');
  }
});

test('a redirect into a non-http scheme is refused', async () => {
  const transport = stub(() => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }));
  try {
    await fetchRemoteAsDataUri('http://93.184.216.34/x.png', 'image', { transport });
    assert.fail('a file: redirect must be refused');
  } catch (err) {
    assert.match(err.message, /unsupported protocol/);
  }
});

test('a name that resolves private is refused before anything is fetched', async () => {
  // `localhost.` — the trailing dot is the same name to the resolver and a
  // different one to the literal check, which is exactly the split the DNS
  // pass exists to close.
  const transport = stub(() => new Response(null, { status: 200 }));
  try {
    await fetchRemoteAsDataUri('http://localhost./x.png', 'image', { transport });
    assert.fail('a private-resolving name must be refused');
  } catch (err) {
    assert.match(err.message, /resolves to a private\/internal address/);
    assert.equal(transport.seen.length, 0, 'nothing was fetched');
  }
});

test('a name that cannot be resolved is refused — an unvetted name is not fetched', async () => {
  // RFC 2606 reserves .invalid: it never resolves, so the guard cannot know
  // where it points. Failing open here is what the rebinding attack needs.
  const transport = stub(() => new Response(null, { status: 200 }));
  try {
    await fetchRemoteAsDataUri('http://public.invalid/x.png', 'image', { transport });
    assert.fail('an unresolvable name must be refused');
  } catch (err) {
    assert.match(err.message, /could not be resolved/);
    assert.equal(transport.seen.length, 0, 'nothing was fetched');
  }
});

test('the request carries the address that was vetted, so the name is never resolved twice', async () => {
  // The whole point of the pin: the answer the guard checked is the address
  // the socket is made to. A name with a TTL of zero can answer public for
  // the check and private for the request — there is no second lookup left
  // for it to be fooled by.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('pinned');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await pinnedGet(`http://public.invalid:${port}/x`, {
      addresses: [{ address: '127.0.0.1', family: 4 }],
    });
    assert.equal(await res.text(), 'pinned', 'the request went to the vetted address');
    // The same URL without the pin is resolved for real, and .invalid does
    // not resolve — which is what makes the pin the difference.
    await assert.rejects(() => pinnedGet(`http://public.invalid:${port}/x`, {}), 'without the pin the name is resolved again');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('every answer is vetted, and the answers are the ones to pin to', async () => {
  // The connection picks one of the answers and the attacker picks which, so
  // a name that answers with a private address among public ones is refused.
  // `localhost` answers with a loopback on every stack, which is the one
  // private-resolving name every machine has without touching the network.
  const vetted = await resolveVetted('localhost');
  assert.equal(vetted.private, true, 'a private answer refuses the name');
  assert.ok(vetted.addresses.length > 0, 'the answers are there to be pinned to');
  assert.ok(vetted.addresses.every((a) => isPrivateHost(a.address)), 'and every one of them was vetted');
});

// DNS rebinding / split-horizon DNS: a bare domain that resolves to a private
// address is the classic way past a literal-IP guard. `localhost` is the one
// private-resolving name every machine has without touching the network.
test('a hostname that resolves private is refused; a DNS failure fails open', async () => {
  assert.equal(await hostResolvesPrivate('localhost'), true, 'localhost resolves to loopback');
  assert.equal(await hostResolvesPrivate('93.184.216.34'), false, 'a public literal is not private');
  // A literal private address answers without a DNS round trip, so the
  // resolve-private path is covered on a machine with no network at all.
  assert.equal(await hostResolvesPrivate('169.254.169.254'), true, 'the metadata address resolves private');
  assert.equal(await hostResolvesPrivate('10.1.2.3'), true, 'so does RFC1918');
  // RFC 2606 reserves .invalid — resolution must fail, and a failure means the
  // literal-IP check stays the only guard (fails open by design: the literal
  // check above already ran).
  assert.equal(await hostResolvesPrivate('definitely-not-a-host.invalid'), false, 'DNS failure must not block a fetch');
});

// A bare domain pointing at loopback or at the cloud metadata service is the
// way past a literal-IP guard, so the name is resolved and EVERY answer is
// checked before the fetch. The resolver is injected here — the same seam the
// request has — so the case is driven without a network.
test('a name that resolves to a private address is refused before anything is fetched', async () => {
  const transport = stub(() => new Response(null, { status: 200 }));
  try {
    await fetchRemoteAsDataUri('http://rebind.example/x.png', 'image', {
      transport,
      resolve: async () => ({ addresses: [{ address: '169.254.169.254', family: 4 }], private: true }),
    });
    assert.fail('a name resolving into the metadata range must be refused');
  } catch (err) {
    assert.match(err.message, /resolves to a private\/internal address/);
    assert.equal(transport.seen.length, 0, 'nothing was fetched');
  }
});

test('a name with one private answer among public ones is refused', async () => {
  // The connection picks one of the answers and the attacker picks which, so
  // a name that answers with both is refused — not just a name whose FIRST
  // answer is private.
  const transport = stub(() => new Response(null, { status: 200 }));
  try {
    await fetchRemoteAsDataUri('http://mixed.example/x.png', 'image', {
      transport,
      resolve: async () => ({
        addresses: [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
        private: true,
      }),
    });
    assert.fail('a name with a private answer among public ones must be refused');
  } catch (err) {
    assert.match(err.message, /resolves to a private\/internal address/);
    assert.equal(transport.seen.length, 0, 'nothing was fetched');
  }
});

test('a name that resolves public is fetched, and every answer is vetted', async () => {
  const transport = stub(() => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }));
  const uri = await fetchRemoteAsDataUri('http://public.example/x.png', 'image', {
    transport,
    resolve: async () => ({
      addresses: [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }],
      private: false,
    }),
  });
  assert.equal(uri, 'data:image/png;base64,AQ==');
  assert.equal(transport.seen.length, 1, 'the name was fetched once');
});

test('a name that could not be resolved is not remembered as one', async () => {
  // A failure is never cached: the throw happens before the entry is written,
  // so a name that could not be resolved a moment ago can be resolved now.
  let fail = true;
  const lookup = async () => {
    if (fail) throw new Error('ENOTFOUND');
    return [{ address: '10.9.8.7', family: 4 }];
  };
  await assert.rejects(() => resolveVetted('flaky.example', { lookup, cache: true }), 'the failure is the answer');
  fail = false;
  const second = await resolveVetted('flaky.example', { lookup, cache: true });
  assert.equal(second.private, true, 'the name was asked again — the failure was never cached');
});

// The announced size is enough to refuse on: a server that says it is
// sending 50 MB is refused before a byte of it is read, so a hostile URL
// cannot turn the bridge into a memory hose.
test('a hostile content-length is refused before the body is read', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) });
    res.end('x');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => pinnedGet(`http://public.invalid:${port}/huge.png`, {
        addresses: [{ address: '127.0.0.1', family: 4 }],
        maxBytes: 1024,
      }),
      /too large/,
    );
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
