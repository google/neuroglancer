import neuroglancer

def test_visible():
    layer = neuroglancer.ManagedLayer('a', {'type': 'segmentation', 'visible': False})
    assert layer.name == 'a'
    assert layer.visible == False
    assert layer.to_json() == {'name': 'a', 'type': 'segmentation', 'visible': False}
    layer.visible = True
    assert layer.to_json() == {'name': 'a', 'type': 'segmentation'}
