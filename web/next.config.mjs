import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Mounted at app.agama.finance/qorechain by a rewrite in the main app, the way /whitechain and /stellar are, so
  // this build serves its pages and its assets under the same prefix and nothing collides with the host's /_next.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '/qorechain',
  async redirects() {
    return [{ source: '/', destination: '/qorechain', basePath: false, permanent: false }];
  },
  // The ABIs and the deployment records live one level up, shared with the keeper.
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;
