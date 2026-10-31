// @ts-check
// The keyring: the public halves this build trusts.
//
// The feed is signed by a key whose private half never leaves the release
// machine (a CI secret). Only the public half is here, in the source, so a
// compromised feed cannot introduce a key of its own — a feed that could
// would be a feed that could be replaced wholesale.
//
// Rotation has two halves, and both are releases:
//   - the release lane signs with the NEXT key before the app trusts it, so
//     the app is never the first to know about a key;
//   - the app drops a key when it retires it, and a feed signed only by a
//     retired key is refused.
//
// The format is the raw 32-byte ed25519 public key in base64. The SPKI
// wrapper is added by the verifier, so the keyring holds the key itself and
// not an encoding of it — one less thing to get wrong when a key is rotated.
//
// The private half for the key below is in `~/.aipass/app/release-key.pem`
// (owner-only, outside the repository). It belongs in the release lane's
// secrets, not in git: `docs/UPDATE_DESIGN.md` says where it goes.
export const KEYRING = [
  // The first release key. Rotating means adding the next one here and
  // signing with it, then dropping this one in a later release.
  { id: 'aipass-release-2026', publicKey: 'ESGubhBSjm/bnRu2n2CmlvINCcXJyl6hATYizjBLy04=' },
];

/** The keyring's ids, for a log line that says which key signed a feed. */
export const keyIds = () => KEYRING.map((k) => k.id);
