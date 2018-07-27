# Instructions for Deploying to the Boss

# If Your First Time Deploying

Install Node.js >= v5.9.0

```shell
# Install dependencies
npm i
```

# Deploying

```shell
# Update dependencies if necessary
npm i

# Compile to JS and minify
npm run build-min

# Create zip for uploading
zip --junk-paths deploy.zip dist/min/*
```

In your browser, go to this site:

https://console.aws.amazon.com/quickstart-website/website/aws-website-thebossneuroglancer-io2gl

Upload the zip file usig the Source code widget on the web page

Update the Confluence page with the date and commit that you just deployed:

https://confluence.rcs.jhuapl.edu/display/MICRONS/Neuroglancer+Docs
