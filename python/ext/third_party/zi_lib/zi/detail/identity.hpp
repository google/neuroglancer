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

#ifndef ZI_DETAIL_IDENTITY_HPP
#define ZI_DETAIL_IDENTITY_HPP 1

#include <zi/utility/static_if.hpp>
#include <zi/utility/enable_if.hpp>
#include <zi/bits/type_traits.hpp>
#include <zi/bits/ref.hpp>

namespace zi {
namespace detail {

namespace identity_ {

template< class Type >
struct non_const_identity
{
    typedef Type result_type;

    template< class PtrToType >
    typename disable_if<
        is_convertible< const PtrToType&, const Type& >::type::value, Type&
    >::type
    operator() ( const PtrToType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    Type& operator() ( Type& v ) const
    {
        return v;
    }

    const Type& operator() ( const Type& v, void* = 0 ) const
    {
        return v;
    }

    Type& operator() ( const reference_wrapper< Type >& v_ref )
    {
        return v_ref.get();
    }

    const Type& operator() ( const reference_wrapper< const Type >& v_ref )
    {
        return v_ref.get();
    }

};

template< class Type >
struct const_identity
{
    typedef Type result_type;

    template< class PtrToType >
    typename disable_if<
        is_convertible< const PtrToType&, const Type& >::type::value, Type&
    >::type
    operator() ( const PtrToType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    Type& operator() ( Type& v ) const
    {
        return v;
    }

    Type& operator() ( const reference_wrapper< Type >& v_ref ) const
    {
        return v_ref.get();
    }

    Type& operator() ( const reference_wrapper<
                           typename remove_const< Type >::type
                       >& v_ref, void* = 0 ) const
    {
        return v_ref.get();
    }

};

} // namespace identity_

template< class Type >
struct identity:
    if_<
        is_const< Type >::value,
        identity_::const_identity    < Type >,
        identity_::non_const_identity< Type >
    >::type
{
};

} // namespace detail
} // namespace zi


#endif
