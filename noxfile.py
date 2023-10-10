import nox

nox.options.reuse_existing_virtualenvs = True
nox.options.error_on_external_run = True


@nox.session
def lint(session):
    session.install("-r", "python/requirements-lint.txt")
    session.run("ruff", "check", ".")


@nox.session
def format(session):
    session.install("-r", "python/requirements-lint.txt")
    session.run("ruff", "format", ".")


@nox.session
def mypy(session):
    session.install("-r", "python/requirements-mypy.txt")
    session.run("mypy", ".")
