//
// Copyright (C) 2010  Aleksandar Zlateski <zlateski@mit.edu>
// ----------------------------------------------------------
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

#ifndef ZI_PARALLEL_ALGORITHM_HPP
#define ZI_PARALLEL_ALGORITHM_HPP 1

#ifdef ZI_USE_OPENMP
#  include <parallel/algorithm>
#  define ZI_PARALLEL_ALGORITHM_NAMESPACE __gnu_parallel
#else
#  include <algorithm>
#  define ZI_PARALLEL_ALGORITHM_NAMESPACE std
#endif

namespace zi {

using ZI_PARALLEL_ALGORITHM_NAMESPACE::count;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::count_if;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::equal;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::find;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::find_if;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::find_first_of;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::for_each;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::generate;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::generate_n;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::lexicographical_compare;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::mismatch;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::search;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::search_n;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::transform;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::replace;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::replace_if;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::max_element;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::merge;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::min_element;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::max_element;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::partial_sort;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::partition;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::random_shuffle;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::set_union;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::set_intersection;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::set_symmetric_difference;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::set_difference;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::sort;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::stable_sort;
using ZI_PARALLEL_ALGORITHM_NAMESPACE::unique_copy;

} // namespace zi

#undef ZI_PARALLEL_ALGORITHM_NAMESPACE

#endif

