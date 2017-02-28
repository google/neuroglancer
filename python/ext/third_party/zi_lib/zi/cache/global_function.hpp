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

#ifndef ZI_CACHE_GLOBAL_FUNCTION_HPP
#define ZI_CACHE_GLOBAL_FUNCTION_HPP 1

#include <zi/cache/config.hpp>
#include <zi/cache/detail/if.hpp>
#include <zi/cache/detail/enable_if.hpp>
#include <zi/cache/detail/type_traits.hpp>
#include <zi/cache/detail/ref.hpp>

namespace zi {
namespace cache {

namespace global_function_ {

template< class CachedType,
          class Result,
          Result (*StaticFunctionPtr)( CachedType )
          >
struct non_ref
{
    typedef typename remove_reference< Result >::type result_type;

    template< class PtrToCachedType >
    typename disable_if<
        is_convertible<
            const PtrToCachedType&,
            const CachedType&
        >::type::value,
        Result
    >::type
    operator() ( const PtrToCachedType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    Result operator() ( const CachedType& v ) const
    {
        return StaticFunctionPtr( v );
    }

    Result operator() ( const reference_wrapper< const CachedType >& v_ref ) const
    {
        return this->operator() ( v_ref.get() );
    }

    Result operator() ( const reference_wrapper<
                            typename remove_const< CachedType >::type
                        >& v_ref, void* = 0 ) const
    {
        return this->operator() ( v_ref.get() );
    }

};

template< class CachedType,
          class Result,
          Result (*StaticFunctionPtr)( CachedType )
          >
struct non_const_ref
{
    typedef typename remove_reference< Result >::type result_type;

    template< class PtrToCachedType >
    typename disable_if<
        is_convertible<
            PtrToCachedType&,
            CachedType
        >::type::value,
        Result
    >::type
    operator() ( const PtrToCachedType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    Result operator() ( CachedType v ) const
    {
        return StaticFunctionPtr( v );
    }

    Result operator() ( const reference_wrapper<
                            typename remove_reference< CachedType >::type
                        >& v_ref) const
    {
        return this->operator() ( v_ref.get() );
    }

};


template< class CachedType,
          class Result,
          Result (*StaticFunctionPtr)( CachedType )
          >
struct const_ref
{
    typedef typename remove_reference< Result >::type result_type;

    template< class PtrToCachedType >
    typename disable_if<
        is_convertible<
            const PtrToCachedType&,
            CachedType
        >::type::value,
        Result
    >::type
    operator() ( const PtrToCachedType& ptr ) const
    {
        return this->operator() ( *ptr );
    }

    Result operator() ( CachedType v ) const
    {
        return StaticFunctionPtr( v );
    }

    Result operator() ( const reference_wrapper<
                            typename remove_reference< CachedType >::type
                        >& v_ref ) const
    {
        return this->operator() ( v_ref.get() );
    }

    Result operator() ( const reference_wrapper<
                            typename remove_const<
                                typename remove_reference< CachedType >::type
                            >::type
                        >& v_ref, void* = 0 ) const
    {
        return this->operator() ( v_ref.get() );
    }

};

} // namespace global_function_

template< class CachedType,
          class Result,
          Result (*StaticFunctionPtr)( CachedType )
          >
struct global_function:
    detail::if_<
        is_reference< CachedType >::value,
        typename detail::if_<
            is_const< typename remove_reference< CachedType >::type >::value,
            global_function_::const_ref< CachedType, Result, StaticFunctionPtr >,
            global_function_::non_const_ref< CachedType, Result, StaticFunctionPtr >
        >::type,
        global_function_::non_ref< CachedType, Result, StaticFunctionPtr >
    >::type
{
};

} // namespace cache
} // namespace zi


#endif
