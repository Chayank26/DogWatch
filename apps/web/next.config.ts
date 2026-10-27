import type { NextConfig } from 'next';
// Operator-controlled server destination. Never accept proxy targets from requests.
const apiOrigin = process.env.DOGWATCH_API_ORIGIN ?? 'http://127.0.0.1:4000';
const url = new URL(apiOrigin);
if (
  url.origin !== apiOrigin ||
  url.username ||
  url.password ||
  !['http:', 'https:'].includes(url.protocol)
)
  throw Error('DOGWATCH_API_ORIGIN must be an HTTP(S) origin');
const config: NextConfig = {
  async rewrites() {
    return [
      { source: '/auth/:path*', destination: `${apiOrigin}/auth/:path*` },
    ];
  },
};
export default config;
