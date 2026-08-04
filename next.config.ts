import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin uses dynamic requires internally, which the bundler cannot
  // trace. Leaving it external keeps it out of the bundle and avoids a build
  // warning that turns into a runtime failure on Vercel.
  serverExternalPackages: ["firebase-admin"],
};

export default nextConfig;
