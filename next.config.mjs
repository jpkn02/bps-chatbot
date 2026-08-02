/** @type {import('next').NextConfig} */
const nextConfig = {
  // Make sure system-prompt.txt gets bundled with the deployed API route,
  // otherwise it exists locally but is missing on Vercel.
  outputFileTracingIncludes: {
    "/api/chat": ["./app/api/chat/system-prompt.txt"],
  },
};

export default nextConfig;
