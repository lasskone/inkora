import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Marketplace and supplier CDNs serve product imagery. Remote patterns are
    // scoped to these hosts only; Inkora does not proxy or store images
    // (see docs/API_INTEGRATIONS.md — image handling).
    remotePatterns: [
      { hostname: "**.ebayimg.com" },
      { hostname: "**.cjdropshipping.com" },
    ],
  },
};

export default nextConfig;
