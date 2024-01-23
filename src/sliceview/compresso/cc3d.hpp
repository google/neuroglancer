/**
 * @license
 * Copyright 2021 William Silvermsith
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
 * that includes only the logic needed for CCL 4-connected
 * and 6-connected. It is also modified to treat black as 
 * foreground and black as background. 
 * 
 * cc3d is ordinarily licensed as GPL v3. 
 * Get the full version of cc3d here: 
 * 
 * https://github.com/seung-lab/connected-components-3d
 */

#ifndef CC3D_SPECIAL_4_HPP
#define CC3D_SPECIAL_4_HPP 

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>

namespace cc3d {

static size_t _dummy_N;

template <typename T>
class DisjointSet {
public:
  std::unique_ptr<T[]> ids;
  size_t length;

  DisjointSet () {
    length = 65536; // 2^16, some "reasonable" starting size
    ids = std::unique_ptr<T[]>(new T[length]());
  }

  DisjointSet (size_t len) {
    length = len;
    ids = std::unique_ptr<T[]>(new T[length]());
  }

  DisjointSet (const DisjointSet &cpy) {
    length = cpy.length;
    ids = std::unique_ptr<T[]>(new T[length]());

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

  // would be easy to write remove. 
  // Will be O(n).
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
    size_t &N = _dummy_N, OUT start_label = 1
  ) {

  OUT label;
  std::unique_ptr<OUT[]> renumber(new OUT[num_labels + 1]());
  OUT next_label = start_label;

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
  N = next_label - start_label;
  if (N < static_cast<size_t>(num_labels) || start_label != 1) {
    for (int64_t loc = 0; loc < voxels; loc++) {
      out_labels[loc] = renumber[out_labels[loc]];
    }
  }

  return out_labels;
}

template <typename OUT = uint32_t>
OUT* connected_components2d_4(
    bool* in_labels, 
    const int64_t sx, const int64_t sy, const int64_t sz,
    size_t max_labels, OUT *out_labels = NULL, 
    size_t &N = _dummy_N, OUT start_label = 1
  ) {

  const int64_t sxy = sx * sy;
  const int64_t voxels = sx * sy * sz;

  max_labels++;
  max_labels = std::min(max_labels, static_cast<size_t>(voxels) + 1); // + 1L for an array with no zeros
  max_labels = std::min(max_labels, static_cast<size_t>(std::numeric_limits<OUT>::max()));


  DisjointSet<uint32_t> equivalences(max_labels);

  if (out_labels == NULL) {
    out_labels = new OUT[voxels]();
  }
    
  /*
    Layout of forward pass mask. 
    A is the current location.
    D C 
    B A 
  */

  // const int64_t A = 0;
  const int64_t B = -1;
  const int64_t C = -sx;
  const int64_t D = -1-sx;

  int64_t loc = 0;
  OUT next_label = 0;

  // Raster Scan 1: Set temporary labels and 
  // record equivalences in a disjoint set.

  bool cur = 0;
  for (int64_t z = 0; z < sz; z++) {
    for (int64_t y = 0; y < sy; y++) {
      for (int64_t x = 0; x < sx; x++) {
        loc = x + sx * y + sxy * z;
        cur = in_labels[loc];

        if (cur) {
          continue;
        }

        if (x > 0 && !in_labels[loc + B]) {
          out_labels[loc] = out_labels[loc + B];
          if (y > 0 && in_labels[loc + D] && !in_labels[loc + C]) {
            equivalences.unify(out_labels[loc], out_labels[loc + C]);
          }
        }
        else if (y > 0 && !in_labels[loc + C]) {
          out_labels[loc] = out_labels[loc + C];
        }
        else {
          next_label++;
          out_labels[loc] = next_label;
          equivalences.add(out_labels[loc]);
        }
      }
    }
  }

  return relabel<OUT>(out_labels, voxels, next_label, equivalences, N, start_label);
}


template <typename OUT = uint32_t>
OUT* connected_components3d_6(
    bool* in_labels, 
    const int64_t sx, const int64_t sy, const int64_t sz,
    size_t max_labels, 
    OUT *out_labels = NULL, size_t &N = _dummy_N
  ) {

  const int64_t sxy = sx * sy;
  const int64_t voxels = sxy * sz;

  if (out_labels == NULL) {
    out_labels = new OUT[voxels]();
  }

  if (max_labels == 0) {
    return out_labels;
  }

  max_labels++; // corrects Cython estimation
  max_labels = std::min(max_labels, static_cast<size_t>(voxels) + 1); // + 1L for an array with no zeros
  max_labels = std::min(max_labels, static_cast<size_t>(std::numeric_limits<OUT>::max()));

  DisjointSet<OUT> equivalences(max_labels);

  /*
    Layout of forward pass mask (which faces backwards). 
    N is the current location.

    z = -1     z = 0
    A B C      J K L   y = -1 
    D E F      M N     y =  0
    G H I              y = +1
   -1 0 +1    -1 0   <-- x axis
  */

  // Z - 1
  const int64_t B = -sx - sxy;
  const int64_t E = -sxy;
  const int64_t D = -1 - sxy;

  // Current Z
  const int64_t K = -sx;
  const int64_t M = -1;
  const int64_t J = -1 - sx;
  // N = 0;

  int64_t loc = 0;
  OUT next_label = 0;

  // Raster Scan 1: Set temporary labels and 
  // record equivalences in a disjoint set.

  for (int64_t z = 0; z < sz; z++) {
    for (int64_t y = 0; y < sy; y++) {
      for (int64_t x = 0; x < sx; x++) {
        loc = x + sx * (y + sy * z);

        const bool cur = in_labels[loc];

        if (cur) {
          continue;
        }

        if (x > 0 && !in_labels[loc + M]) {
          out_labels[loc] = out_labels[loc + M];

          if (y > 0 && !in_labels[loc + K] && in_labels[loc + J]) {
            equivalences.unify(out_labels[loc], out_labels[loc + K]); 
            if (z > 0 && !in_labels[loc + E]) {
              if (in_labels[loc + D] && in_labels[loc + B]) {
                equivalences.unify(out_labels[loc], out_labels[loc + E]);
              }
            }
          }
          else if (z > 0 && !in_labels[loc + E] && in_labels[loc + D]) {
            equivalences.unify(out_labels[loc], out_labels[loc + E]); 
          }
        }
        else if (y > 0 && !in_labels[loc + K]) {
          out_labels[loc] = out_labels[loc + K];

          if (z > 0 && !in_labels[loc + E] && in_labels[loc + B]) {
            equivalences.unify(out_labels[loc], out_labels[loc + E]); 
          }
        }
        else if (z > 0 && !in_labels[loc + E]) {
          out_labels[loc] = out_labels[loc + E];
        }
        else {
          next_label++;
          out_labels[loc] = next_label;
          equivalences.add(out_labels[loc]);
        }
      }
    }
  }

  if (next_label <= 1) {
    N = next_label;
    return out_labels;
  }

  return relabel<OUT>(out_labels, voxels, next_label, equivalences, N, 1);
}

template <typename OUT = uint64_t>
std::unique_ptr<OUT[]> connected_components(
  bool* in_labels, 
  const int64_t sx, const int64_t sy, const int64_t sz,
  const size_t connectivity = 4, size_t &N = _dummy_N
) {

  const int64_t sxy = sx * sy;
  const int64_t voxels = sxy * sz;

  size_t max_labels = voxels;
  std::unique_ptr<OUT[]> out_labels(new OUT[voxels]());
  N = 0;

  if (connectivity == 4) {
    max_labels = static_cast<size_t>((sxy + 2) / 2);
  
    for (int64_t z = 0; z < sz; z++) {
      size_t tmp_N = 0;
      connected_components2d_4<OUT>(
        (in_labels + sxy * z), sx, sy, 1, 
        max_labels, (out_labels.get() + sxy * z), 
        tmp_N, N + 1
      );
      N += tmp_N;
    }
  }
  else if (connectivity == 6) {
    max_labels =  static_cast<size_t>(((sx + 1) * (sy + 1) * (sz + 1)) / 2);
    connected_components3d_6<OUT>(
      in_labels, sx, sy, sz, 
      max_labels, out_labels.get(), N
    );    
  }
  // removing these lines drops several kB from the WASM
  // and should be impossible to hit.
  // else {
  //   throw std::runtime_error("Only 4 and 6 connectivities are supported.");
  // }

  return out_labels;
}


}

#endif
