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

#ifndef ZI_CONCURRENCY_DETAIL_IS_RUNNABLE_HPP
#define ZI_CONCURRENCY_DETAIL_IS_RUNNABLE_HPP 1

#include <zi/bits/type_traits.hpp>

namespace zi {
namespace concurrency_ {
namespace detail {


template< class Maybe, bool = is_class< Maybe >::value >
struct has_member_run
{
    static const bool value = false;
};

template< class Maybe >
struct has_member_run< Maybe, true >
{
    struct base
    {
        int run;
    };

    struct derrived: Maybe, base
    {
        derrived();
    };

    template< int base::* > struct test_struct;

    template< class T > static int  test( test_struct< &T::run >* );
    template< class T > static char test( ... );

    static const bool value = sizeof( test< derrived >(0) ) == 1;
};

template< class Maybe, bool = has_member_run< Maybe >::value >
struct has_runnable_run_method
{
    static const bool value = false;
};

template< class Maybe >
struct has_runnable_run_method< Maybe, true >
{
    template< class T >
    static char test( void ( T::* )() const ); // note: member function

    template< class T >
    static char test( void ( T::* )() );       // note: member function

    template< class T >
    static int  test( T );                     // note: member type

    static const bool value =
        sizeof( is_lockable< Maybe >::test( &Maybe::lock ) ) == 1;
};


} // namespace detail
} // namespace concurrency_
} // namespace zi

#endif

