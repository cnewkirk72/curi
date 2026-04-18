/** @type {import('next').NextConfig} */
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
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
