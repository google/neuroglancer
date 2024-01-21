# Using Parcel to bundle a dependent project

## Required configuration

### Subpath imports

As described in
https://github.com/parcel-bundler/parcel/issues/7840#issuecomment-1570728149, to
support Node.js subpath imports and exports that are used by Neuroglancer, the
following must be included in `package.json`:

```json
{
  "@parcel/resolver-default": {
    "packageExports": true
  }
}
```

### SVG inlining

Neuroglancer expects to embed SVG contents directly by importing ".svg?raw"
modules.

As this import syntax is not natively supported by Parcel, support must be added
explicitly in `.parcelrc`:

```javascript
  transformers: {
    "*.svg": ["...", "@parcel/transformer-inline-string"],
  },
```

### SVGO configuration

Parcel uses SVGO to minimize SVG assets. There are several issues that make the default SVGO configuration incompatible with Neuroglancer:

- removeViewBox: https://github.com/svg/svgo/issues/1128
- convertShapeToPath: https://github.com/svg/svgo/issues/1466

Thw following svgo configuration, which can be specified in `svgo.config.json`,
disables the problematic plugins:

```json
{
  "plugins": [
    {
      "name": "preset-default",
      "params": {
        "overrides": {
          "removeViewBox": false,
          "convertShapeToPath": false
        }
      }
    }
  ]
}
```

### HTML assets for auth redirect

`.html` files that are used as auth redirect pages for the brainmaps and bossDB
data sources need to have stable names. This is accomplished using the
`parcel-namer-rewrite` plugin with the following configuration in
`package.json`:

```json
{
  "parcel-namer-rewrite": {
    "rules": {
      "(.*).html": "$1.html"
    }
  }
}
```

and the following configuration in `.parcelrc`:

```json
{
  "namers": ["parcel-namer-rewrite"]
}
```

## Limitations

- Node.js conditions [cannot be
  configured](https://github.com/parcel-bundler/parcel/issues/9514) (without a
  custom resolver plugin), which means that it is not possible to disable
  specific Neuroglancer features.
