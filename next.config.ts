import type { NextConfig } from "next";

const config: NextConfig = {
  // pg is loaded by Node at runtime rather than bundled.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    },
  ],
};

export default config;
