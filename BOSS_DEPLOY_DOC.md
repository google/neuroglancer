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
```

In your browser, go to the S3 bucket where neuroglancer is hosted:

[neuroglancer.bossdb.org bucket](https://s3.console.aws.amazon.com/s3/buckets/aws-website-bossdbneuroglancer-6v7vl/?region=us-east-1&tab=overview)

Upload the files generated under neuroglancer/dist/min to the bucket making sure to make them public.

Check the site to make sure everything is in order:
[neuroglancer.bossdb.org](https://neuroglancer.bossdb.org/#!%7B%22layout%22:%224panel%22%7D)
