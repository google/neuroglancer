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

#ifndef ZI_DETAIL_MEMBER_FUNCTION_HPP
#define ZI_DETAIL_MEMBER_FUNCTION_HPP 1

#include <zi/utility/enable_if.hpp>
#include <zi/bits/type_traits.hpp>
#include <zi/bits/ref.hpp>

namespace zi {
namespace detail {

template< class Type,
          class Return,
          Return (Type::*MemberFunctionPtr)()
          >
struct member_function
{
    typedef typename remove_reference< Return >::type result_type;

    template< class PtrToType >
    inline typename disable_if<
        is_convertible< PtrToType&, Type& >::type::value,
        Return
    >::type
    operator() ( const PtrToType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    inline Return operator() ( Type& v ) const
    {
        return (v.*MemberFunctionPtr)();
    }

    inline Return operator() ( const reference_wrapper< Type >& v_ref )
    {
        return this->operator() ( v_ref.get() );
    }

};

template< class Type,
          class Return,
          Return (Type::*MemberFunctionPtr)() const
          >
struct const_member_function
{
    typedef typename remove_reference< Return >::type result_type;

    template< class PtrToType >
    inline typename disable_if<
        is_convertible< const PtrToType&, const Type& >::type::value,
        Return
    >::type
    operator() ( const PtrToType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    inline Return operator() ( const Type& v ) const
    {
        return (v.*MemberFunctionPtr)();
    }

    inline Return operator() ( const reference_wrapper< Type >& v_ref ) const
    {
        return this->operator() ( v_ref.get() );
    }

    inline Return operator() ( const reference_wrapper< const Type >& v_ref ) const
    {
        return this->operator() ( v_ref.get() );
    }

};

} // namespace detail
} // namespace zi


#endif
