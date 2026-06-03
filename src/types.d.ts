// Bun supports `import x from "./file.css" with { type: "text" }` to load
// arbitrary text files as a string at runtime. TypeScript needs an ambient
// declaration to know the import resolves to a string.
declare module "*.css" {
  const content: string;
  export default content;
}
