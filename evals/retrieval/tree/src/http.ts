export function handleError(err) {
  // error handling for the HTTP layer
  return { status: 500, message: err.message };
}
