export function errorHandler(err, req, res, next) {
  // error handling middleware
  res.status(500).send(err.message);
}
