from pkg_resources import resource_string

main_js = resource_string(__name__, 'main.bundle.js')
chunk_worker_js = resource_string(__name__, 'chunk_worker.bundle.js')
styles_css = resource_string(__name__, 'styles.css')
index_html = resource_string(__name__, 'index.html')

content = {
    'main.bundle.js' : main_js,
    'chunk_worker.bundle.js' : chunk_worker_js,
    'styles.css' : styles_css,
    'index.html' : index_html,
}
