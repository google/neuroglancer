from collections.abc import Sequence
import os
import json


class AnnotationReader:
    def __init__(self, path):
        self.path = path
        self.annotations = []

        # read the info file
        self.metadata = self.read_info()

        self.type = self.metadata["annotation_type"]

    def read_info(self):
        with open(os.path.join(self.path, "info"), "r") as f:
            metadata = json.load(f)
        return metadata

    def _decode_annotations(self, annotations):
        """
        This function decodes the binary string of annotations into a list of annotation objects.

        Parameters:
            annotations (bytes): Binary string of annotations.

        Returns:
            list: List of annotation objects. Each object has 'id' and 'encoded' attributes.
        """
        num_annotations = struct.unpack("<Q", annotations[:8])[0]
        annotations = annotations[8:]
        decoded_annotations = []
        properties = self.metadata["properties"]

        for _ in range(num_annotations):
            coords = struct.unpack("<3d", annotations[:24])

            for i, p in enumerate(properties):
                dtype = _PROPERTY_DTYPES[p["type"]][0]
                size = _PROPERTY_DTYPES[p["type"]][1]

                annotation.encoded[()][f"property{i}"] = np.frombuffer(
                    annotation.encoded[()][f"property{i}"], dtype=dtype
                ).reshape(size)

            annotations = annotations[8:]
            decoded_annotations.append(annotation)
        return decoded_annotations

    def read_annotations(self, ids):
        """
        This function reads annotations by ids.

        Parameters:
            ids (list): List of annotation ids.

        Returns:
            list: List of annotation objects.
        """
        raise NotImplementedError

    def read_annotations_spatial(self, min_pt: Sequence[int], max_pt: Sequence[int]):
        """
        This function reads annotations by spatial range.

        Parameters:
            min_pt (list): Minimum point of the spatial range.
            max_pt (list): Maximum point of the spatial range.

        Returns:
            list: List of annotation objects.
        """
        raise NotImplementedError

    def read_annotations_by_relationship(
        self, relationship: str, related_ids: Sequence[int]
    ):
        """
        This function reads annotations by relationship and related ids.

        Parameters:
            relationship (str): Relationship type.
            related_ids (list): List of related ids.

        Returns:
            list: List of annotation objects.
        """
        raise NotImplementedError
