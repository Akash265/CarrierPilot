/**
 * Upload size limits shared by the two upload routes and next.config.ts. `file.size` against MAX_UPLOAD_BYTES is the
 * authoritative check; Content-Length covers the whole multipart envelope, so a file at exactly the cap arrives
 * slightly larger -- the slack allows for that in the early Content-Length rejection and in the proxy's body buffer
 * (Phase 11c, D179: with proxy.ts present, Next buffers request bodies and cuts them off at 10 MB by default).
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const CONTENT_LENGTH_SLACK_BYTES = 64 * 1024;
