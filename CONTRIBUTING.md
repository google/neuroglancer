Want to contribute? Great! First, read this page (including the small print at the end).

### Before you contribute

Before we can use your code, you must sign the
[Google Individual Contributor License Agreement](https://cla.developers.google.com/about/google-individual)
(CLA), which you can do online. The CLA is necessary mainly because you own the
copyright to your changes, even after your contribution becomes part of our
codebase, so we need your permission to use and distribute your code. We also
need to be sure of various other things—for instance that you'll tell us if you
know that your code infringes on other people's patents. You don't have to sign
the CLA until after you've submitted your code for review and a member has
approved it, but you must do it before we can put your code into our codebase.
Before you start working on a larger contribution, you should get in touch with
us first through the issue tracker with your idea so that we can help out and
possibly guide you. Coordinating up front makes it much easier to avoid
frustration later on.

### Code reviews

All submissions, including submissions by project members, require review.

### Coding Style

For consistency, please ensure that all TypeScript/JavaScript files
are linted with `eslint` and formatted by `prettier`.

You can check for lint/format issues with:

```shell
npm run lint:check
npm run format:check
```

To reformat run:

```shell
npm run format:fix
```

To automatically apply safe lint fixes, run:

```shell
npm run lint:fix
```

Python code is linted and formatted using
[ruff](https://github.com/astral-sh/ruff) and typechecked using
[mypy](https://mypy-lang.org/). To verify, run:

```shell
pip install nox
nox -s lint format mypy
```

### The small print

Contributions made by corporations are covered by a different agreement than
the one above, the
[Software Grant and Corporate Contributor License Agreement](https://cla.developers.google.com/about/google-corporate).
