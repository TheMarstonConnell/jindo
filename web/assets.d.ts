// Bun's bundler resolves SVG imports to URLs at build time.
declare module "*.svg" {
  const url: string;
  export default url;
}
