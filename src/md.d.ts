// Preloaded Skills are imported as text so they stay real files on disk that
// can be read and edited as Skills, rather than string literals in TypeScript.
// Enabled by the `Text` rule for **/*.md in wrangler.jsonc.
declare module "*.md" {
  const content: string;
  export default content;
}
