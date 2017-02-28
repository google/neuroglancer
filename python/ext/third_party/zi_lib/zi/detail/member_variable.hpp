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

#ifndef ZI_DETAIL_MEMBER_VARIABLE_HPP
#define ZI_DETAIL_MEMBER_VARIABLE_HPP 1

#include <zi/utility/static_if.hpp>
#include <zi/utility/enable_if.hpp>
#include <zi/bits/type_traits.hpp>
#include <zi/bits/ref.hpp>

namespace zi {
namespace detail {

namespace member_variable_ {

template< class Type,
          class Result,
          Result Type::*MemberVariablePtr
          >
struct non_const_member
{
    typedef Result result_type;

    template< class PtrToType >
    inline typename disable_if<
        is_convertible< const PtrToType&, const Type& >::type::value, Result&
    >::type
    operator() ( const PtrToType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    inline Result& operator() ( Type& v ) const
    {
        return v.*MemberVariablePtr;
    }
};

template< class Type,
          class Result,
          Result Type::*MemberVariablePtr
          >
struct const_member
{
    typedef Result result_type;

    template< class PtrToType >
    inline typename disable_if<
        is_convertible< const PtrToType&, const Type& >::type::value, Result&
    >::type
    operator() ( const PtrToType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    inline Result& operator() ( const Type& v ) const
    {
        return v.*MemberVariablePtr;
    }

    inline Result& operator() ( const reference_wrapper< const Type >& v_ref ) const
    {
        return this->operator() ( v_ref.get() );
    }

    inline Result& operator() ( const reference_wrapper< Type >& v_ref, void* = 0 ) const
    {
        return this->operator() ( v_ref.get() );
    }

};

} // namespace member_variable_

template< class Type,
          class Result,
          Result Type::*MemberVariablePtr
          >
struct member_variable:
    if_<
        is_const< Result >::value,
        member_variable_::const_member    < Type, Result, MemberVariablePtr >,
        member_variable_::non_const_member< Type, Result, MemberVariablePtr >
    >::type
{
};

} // namespace detail
} // namespace zi


#endif
