/** @type {import('next').NextConfig} */
const backendUrl = process.env.BACKEND_URL || 'http://localhost:8080';

const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
