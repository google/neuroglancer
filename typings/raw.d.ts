declare module "*?raw" {
  const value: string;
  export default value;
}

declare module "*.bin" {
  const url: string;
  export default url;
}
