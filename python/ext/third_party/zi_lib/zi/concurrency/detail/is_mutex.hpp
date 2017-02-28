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

#ifndef ZI_CONCURRENCY_DETAIL_IS_MUTEX_HPP
#define ZI_CONCURRENCY_DETAIL_IS_MUTEX_HPP 1

#include <zi/bits/type_traits.hpp>

namespace zi {
namespace concurrency_ {
namespace detail {

#define ZI_DEFINE_HAS_MEMBER_XXX( member_name )                         \
                                                                        \
    template< class T, bool = is_class< T >::value >                    \
    struct has_member_##member_name: false_type                         \
    { };                                                                \
                                                                        \
    template< class T >                                                 \
    struct has_member_##member_name< T, true >                          \
    {                                                                   \
        struct base { int member_name; };                               \
        struct derrived: T, base { derrived(); };                       \
                                                                        \
        template< int base::* > struct test_struct;                     \
                                                                        \
        template< class Y >                                             \
            static int  test( test_struct< &Y:: member_name >* );       \
        template< class Y >                                             \
            static char test( ... );                                    \
                                                                        \
        static const bool value = sizeof( test< derrived >(0) ) == 1;   \
    };                                                                  \
                                                                        \
    template< class T, bool = has_member_##member_name< T >::value >    \
    struct has_member_fn_##member_name: false_type                      \
    { };                                                                \
                                                                        \
    template< class T >                                                 \
    struct has_member_fn_##member_name< T, true >                       \
    {                                                                   \
        template< class Y > static char test( void ( Y::* )() const );  \
        template< class Y > static int  test( Y );                      \
                                                                        \
        static const bool value =                                       \
            sizeof( has_member_fn_##member_name< T >::test              \
                    ( &T:: member_name ) ) == 1;                        \
    }



ZI_DEFINE_HAS_MEMBER_XXX( lock   );
ZI_DEFINE_HAS_MEMBER_XXX( unlock );
ZI_DEFINE_HAS_MEMBER_XXX( acquire_read  );
ZI_DEFINE_HAS_MEMBER_XXX( release_read  );
ZI_DEFINE_HAS_MEMBER_XXX( acquire_write );
ZI_DEFINE_HAS_MEMBER_XXX( release_write );

template< class T >
struct is_mutex
{
    static const bool value =
        has_member_fn_lock< T >::value &&
        has_member_fn_unlock< T >::value;
};

template< class T >
struct is_rwmutex
{
    static const bool value =
        has_member_fn_acquire_read< T >::value &&
        has_member_fn_release_read< T >::value &&
        has_member_fn_acquire_write< T >::value &&
        has_member_fn_release_write< T >::value;
};

} // namespace detail

using detail::is_mutex;
using detail::is_rwmutex;

} // namespace concurrency_
} // namespace zi

#endif

