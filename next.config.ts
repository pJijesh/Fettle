import type { NextConfig } from "next";
import { PERMISSIONS_POLICY } from "./src/lib/csp";

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
        { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      ],
    },
  ],
};

export default config;
