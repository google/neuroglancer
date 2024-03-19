# Using vite to bundle a dependent project

## Required configuration

### HTML assets for auth redirect

`.html` files that are used as auth redirect pages for the brainmaps and bossDB
data sources need to have stable names. This can be accomplished using the
`build.rollupOptions.output.assetFileNames` option:

```javascript
{
  build: {
    assetsDir: "",
    rollupOptions: {
      output: {
        format: "esm",
        assetFileNames: (assetInfo) => {
          const { name } = assetInfo;
          if (name.endswith(".html")) {
            return "[name][extname]";
          }
          return "[name]-[hash][extname]";
        },
      },
    },
  },
}
```

## Limitations

- The method described above for assigning stable names for the `.html` auth
  redirect pages does not work for the dev server. Consequently, the brainmaps
  and bossDB data sources will not work with the vite dev server.
