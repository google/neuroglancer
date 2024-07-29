project = "Neuroglancer"
copyright = "2021 The Neuroglancer Authors"
version = ""
release = ""

import typing
from typing import NamedTuple, Optional
import os
import re
import sys

import docutils.nodes
import sphinx.application
import sphinx.addnodes
import sphinx.domains.python
import sphinx.environment


os.environ["NEUROGLANCER_BUILDING_DOCS"] = "1"

extensions = [
    "sphinx.ext.extlinks",
    "sphinx.ext.autodoc",
    "sphinx.ext.intersphinx",
    "sphinx.ext.graphviz",
    "sphinx.ext.mathjax",
    "sphinx.ext.napoleon",
    "sphinx_immaterial",
    "sphinx_immaterial.apidoc.python.apigen",
    "sphinx_immaterial.apidoc.json.domain",
    "sphinx_immaterial.graphviz",
    "sphinx_immaterial.apidoc.format_signatures",
]

napoleon_numpy_docstring = False
napoleon_use_admonition_for_examples = True
napoleon_use_admonition_for_notes = True


html_title = "Neuroglancer"

# Don't include "View page source" links, since they aren't very helpful,
# especially for generated pages.
html_show_sourcelink = True
html_copy_source = False

# Skip unnecessary footer text.
html_show_sphinx = True
html_show_copyright = True

# Override default of `utf-8-sig` which can cause problems with autosummary due
# to the extra Unicode Byte Order Mark that gets inserted.
source_encoding = "utf-8"

source_suffix = ".rst"
master_doc = "index"
language = "en"

html_use_index = False

intersphinx_mapping = {
    "python": (
        "https://docs.python.org/3",
        ("intersphinx_inv/python3.inv", None),
    ),
    "numpy": (
        "https://numpy.org/doc/stable/",
        ("intersphinx_inv/numpy.inv", None),
    ),
    "tensorstore": (
        "https://google.github.io/tensorstore/",
        ("intersphinx_inv/tensorstore.inv", None),
    ),
    # "sphinx_docs": ("https://www.sphinx-doc.org/en/master", None),
}

html_theme = "sphinx_immaterial"

html_theme_options = {
    "icon": {
        "logo": "material/library",
        "repo": "fontawesome/brands/github",
    },
    "site_url": "https://google.github.io/neuroglancer/",
    "repo_url": "https://github.com/google/neuroglancer/",
    "edit_uri": "blob/master/docs",
    "features": [
        "navigation.expand",
        "navigation.tabs",
        # "toc.integrate",
        "navigation.sections",
        # "navigation.instant",
        # "header.autohide",
        "navigation.top",
        "toc.sticky",
        "toc.follow",
    ],
    "toc_title_is_page_title": True,
    "palette": [
        {
            "media": "(prefers-color-scheme: dark)",
            "scheme": "slate",
            "primary": "green",
            "accent": "light blue",
            "toggle": {
                "icon": "material/lightbulb",
                "name": "Switch to light mode",
            },
        },
        {
            "media": "(prefers-color-scheme: light)",
            "scheme": "default",
            "primary": "green",
            "accent": "light blue",
            "toggle": {
                "icon": "material/lightbulb-outline",
                "name": "Switch to dark mode",
            },
        },
    ],
}

default_role = "any"

# Warn about missing references
nitpicky = True

python_apigen_modules = {
    "neuroglancer.viewer_state": "python/api/",
    "neuroglancer.viewer_config_state": "python/api/",
    "neuroglancer.trackable_state": "python/api/",
    "neuroglancer.json_wrappers": "python/api/",
    "neuroglancer": "python/api/",
}

python_apigen_default_groups = [
    (r"class:neuroglancer\.viewer_state\..*", "viewer-state"),
    (r"(class|function):neuroglancer\.viewer_config_state\..*", "viewer-config-state"),
    (r"class:neuroglancer\.coordinate_space\..*", "coordinate-space"),
    (r"class:neuroglancer\.viewer_state\..*Tool", "viewer-state-tools"),
    (r"class:neuroglancer\.viewer_state\..*Layer", "viewer-state-layers"),
    (r"class:neuroglancer\.viewer\..*", "core"),
    (r"class:neuroglancer\.server\..*", "server"),
]

python_apigen_rst_prolog = """
.. default-role:: py:obj

.. default-literal-role:: python

.. highlight:: python

"""


json_schemas = ["json_schema/*.yml"]

