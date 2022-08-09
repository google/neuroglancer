/* ipt.hpp - In-Place Transposition
 *
 * When transitioning between different media,
 * e.g. CPU to GPU, CPU to Network, CPU to disk,
 * it's often necessary to physically transpose
 * multi-dimensional arrays to reformat as C or
 * Fortran order. Tranposing matrices is also 
 * a common action in linear algebra, but often
 * you can get away with just changing the strides.
 *
 * An out-of-place transposition is easy to write,
 * often faster, but will spike peak memory consumption.
 *
 * This library grants the user the option of performing
 * an in-place transposition which trades CPU time for
 * peak memory usage.
 *
 * Author: William Silversmith
 * Date: Feb. 2019
 */

#ifndef IN_PLACE_TRANSPOSE_H
#define IN_PLACE_TRANSPOSE_H

#include <algorithm>
#include <cstdint>
#include <vector>

// ipt = in-place transpose
// call as:
// 2d: ipt::ipt<T>(arr, sx, sy);
// 3d: ipt::ipt<T>(arr, sx, sy, sz);
// 4d: ipt::ipt<T>(arr, sx, sy, sz, sw);

namespace ipt {

template <typename T>
void square_ipt(T* arr, const size_t sx, const size_t sy) {
  T tmp = 0;

  size_t k = 0;
  size_t next_k = 0;

  size_t base_k = 0; // just for going faster

  for (size_t y = 0; y < sy; y++) {
    base_k = sx * y;
    for (size_t x = y; x < sx; x++) {
      k = x + base_k;
      next_k = y + sy * x;

      tmp = arr[next_k];
      arr[next_k] = arr[k];
      arr[k] = tmp;
    }
  }
}

/* A permutation, P(k), is a mapping of
  * one arrangement of numbers to another.
  * For an m x n array, the permuatation
  * mapping from C to Fortran order is:
  *
  * P(k) := mk mod mn - 1
  * iP(k) := nk mod mn - 1 (the inverse)
  *
  * Where does this come from? Assume we are
  * going from C to Fortran order (it doesn't
  * matter either way). The indicies are defined
  * as:
  * 
  * k = C(x,y) = x + sx * y
  *     F(x,y) = y + sy * x
  *
  * The permutation P(k) is the transformation:
  * 
  * P(C(x,y)) = F(x,y)
  *
  * 1. P(x + sx * y) = y + sx * x
  * 2. sy (x + sx y) = sy x + sx sy y 
  * 3. Let q = (sx sy - 1)
  * 4. sy x + sx sy y % q
  * 5. ((sy x % q) + (sx sy y % q)) % q by distributive identity
  * 6. sy x is identical b/c q is always bigger
  * 7. sx sy y reduces to y 
  * 8 q is always bigger than sy x + y so it disappears
  * 
  * ==> P(k) = y + sy * x = F(x,y)
  * ==> P(k) = sy * k % (sx sy - 1)
  * 
  * Note that P(0) and P(q) are always 0 and q respectively.
  *
  * Now we need a way to implement this insight.
  * How can we move the data around without using too
  * much extra space? A simple algorithm is 
  * "follow-the-cycles". Each time you try moving a
  * k to P(k), it displaces the resident tile. Eventually,
  * this forms a cycle. When you reach the end of a cycle,
  * you can stop processing and move to unvisited parts of
  * the array. This requires storing a packed bit representation
  * of where we've visited to make sure we get everything.
  * This means we need to store between 2.0x and 1.016x
  * memory in the size of the original array depending on its
  * data type (2.0x would be a transpose of another bit packed 
  * array and 1.016x would be 64-bit data types).
  *
  * There are fancier algorithms that use divide-and-conquer,
  * and SIMD tricks, and near zero extra memory, but 
  * this is a good place to start. Fwiw, the bit vector
  * has an O(nm) time complexity (really 2nm) while the 
  * sans-bit vector algorithms are O(nm log nm).
  */
template <typename T>
void rect_ipt(T* arr, const size_t sx, const size_t sy) {
  const size_t sxy = sx * sy;

  std::vector<bool> visited;
  visited.resize(sxy);

  visited[0] = true;
  visited[sxy - 1] = true;

  const size_t q = sxy - 1;

  size_t k, next_k;
  T tmp1, tmp2;
  
  for (size_t i = 1; i < q; i++) {
    if (visited[i]) {
      continue;
    }

    k = i;
    tmp1 = arr[k];
    next_k = sy * k - q * (k / sx); // P(k)

    while (!visited[next_k]) {
      tmp2 = arr[next_k];
      arr[next_k] = tmp1;
      tmp1 = tmp2;
      visited[next_k] = true;
      k = next_k;
      next_k = sy * k - q * (k / sx); // P(k)
    }
  }
}

// note: sx == sy == sz... find better convention?
// still good for mutliple-dispatch.
template <typename T>
void square_ipt(
    T* arr, 
    const size_t sx, const size_t sy, const size_t sz
  ) {

  T tmp = 0;

  const size_t sxy = sx * sy;
  const size_t syz = sy * sz;

  size_t k = 0;
  size_t next_k = 0;
  size_t base_k = 0;
  for (size_t z = 0; z < sz; z++) {
    for (size_t y = 0; y < sy; y++) {
      base_k = sx * y + sxy * z;
      for (size_t x = z; x < sx; x++) {
        k = x + base_k;
        next_k = z + sz * y + syz * x;

        tmp = arr[next_k];
        arr[next_k] = arr[k];
        arr[k] = tmp;
      }
    }
  }
}

inline size_t P_3d(
    const size_t k, 
    const size_t sx, const size_t sy, const size_t sz
  ) {
  const size_t sxy = sx * sy;

  // k = x + sx y + sx sy z 

  size_t z = k / sxy;
  size_t y = (k - (z * sxy)) / sx;
  size_t x = k - sx * (y + z * sy);
  return z + sz * (y + sy * x);
}

template <typename T>
void rect_ipt(
    T* arr, 
    const size_t sx, const size_t sy, const size_t sz
  ) {
  const size_t sxy = sx * sy;
  const size_t N = sxy * sz;

  std::vector<bool> visited;
  visited.resize(N);

  visited[0] = true;
  visited[N - 1] = true;

  size_t k, next_k;
  T tmp1 = 0, tmp2 = 0;

  for (size_t i = 1; i < (N - 1); i++) {
    if (visited[i]) {
      continue;
    }

    k = i;
    tmp1 = arr[k];
    next_k = P_3d(k, sx, sy, sz);
    while (!visited[next_k]) {
      tmp2 = arr[next_k];
      arr[next_k] = tmp1;
      tmp1 = tmp2;
      visited[next_k] = true;
      k = next_k;
      next_k = P_3d(k, sx, sy, sz);
    }
  }
}

inline size_t P_4d(
    const size_t k, 
    const size_t sx, const size_t sy, const size_t sz, const size_t sw
  ) {
  const size_t sxy = sx * sy;
  const size_t sxyz = sxy * sz;

  // k = x + sx y + sx sy z + sx sy sz w

  size_t w = k / sxyz;
  size_t z = (k - w * sxyz) / sxy;
  size_t y = (k - (w * sxyz) - (z * sxy)) / sx;
  size_t x = k - (w * sxyz) - (z * sxy) - y * sx;

  return w + sw * (z + sz * (y + sy * x));
}

template <typename T>
void rect_ipt(
    T* arr, 
    const size_t sx, const size_t sy, const size_t sz, const size_t sw
  ) {

  const size_t N = sx * sy * sz * sw;

  std::vector<bool> visited;
  visited.resize(N);

  visited[0] = true;
  visited[N - 1] = true;

  size_t k, next_k;
  T tmp1 = 0, tmp2 = 0;

  for (size_t i = 1; i < (N - 1); i++) {
    if (visited[i]) {
      continue;
    }

    k = i;
    tmp1 = arr[k];
    next_k = P_4d(k, sx, sy, sz, sw);
    while (!visited[next_k]) {
      tmp2 = arr[next_k];
      arr[next_k] = tmp1;
      tmp1 = tmp2;
      visited[next_k] = true;
      k = next_k;
      next_k = P_4d(k, sx, sy, sz, sw);
    }
  }
}

template <typename T>
void ipt(T* arr, const size_t sx) {
  return;
}

template <typename T>
void ipt(T* arr, const size_t sx, const size_t sy) {
  if (sx * sy <= 1) {
    return;
  }

  if (sx == sy) {
    square_ipt(arr, sx, sy);
  }
  else {
    rect_ipt(arr, sx, sy);
  }
}

template <typename T>
void ipt(T* arr, const size_t sx, const size_t sy, const size_t sz) {
  if (sx * sy * sz <= 1) {
    return;
  }

  if (sx == sy && sy == sz) {
    square_ipt(arr, sx, sy, sz);
  }
  else {
    rect_ipt(arr, sx, sy, sz);
  }
}

template <typename T>
void ipt(
  T* arr, 
  const size_t sx, const size_t sy, 
  const size_t sz, const size_t sw
) {
  if (sx * sy * sz * sw <= 1) {
    return;
  }

  rect_ipt(arr, sx, sy, sz, sw);
}

};

#endif
