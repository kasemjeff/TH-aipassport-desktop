export function refreshToken() {
  // renew the login token for the session
  return issueToken();
}
export const TOKEN_TTL = 3600;
