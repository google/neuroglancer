#!/usr/bin/env python3
"""Generates the Neuroglancer logo in SVG format."""

import argparse

import numpy as np


def write_logo(path: str) -> None:

    letter_cells = np.array(
        [
            [1, 0, 0, 0, 0, 0, 0, 0, 1],
            [1, 1, 0, 0, 0, 0, 0, 0, 1],
            [1, 0, 1, 0, 0, 0, 0, 0, 1],
            [1, 0, 0, 1, 0, 0, 0, 0, 1],
            [1, 0, 0, 0, 1, 0, 0, 0, 1],
            [1, 0, 0, 0, 0, 1, 0, 0, 1],
            [1, 0, 0, 0, 0, 0, 1, 0, 1],
            [1, 0, 0, 0, 0, 0, 0, 1, 1],
            [1, 0, 0, 0, 0, 0, 0, 0, 1],
        ],
        dtype=bool,
    )

    g_cells = np.array(
        [
            [0, 0, 0, 1, 1, 1, 0, 0, 0],
            [0, 0, 1, 0, 0, 0, 1, 0, 0],
            [0, 1, 0, 0, 0, 0, 0, 0, 0],
            [1, 0, 0, 0, 0, 0, 0, 0, 0],
            [1, 0, 0, 0, 0, 1, 1, 1, 1],
            [1, 0, 0, 0, 0, 0, 0, 0, 1],
            [0, 1, 0, 0, 0, 0, 0, 1, 0],
            [0, 0, 1, 0, 0, 0, 1, 0, 0],
            [0, 0, 0, 1, 1, 1, 0, 0, 0],
        ],
        dtype=bool,
    )

    width_over_height = letter_cells.shape[1] / letter_cells.shape[0]

    margin = 2

    base_size = 128

    screen_size = np.array(
        [width_over_height * base_size + 2 * margin, base_size + 2 * margin]
    )

    full_screen_size = np.array(
        [width_over_height * base_size * 2 + 4 * margin, base_size * 2 + 4 * margin]
    )

    with open(path, "w") as f:
        f.write(
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            + f'viewBox="0 0 {full_screen_size[0]} {full_screen_size[1]}" '
            # + 'style="color: white; background-color: black;"'
            + ">"
        )

        grid_line_width = 1.5
        cell_margin = 1.5

        def draw_grid_letter(letter_cells, xoffset, yoffset):
            cell_size = base_size / letter_cells.shape[0]
            grid_line_color = fill_color = "currentColor"
            # grid_line_color = "#333"

            # Draw horizontal grid lines
            for i in range(letter_cells.shape[0] + 1):
                f.write(
                    f'<line stroke="{grid_line_color}" '
                    + f'stroke-width="{grid_line_width}" '
                    + f'x1="{xoffset+margin-grid_line_width/2}" '
                    + f'y1="{yoffset+round(margin+i*cell_size,1)}" '
                    + f'x2="{xoffset+round(margin+grid_line_width/2+cell_size*letter_cells.shape[1],1)}" '
                    + f'y2="{yoffset+round(margin+i*cell_size,1)}"/>'
                )

            # Draw vertical grid lines
            for i in range(letter_cells.shape[1] + 1):
                f.write(
                    f'<line stroke="{grid_line_color}" '
                    + f'stroke-width="{grid_line_width}" '
                    + f'y1="{yoffset+margin}" x1="{xoffset+round(margin+i*cell_size,1)}" '
                    + f'y2="{yoffset+round(margin+grid_line_width/2+cell_size*letter_cells.shape[0],1)}" '
                    + f'x2="{xoffset+round(margin+i*cell_size,1)}"/>'
                )

            for y in range(letter_cells.shape[0]):
                for x in range(letter_cells.shape[1]):
                    if not letter_cells[y, x]:
                        continue
                    f.write(
                        f'<rect fill="{fill_color}" '
                        + f'x="{xoffset+round(margin+x*cell_size+cell_margin,1)}" '
                        + f'y="{yoffset+round(margin+y*cell_size+cell_margin,1)}" '
                        + f'width="{round(cell_size-2*cell_margin,1)}" '
                        + f'height="{round(cell_size-2*cell_margin, 1)}"/>'
                    )

        draw_grid_letter(letter_cells, xoffset=0, yoffset=0)

        draw_grid_letter(
            g_cells, xoffset=full_screen_size[0] / 2, yoffset=full_screen_size[1] / 2
        )

        f.write("</svg>\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output")

    args = parser.parse_args()
    write_logo(args.output)


if __name__ == "__main__":
    main()
