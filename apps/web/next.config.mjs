/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      // Venues + ticketing sources we ingest images from.
      // Expand as scrapers are added.
      { protocol: 'https', hostname: '**.shotgun.live' },
      { protocol: 'https', hostname: '**.publicrecords.nyc' },
      { protocol: 'https', hostname: '**.nowadays.nyc' },
      { protocol: 'https', hostname: '**.elsewherebrooklyn.com' },
      { protocol: 'https', hostname: '**.supabase.co' },
      { protocol: 'https', hostname: 'images.squarespace-cdn.com' },
      { protocol: 'https', hostname: 'res.cloudinary.com' },
    ],
  },
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
