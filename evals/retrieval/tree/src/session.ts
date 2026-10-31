export function expireSession(id) {
  // session expiry and logout
  return revoke(id);
}
