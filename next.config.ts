import type { NextConfig } from "next";

const config: NextConfig = {
  // node:sqlite is a Node built-in; nothing to bundle.
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
