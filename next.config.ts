import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // eBay serves listing thumbnails from its own image CDN. Remote patterns are
    // scoped to eBay's image hosts only; Inkora does not proxy or store images
    // (see docs/API_INTEGRATIONS.md — eBay image handling).
    remotePatterns: [{ hostname: "**.ebayimg.com" }],
  },
};

export default nextConfig;
