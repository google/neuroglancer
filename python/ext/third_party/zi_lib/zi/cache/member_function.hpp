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

#ifndef ZI_CACHE_MEMBER_FUNCTION_HPP
#define ZI_CACHE_MEMBER_FUNCTION_HPP 1

#include <zi/cache/config.hpp>
#include <zi/cache/detail/enable_if.hpp>
#include <zi/cache/detail/type_traits.hpp>
#include <zi/cache/detail/ref.hpp>

namespace zi {
namespace cache {

template< class CachedType,
          class Return,
          Return (CachedType::*MemberFunctionPtr)()
          >
struct member_function
{
    typedef typename remove_reference< Return >::type result_type;

    template< class PtrToCachedType >
    typename disable_if<
        is_convertible< PtrToCachedType&, CachedType& >::type::value,
        Return
    >::type
    operator() ( const PtrToCachedType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    Return operator() ( CachedType& v ) const
    {
        return (v.*MemberFunctionPtr)();
    }

    Return operator() ( const reference_wrapper< CachedType >& v_ref )
    {
        return this->operator() ( v_ref.get() );
    }

};

template< class CachedType,
          class Return,
          Return (CachedType::*MemberFunctionPtr)() const
          >
struct const_member_function
{
    typedef typename remove_reference< Return >::type result_type;

    template< class PtrToCachedType >
    typename disable_if<
        is_convertible< const PtrToCachedType&, const CachedType& >::type::value,
        Return
    >::type
    operator() ( const PtrToCachedType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    Return operator() ( const CachedType& v ) const
    {
        return (v.*MemberFunctionPtr)();
    }

    Return operator() ( const reference_wrapper< CachedType >& v_ref ) const
    {
        return this->operator() ( v_ref.get() );
    }

    Return operator() ( const reference_wrapper< const CachedType >& v_ref ) const
    {
        return this->operator() ( v_ref.get() );
    }

};



} // namespace cache
} // namespace zi


#endif
