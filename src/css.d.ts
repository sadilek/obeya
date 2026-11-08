// A stylesheet imported `with { type: 'text' }` (src/server/demo-page.ts): its text, which `bun build --compile` embeds.
declare module '*.css' {
  const text: string;
  export default text;
}
