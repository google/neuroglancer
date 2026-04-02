import argparse
import json
import pathlib
import webbrowser

import neuroglancer
import neuroglancer.cli


class Tool:
    def __init__(
        self,
        viewer: neuroglancer.Viewer,
        paths: list[pathlib.Path],
        num_to_prefetch: int,
    ) -> None:
        self.viewer = viewer
        self.paths = paths
        self.num_to_prefetch = num_to_prefetch

        key_bindings = [
            ["bracketleft", "prev-index"],
            ["bracketright", "next-index"],
            ["home", "first-index"],
            ["end", "last-index"],
            ["control+keys", "save"],
        ]
        self.viewer.actions.add("prev-index", self._prev_index)
        self.viewer.actions.add("next-index", self._next_index)
        self.viewer.actions.add("first-index", self._first_index)
        self.viewer.actions.add("last-index", self._last_index)
        self.viewer.actions.add("save", self.save)

        with self.viewer.config_state.txn() as s:
            for key, command in key_bindings:
                s.input_event_bindings.viewer[key] = command
                s.input_event_bindings.data_view[key] = command
            s.status_messages["help"] = "KEYS: " + " | ".join(
                f"{key}={command}" for key, command in key_bindings
            )

        self.index = -1
        self.set_index(0)

    def set_index(self, index: int) -> None:
        if index == self.index:
            return
        if index < 0:
            index += len(self.paths)
        elif index >= len(self.paths):
            index -= len(self.paths)
        if index < 0 or index >= len(self.paths):
            return
        self.save()
        self.index = index
        self.load()

    def _get_state(self, index: int) -> neuroglancer.ViewerState:
        content = self.paths[index].read_text(encoding="utf-8")
        try:
            state = neuroglancer.ViewerState(json.loads(content))
        except json.JSONDecodeError:
            state = neuroglancer.parse_url(content.strip())
        return state

    def save(self) -> None:
        if self.index == -1:
            return
        state = self.viewer.state
        path = self.paths[self.index]
        existing_content = path.read_text(encoding="utf-8")
        try:
            json.loads(existing_content)
            path.write_text(neuroglancer.to_json_dump(state))
        except json.JSONDecodeError:
            path.write_text(neuroglancer.to_url(state))

    def load(self) -> None:
        self.viewer.set_state(self._get_state(self.index))

        prefetch_states = []
        for i in range(self.num_to_prefetch):
            prefetch_index = self.index + i + 1
            if prefetch_index >= len(self.paths):
                break
            prefetch_states.append(self._get_state(prefetch_index))

        with self.viewer.config_state.txn() as s:
            s.prefetch = [
                neuroglancer.PrefetchState(state=prefetch_state, priority=-i)
                for i, prefetch_state in enumerate(prefetch_states)
            ]

        with self.viewer.config_state.txn() as s:
            s.status_messages["status"] = "[State %d/%d] %s" % (
                self.index,
                len(self.paths),
                self.paths[self.index],
            )

    def _first_index(self, s):
        self.set_index(0)

    def _last_index(self, s):
        self.set_index(-1)

    def _next_index(self, s):
        self.set_index(self.index + 1)

    def _prev_index(self, s):
        self.set_index(self.index - 1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    ap.add_argument(
        "path",
        nargs="*",
        type=pathlib.Path,
        help="Path to file containing URL or JSON state.",
    )
    ap.add_argument(
        "--prefetch", type=int, default=10, help="Number of states to prefetch"
    )
    ap.add_argument("--browser", action="store_true", help="Open in browser.")

    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()

    tool = Tool(
        viewer=viewer,
        paths=args.path,
        num_to_prefetch=args.prefetch,
    )
    print(tool.viewer)
    if args.browser:
        webbrowser.open(str(tool.viewer))
