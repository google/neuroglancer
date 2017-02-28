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

#ifndef ZI_BITS_HASH_HPP
#define ZI_BITS_HASH_HPP 1

#include <zi/config/config.hpp>

#ifdef __GXX_EXPERIMENTAL_CXX0X__
#  include <functional>
#  define ZI_HASH_NAMESPACE ::std
#  define ZI_HASH_EXPORT_NAMESPACE_BEGIN namespace std {
#  define ZI_HASH_EXPORT_NAMESPACE_END }
#else
#  if defined( ZI_USE_TR1 ) || defined( ZI_NO_BOOST )
#    include <tr1/utility>
#    include <tr1/functional>
#    define ZI_HASH_NAMESPACE ::std::tr1
#    define ZI_HASH_EXPORT_NAMESPACE_BEGIN namespace std { namespace tr1 {
#    define ZI_HASH_EXPORT_NAMESPACE_END } }
#  else
#    include <boost/functional/hash.hpp>
#    define ZI_HASH_NAMESPACE ::boost
#    define ZI_HASH_EXPORT_NAMESPACE_BEGIN namespace boost {
#    define ZI_HASH_EXPORT_NAMESPACE_END }
#  endif
#endif

namespace zi {

using ZI_HASH_NAMESPACE::hash;

} // namespace zi

#undef ZI_HASH_NAMESPACE
#endif