rst_prolog = """
.. role:: python(code)
   :language: python
   :class: highlight

.. role:: json(code)
   :language: json
   :class: highlight

"""

json_schema_rst_prolog = """
.. default-role:: json:schema

.. default-literal-role:: json

.. highlight:: json
"""


graphviz_output_format = "svg"

extlinks = {
    "wikipedia": ("https://en.wikipedia.org/wiki/%s", None),
}


python_module_names_to_strip_from_xrefs = [
    "neuroglancer.viewer_state",
    "neuroglancer.trackable_state",
    "neuroglancer.viewer_config_state",
    "neuroglancer",
    "collections.abc",
    "numbers",
    "numpy.typing",
    "numpy",
]

object_description_options = [
    ("py:.*", dict(black_format_style={})),
]


# Monkey patch numpy.typing.NDArray
def _monkey_patch_numpy_typing_ndarray():
    import numpy.typing

    T = typing.TypeVar("T")

    class NDArray(typing.Generic[T]):
        pass

    NDArray.__module__ = "numpy.typing"

    numpy.typing.NDArray = NDArray


_monkey_patch_numpy_typing_ndarray()


# Monkey patch Sphinx to generate custom cross references for specific type
# annotations.
#
# The Sphinx Python domain generates a `py:class` cross reference for type
# annotations.  However, in some cases in the TensorStore documentation, type
# annotations are used to refer to targets that are not actual Python classes,
# such as `DownsampleMethod`, `DimSelectionLike`, or `NumpyIndexingSpec`.
# Additionally, some types like `numpy.typing.ArrayLike` are `py:data` objects
# and can't be referenced as `py:class`.
class TypeXrefTarget(NamedTuple):
    domain: str
    reftype: str
    target: str
    title: str


python_type_to_xref_mappings = {
    f"numpy.{name}": TypeXrefTarget("py", "obj", f"numpy.{name}", name)
    for name in [
        "int64",
        "uint64",
        "float32",
        "float64",
    ]
}

python_type_to_xref_mappings["numpy.typing.NDArray"] = TypeXrefTarget(
    "py", "obj", "numpy.typing.NDArray", "NDArray"
)

python_strip_property_prefix = True


_orig_python_type_to_xref = sphinx.domains.python.type_to_xref


def _python_type_to_xref(
    target: str,
    env: sphinx.environment.BuildEnvironment,
    *,
    suppress_prefix: bool = False,
) -> sphinx.addnodes.pending_xref:
    xref_info = python_type_to_xref_mappings.get(target)
    if xref_info is not None:
        return sphinx.addnodes.pending_xref(
            "",
            docutils.nodes.Text(xref_info.title),
            refdomain=xref_info.domain,
            reftype=xref_info.reftype,
            reftarget=xref_info.target,
            refspecific=False,
            refexplicit=True,
            refwarn=True,
        )
    return _orig_python_type_to_xref(target, env, suppress_prefix=suppress_prefix)


sphinx.domains.python.type_to_xref = _python_type_to_xref
sphinx.domains.python._annotations.type_to_xref = _python_type_to_xref


python_type_aliases = {
    "concurrent.futures._base.Future": "concurrent.futures.Future",
}


def _should_document_python_class_base(base: type) -> bool:
    if base.__name__.startswith("_"):
        return False
    if base.__module__ in ("neuroglancer.json_wrappers", "neuroglancer.viewer_base"):
        return False
    return True


PYTHON_MEMBER_SKIP_PATTERNS = re.compile(r"supports_(readonly|validation)")


def _autodoc_skip_member(
    app: sphinx.application.Sphinx,
    what: str,
    name: str,
    obj,
    skip: bool,
    options,
):
    if PYTHON_MEMBER_SKIP_PATTERNS.fullmatch(name) is not None:
        return True
    return None


def _python_apigen_skip_base(
    app: sphinx.application.Sphinx, subclass: type, base: type
):
    if base.__module__ == "collections.abc":
        return True
    return None


def setup(app: sphinx.application.Sphinx):
    # Ignore certain base classes.
    def _autodoc_process_bases(app, name, obj, options, bases):
        bases[:] = [base for base in bases if _should_document_python_class_base(base)]

    app.connect("autodoc-process-bases", _autodoc_process_bases)

    app.connect("autodoc-skip-member", _autodoc_skip_member)
    app.connect("python-apigen-skip-base", _python_apigen_skip_base)
