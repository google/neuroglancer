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

#ifndef ZI_DETAIL_GLOBAL_FUNCTION_HPP
#define ZI_DETAIL_GLOBAL_FUNCTION_HPP 1

#include <zi/utility/static_if.hpp>
#include <zi/utility/enable_if.hpp>
#include <zi/bits/type_traits.hpp>
#include <zi/bits/ref.hpp>

namespace zi {
namespace detail {

namespace global_function_ {

template< class Type,
          class Result,
          Result (*StaticFunctionPtr)( Type )
          >
struct non_ref
{
    typedef typename remove_reference< Result >::type result_type;

    template< class PtrToType >
    inline
    typename disable_if<
        is_convertible<
            const PtrToType&,
            const Type&
        >::type::value,
        Result
    >::type
    operator() ( const PtrToType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    inline Result operator() ( const Type& v ) const
    {
        return StaticFunctionPtr( v );
    }

    inline Result operator() ( const reference_wrapper< const Type >& v_ref ) const
    {
        return this->operator() ( v_ref.get() );
    }

    inline Result operator() ( const reference_wrapper<
                            typename remove_const< Type >::type
                        >& v_ref, void* = 0 ) const
    {
        return this->operator() ( v_ref.get() );
    }

};

template< class Type,
          class Result,
          Result (*StaticFunctionPtr)( Type )
          >
struct non_const_ref
{
    typedef typename remove_reference< Result >::type result_type;

    template< class PtrToType >
    inline
    typename disable_if<
        is_convertible<
            PtrToType&,
            Type
        >::type::value,
        Result
    >::type
    operator() ( const PtrToType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    inline Result operator() ( Type v ) const
    {
        return StaticFunctionPtr( v );
    }

    inline Result operator() ( const reference_wrapper<
                            typename remove_reference< Type >::type
                        >& v_ref) const
    {
        return this->operator() ( v_ref.get() );
    }

};


template< class Type,
          class Result,
          Result (*StaticFunctionPtr)( Type )
          >
struct const_ref
{
    typedef typename remove_reference< Result >::type result_type;

    template< class PtrToType >
    inline
    typename disable_if<
        is_convertible<
            const PtrToType&,
            Type
        >::type::value,
        Result
    >::type
    operator() ( const PtrToType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    inline Result operator() ( Type v ) const
    {
        return StaticFunctionPtr( v );
    }

    inline Result operator() ( const reference_wrapper<
                            typename remove_reference< Type >::type
                        >& v_ref ) const
    {
        return this->operator() ( v_ref.get() );
    }

    inline Result operator() ( const reference_wrapper<
                            typename remove_const<
                                typename remove_reference< Type >::type
                            >::type
                        >& v_ref, void* = 0 ) const
    {
        return this->operator() ( v_ref.get() );
    }

};

} // namespace global_function_

template< class Type,
          class Result,
          Result (*StaticFunctionPtr)( Type )
          >
struct global_function:
    if_<
        is_reference< Type >::value,
        typename if_<
            is_const< typename remove_reference< Type >::type >::value,
            global_function_::const_ref< Type, Result, StaticFunctionPtr >,
            global_function_::non_const_ref< Type, Result, StaticFunctionPtr >
        >::type,
        global_function_::non_ref< Type, Result, StaticFunctionPtr >
    >::type
{
};

} // namespace detail
} // namespace zi


#endif
