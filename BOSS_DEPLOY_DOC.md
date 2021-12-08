# Instructions for Deploying to the Boss

### The main git branch is ndmaster 

# If Your First Time Deploying

Install Node.js >= v10.0.0

```shell
# Install dependencies
npm i
```
If you had used a different version of Node.js you may want to clear the installed modules before installing them.
```shell
#Clear and Install dependencies
npm ci
```

To test locally
```shell
# Update dependencies if necessary
npm i

npm run build
npm run dev-server
```
You will want to make sure your localhost:8081 or localhost:8080 is listed in the auth server, Clients, endpoint for both:
* Valid Redirect URIs
* Web Origins

This should already be the case for auth.theboss.io and auth.bossdb.io

# Deploying

```shell
# Update dependencies if necessary
npm i

# Compile to JS and minify
npm run build-min
```

In your browser, go to the S3 bucket where neuroglancer is hosted:

[neuroglancer.bossdb.org bucket](https://s3.console.aws.amazon.com/s3/buckets/aws-website-bossdbneuroglancer-6v7vl/?region=us-east-1&tab=overview)
[neuroglancer.theboss.io bucket](https://s3.console.aws.amazon.com/s3/buckets/aws-website-thebossneuroglancer-io2gl/?region=us-east-1&tab=overview)

Upload the files generated under neuroglancer/dist/min to the bucket making sure to make them public.

# Clearing Cache in Cloudfront
After uploading, you will want to go into cloudfront distributions, select the neuroglancer distribution
* Under the Invalidations tab you can create a new invalidation
* For **Object Paths** add *

This will clear the cached files in cloudfront and make them get new files.
  
Check the site to make sure everything is in order:
[neuroglancer.bossdb.org](https://neuroglancer.bossdb.org/)
[neuroglancer.theboss.io](https://neuroglancer.theboss.io/)
