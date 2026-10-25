// Bun reads a Markdown import as its text (see src/recipe.ts); TypeScript needs telling.
declare module "*.md" {
  const text: string;
  export default text;
}
