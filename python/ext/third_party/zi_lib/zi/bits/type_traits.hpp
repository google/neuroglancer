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

#ifndef ZI_BITS_TYPE_TRAITS_HPP
#define ZI_BITS_TYPE_TRAITS_HPP 1

#include <zi/config/config.hpp>

#  if defined( ZI_USE_TR1 ) || defined( ZI_NO_BOOST )
#    include <tr1/type_traits>
#    define ZI_TYPE_TRAITS_NAMESPACE ::std::tr1
#  else
#    include <boost/type_traits.hpp>
#    define ZI_TYPE_TRAITS_NAMESPACE ::boost
#  endif

namespace zi {

using ZI_TYPE_TRAITS_NAMESPACE::integral_constant;
using ZI_TYPE_TRAITS_NAMESPACE::true_type;
using ZI_TYPE_TRAITS_NAMESPACE::false_type;
using ZI_TYPE_TRAITS_NAMESPACE::is_void;
using ZI_TYPE_TRAITS_NAMESPACE::is_integral;
using ZI_TYPE_TRAITS_NAMESPACE::is_floating_point;
using ZI_TYPE_TRAITS_NAMESPACE::is_array;
using ZI_TYPE_TRAITS_NAMESPACE::is_pointer;
using ZI_TYPE_TRAITS_NAMESPACE::is_reference;
using ZI_TYPE_TRAITS_NAMESPACE::is_member_object_pointer;
using ZI_TYPE_TRAITS_NAMESPACE::is_member_function_pointer;
using ZI_TYPE_TRAITS_NAMESPACE::is_enum;
using ZI_TYPE_TRAITS_NAMESPACE::is_union;
using ZI_TYPE_TRAITS_NAMESPACE::is_class;
using ZI_TYPE_TRAITS_NAMESPACE::is_function;
using ZI_TYPE_TRAITS_NAMESPACE::is_arithmetic;
using ZI_TYPE_TRAITS_NAMESPACE::is_fundamental;
using ZI_TYPE_TRAITS_NAMESPACE::is_object;
using ZI_TYPE_TRAITS_NAMESPACE::is_scalar;
using ZI_TYPE_TRAITS_NAMESPACE::is_compound;
using ZI_TYPE_TRAITS_NAMESPACE::is_member_pointer;
using ZI_TYPE_TRAITS_NAMESPACE::is_const;
using ZI_TYPE_TRAITS_NAMESPACE::is_volatile;
using ZI_TYPE_TRAITS_NAMESPACE::is_pod;
using ZI_TYPE_TRAITS_NAMESPACE::is_empty;
using ZI_TYPE_TRAITS_NAMESPACE::is_polymorphic;
using ZI_TYPE_TRAITS_NAMESPACE::is_abstract;
using ZI_TYPE_TRAITS_NAMESPACE::has_trivial_assign;
using ZI_TYPE_TRAITS_NAMESPACE::has_trivial_destructor;
using ZI_TYPE_TRAITS_NAMESPACE::has_nothrow_assign;
using ZI_TYPE_TRAITS_NAMESPACE::has_virtual_destructor;
using ZI_TYPE_TRAITS_NAMESPACE::is_signed;
using ZI_TYPE_TRAITS_NAMESPACE::is_unsigned;
using ZI_TYPE_TRAITS_NAMESPACE::alignment_of;
using ZI_TYPE_TRAITS_NAMESPACE::rank;
using ZI_TYPE_TRAITS_NAMESPACE::extent;
using ZI_TYPE_TRAITS_NAMESPACE::is_same;
using ZI_TYPE_TRAITS_NAMESPACE::is_base_of;
using ZI_TYPE_TRAITS_NAMESPACE::is_convertible;
using ZI_TYPE_TRAITS_NAMESPACE::remove_const;
using ZI_TYPE_TRAITS_NAMESPACE::remove_volatile;
using ZI_TYPE_TRAITS_NAMESPACE::remove_cv;
using ZI_TYPE_TRAITS_NAMESPACE::add_const;
using ZI_TYPE_TRAITS_NAMESPACE::add_volatile;
using ZI_TYPE_TRAITS_NAMESPACE::add_cv;
using ZI_TYPE_TRAITS_NAMESPACE::remove_reference;
using ZI_TYPE_TRAITS_NAMESPACE::remove_extent;
using ZI_TYPE_TRAITS_NAMESPACE::remove_all_extents;
using ZI_TYPE_TRAITS_NAMESPACE::remove_pointer;
using ZI_TYPE_TRAITS_NAMESPACE::add_pointer;
using ZI_TYPE_TRAITS_NAMESPACE::aligned_storage;

#ifdef __GXX_EXPERIMENTAL_CXX0X__

template< typename T >
struct has_trivial_constructor: boost::has_trivial_default_constructor< T > {};

template< typename T >
struct has_trivial_copy: boost::has_trivial_copy_constructor< T > {};

template< typename T >
struct has_nothrow_constructor: std::is_nothrow_default_constructible< T > {};

template< typename T >
struct has_nothrow_copy: std::is_nothrow_default_constructible< T > {};

template< typename T >
struct add_reference: std::add_lvalue_reference< T > {};

#else

using ZI_TYPE_TRAITS_NAMESPACE::has_trivial_constructor;
using ZI_TYPE_TRAITS_NAMESPACE::has_trivial_copy;
using ZI_TYPE_TRAITS_NAMESPACE::has_nothrow_constructor;
using ZI_TYPE_TRAITS_NAMESPACE::has_nothrow_copy;
using ZI_TYPE_TRAITS_NAMESPACE::add_reference;

#endif

} // namespace zi

#undef ZI_TYPE_TRAITS_NAMESPACE
#endif
