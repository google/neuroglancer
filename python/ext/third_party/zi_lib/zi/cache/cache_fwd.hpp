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

#ifndef ZI_LIBS_CACHE_FWD_HPP
#define ZI_LIBS_CACHE_FWD_HPP 1

#include <zi/cache/config.hpp>

namespace zi {
namespace cache {

template<
    class CachedType,
    class KeyDefinition = identified_by<
        identity< CachedType >,
        std::less< identity< CachedType >::result_type >
        >,
    class CacheHandlers = handled_by,
    class CachePolicies
    >
struct cache;

} // namespace cache
} // namespace zi

#endif
