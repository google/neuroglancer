/**
 * @license
 * Copyright 2026 William Silvermsith
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * Connected Components for 2D images. 

 * Author: William Silversmith
 * Affiliation: Seung Lab, Princeton University
 * Date: August 2018 - June 2019, June 2021
 *
 * ----
 * Notes on the license:
 * 
 * This is a special reduced feature version of cc3d 
 * that includes only the logic needed for CCL 4-connected.
 * 
 * cc3d is ordinarily licensed as LGPL v3.
 * Get the full version of cc3d here: 
 * 
 * https://github.com/seung-lab/connected-components-3d
 */

#ifndef __CC3D_CRACKLE_SPECIAL_2_4_HPP__
#define __CC3D_CRACKLE_SPECIAL_2_4_HPP__

#include <cstdint>
#include <span>
#include <vector>

namespace crackle {
namespace cc3d {

static uint64_t _dummy_N;

template <typename T>
class DisjointSet {
public:
  std::vector<T> ids;
  uint64_t length;

  DisjointSet (uint64_t len) {
    length = len;
    ids.resize(len, 0);
  }

  DisjointSet (const DisjointSet &cpy) {
    length = cpy.length;
    ids.resize(length, 0);

    for (int i = 0; i < length; i++) {
      ids[i] = cpy.ids[i];
    }
  }

  T root (T n) {
    T i = ids[n];
    while (i != ids[i]) {
      ids[i] = ids[ids[i]]; // path compression
      i = ids[i];
    }

    return i;
  }

  bool find (T p, T q) {
    return root(p) == root(q);
  }

  void add(T p) {
    if (p >= length) {
      length *= 2;
      ids.resize(length, 0);
    }

    if (ids[p] == 0) {
      ids[p] = p;
    }
  }

  void unify (T p, T q) {
    if (p == q) {
      return;
    }

    T i = root(p);
    T j = root(q);

    if (i == 0) {
      add(p);
      i = p;
    }

    if (j == 0) {
      add(q);
      j = q;
    }

    ids[i] = j;
  }
};

// This is the second raster pass of the two pass algorithm family.
// The input array (output_labels) has been assigned provisional 
// labels and this resolves them into their final labels. We
// modify this pass to also ensure that the output labels are
// numbered from 1 sequentially.
template <typename OUT = uint32_t>
OUT* relabel(
    OUT* out_labels, const int64_t voxels,
    const int64_t num_labels, DisjointSet<uint32_t> &equivalences,
    uint64_t &N = _dummy_N, uint64_t start_label = 0
  ) {

  OUT label;
  std::unique_ptr<OUT[]> renumber(new OUT[num_labels + 1]());
  OUT next_label = start_label + 1;

  for (int64_t i = 1; i <= num_labels; i++) {
    label = equivalences.root(i);
    if (renumber[label] == 0) {
      renumber[label] = next_label;
      renumber[i] = next_label;
      next_label++;
    }
    else {
      renumber[i] = renumber[label];
    }
  }

  // Raster Scan 2: Write final labels based on equivalences
  N = next_label - start_label - 1;
  for (int64_t loc = 0; loc < voxels; loc++) {
    out_labels[loc] = renumber[out_labels[loc]] - 1; // first label is 0 not 1
  }

  return out_labels;
}

template <typename OUT>
OUT* color_connectivity_graph(
  const std::span<const uint8_t> &vcg, // voxel connectivity graph
  const int64_t sx, const int64_t sy, const int64_t sz,
  OUT* out_labels = NULL,
  uint64_t &N = _dummy_N
) {

  const int64_t sxy = sx * sy;
  const int64_t voxels = sx * sy * sz;

  uint64_t max_labels = (voxels / 8) + 1;
  max_labels = std::min(max_labels, static_cast<uint64_t>(std::numeric_limits<OUT>::max()));

  if (out_labels == NULL) {
    out_labels = new OUT[voxels]();
  }

  if (voxels == 0) {
    return out_labels;
  }

  DisjointSet<OUT> equivalences(max_labels);

  OUT new_label = 0;
  for (int64_t z = 0; z < sz; z++) {
    new_label++;
    equivalences.add(new_label);

    for (int64_t x = 0; x < sx; x++) {
      if (x > 0 && (vcg[x + sxy * z] & 0b0010) == 0) {
        new_label++;
        equivalences.add(new_label);
      }
      out_labels[x + sxy * z] = new_label;
    }

    const int64_t B = -1;
    const int64_t C = -sx;

    for (int64_t y = 1; y < sy; y++) {
      int64_t loc = sx * y + sxy * z;
      int64_t x = 0;

      if (vcg[loc] & 0b1000) {
        out_labels[loc] = out_labels[loc+C];
        goto SIMPLE;
      }
      else {
        new_label++;
        out_labels[loc] = new_label;
        equivalences.add(new_label);
        goto COMPLEX;
      }

      COMPLEX:
        x++;
        loc++;
        if (x >= sx) {
          continue;
        }

        if (vcg[loc] & 0b0010) {
          out_labels[loc] = out_labels[loc+B];

          // simplified from:
          // if ((vcg[loc] & 0b1000) && (vcg[loc + B] & 0b1000) == 0) {
          if ((vcg[loc] & 0b1000) & ~vcg[loc + B]) {
            equivalences.unify(out_labels[loc], out_labels[loc+C]);
            goto SIMPLE;
          }
          goto COMPLEX;
        }
        else if (vcg[loc] & 0b1000) {
          out_labels[loc] = out_labels[loc+C];
          goto SIMPLE;
        }
        else {
          new_label++;
          out_labels[loc] = new_label;
          equivalences.add(new_label);
          goto COMPLEX;
        }

      SIMPLE:
        x++;
        loc++;
        if (x >= sx) {
          continue;
        }

        if (vcg[loc] & 0b1000) {
          out_labels[loc] = out_labels[loc+C];
          goto SIMPLE;
        }
        else if (vcg[loc] & 0b0010) {
          out_labels[loc] = out_labels[loc+B];
          goto COMPLEX;
        }
        else {
          new_label++;
          out_labels[loc] = new_label;
          equivalences.add(new_label);
          goto COMPLEX;
        }   
    }
  }

  relabel<OUT>(out_labels, voxels, new_label, equivalences, N);
  return out_labels;
}

};
};

#endif
