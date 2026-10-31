# Caching notes

We cache responses in memory. A stale response is dropped when the process
restarts. The invalidation code lives elsewhere.
